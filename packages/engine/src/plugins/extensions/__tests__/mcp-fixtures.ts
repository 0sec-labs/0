import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpSnapshotStore, McpGate, McpConnector, McpLaunch, McpPinStore, McpObservationLog, McpObservation } from "../mcp/ports.js";
import { ExtensionMcpHost } from "../mcp/host.js";
import { SdkMcpConnector } from "../mcp/adapters/http.js";
import { StdioMcpConnector } from "../mcp/adapters/stdio.js";
import { capabilitiesOf } from "../core/capabilities.js";
import { extensionEnv } from "../core/env.js";
import { parseManifest } from "../core/manifest.js";
import type { FolderFile } from "../core/files.js";
import type { LoadedExtension } from "../runtime.js";
import type { McpToolHost } from "../../../agent/mcp-host.js";
import type { ToolSnapshots } from "../mcp/core/snapshot.js";
import type { McpToolInfo } from "../mcp/core/tool-hash.js";
// @ts-expect-error plain JS fixture shared by the stdio script and the in-process HTTP server
import { buildServer } from "./fixtures/fake-mcp-server.mjs";

export const FAKE_STDIO = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

export const folder = (files: Record<string, unknown>): FolderFile[] => Object.entries(files).map(([path, v]) => { const bytes = Buffer.from(typeof v === "string" ? v : JSON.stringify(v)); return { path, size: bytes.length, executable: false, bytes }; });

/** An extension as `loadable()` would hand it over, built from manifest files. */
export function loaded(name: string, files: Record<string, unknown>, dir = "/nonexistent"): LoadedExtension {
  const manifest = parseManifest(folder({ "extension.json": { name, version: "1.0.0", description: `The ${name} extension.` }, ...files }), { fallbackName: name });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const capabilities = capabilitiesOf(manifest.value);
  return { name, revision: "local-0123456789abcdef", dir, manifest: manifest.value, capabilities, approvedEnv: capabilities.env, connected: (parent = process.env) => parent, unapprovedEnv: [], env: (parent = process.env) => extensionEnv({ declared: capabilities.env, approved: capabilities.env, parent }) };
}

export const stdioExtension = (name: string, variantArg: string, env: string[] = [], dir = process.cwd()): LoadedExtension =>
  loaded(name, { ".mcp.json": { mcpServers: { fake: { command: process.execPath, args: [FAKE_STDIO, variantArg], env: Object.fromEntries(env.map(n => [n, "x"])), description: "A fake server for tests" } } } }, dir);

export const httpExtension = (name: string, url: string): LoadedExtension => loaded(name, { "extension.json": { name, version: "1.0.0", description: `The ${name} extension.`, "0": { mcp: { fake: { url, type: "http" } } } } });

export class MemoryPins implements McpPinStore {
  readonly #map = new Map<string, { approvedAt: string; tools: Record<string, string> }>();
  pins(extension: string, revision: string) { return Object.fromEntries([...this.#map].filter(([k]) => k.startsWith(`${extension}\0${revision}\0`)).map(([k, v]) => [k.split("\0")[2]!, v])); }
  approve(extension: string, revision: string, server: string, tools: Record<string, string>) { this.#map.set(`${extension}\0${revision}\0${server}`, { approvedAt: "now", tools }); return { ok: true as const, value: undefined }; }
}
export class MemoryObserved implements McpObservationLog {
  readonly #map = new Map<string, McpObservation>();
  record(e: string, r: string, s: string, o: McpObservation) { this.#map.set(`${e}\0${r}\0${s}`, o); }
  read(e: string, r: string) { return Object.fromEntries([...this.#map].filter(([k]) => k.startsWith(`${e}\0${r}\0`)).map(([k, v]) => [k.split("\0")[2]!, v])); }
}

export const allow: McpGate = async () => ({ decision: "allow", reason: "" });

/** Counts launches, so a test can prove nothing started. */
export class SpyConnector implements McpConnector {
  readonly launches: McpLaunch[] = [];
  readonly #inner = new SdkMcpConnector(new StdioMcpConnector());
  connect(launch: McpLaunch) { this.launches.push(launch); return this.#inner.connect(launch); }
}

export function makeHost(extensions: LoadedExtension[], options: { connector?: McpConnector; base?: McpToolHost; gate?: McpGate; pins?: McpPinStore; snapshots?: McpSnapshotStore; observed?: McpObservationLog; parentEnv?: Record<string, string | undefined>; approve?: (r: { name: string; summary: string }) => Promise<boolean> | boolean } = {}) {
  const connector = (options.connector ?? new SpyConnector()) as SpyConnector; const pins = options.pins ?? new MemoryPins(); const observed = options.observed ?? new MemoryObserved();
  const host = new ExtensionMcpHost({ extensions, connector, pins, observed, gate: options.gate ?? allow, ...(options.base ? { base: options.base } : {}), ...(options.snapshots ? { snapshots: options.snapshots } : {}), parentEnv: options.parentEnv ?? { PATH: process.env["PATH"] } });
  const asked: Array<{ name: string; summary: string }> = [];
  const approve = options.approve; host.attachOperator({ cwd: process.cwd(), thread: () => ({}), ...(approve ? { approve: async r => { asked.push(r); return approve(r); } } : {}) });
  return { host, connector, pins, observed, asked, snapshots: options.snapshots };
}

export async function startFakeHttp(variant: () => string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const mcp = buildServer(variant()); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** The text between the nonce fence of a labelled result. */
export const unfence = (labelled: string): string => /<<<UNTRUSTED_MCP_OUTPUT:([0-9a-f]{32})\n([\s\S]*)\nUNTRUSTED_MCP_OUTPUT:\1>>>/.exec(labelled)![2]!;

/** An in-memory server: the tools it lists are whatever the test puts in `tools`. */
export class FakeConnector implements McpConnector {
  readonly launches: McpLaunch[] = [];
  constructor(public tools: McpToolInfo[]) {}
  async connect(launch: McpLaunch) {
    this.launches.push(launch);
    return { tools: async () => this.tools, call: async () => ({ text: "ok", isError: false }), close: async () => undefined, onToolsChanged: () => undefined, onClosed: () => undefined };
  }
}
export class MemorySnapshots implements McpSnapshotStore {
  readonly #map = new Map<string, ToolSnapshots>();
  read(e: string, _r: string, s: string) { return this.#map.get(`${e}\0${s}`); }
  write(e: string, _r: string, s: string, t: ToolSnapshots) { this.#map.set(`${e}\0${s}`, t); }
}
