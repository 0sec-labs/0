import type { Command } from "commander";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { BACKEND_PROTOCOL_VERSION, backendCapabilitiesForApiPath, type BackendHandshake } from "@0/shared";
import { BackendConnectionError, BackendConnectionRegistry, backendBearerFromEnv, loadBackendConnectionConfig } from "../web/backend-connections.js";

const MAX_BODY = 1_000_000;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"];
export interface ApiCommandOptions {
  method?: string;
  data?: string;
  backend?: string;
  backendsConfig?: string;
  engineUrl?: string;
  engineTokenEnv?: string;
}
export interface ApiCommandDependencies {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  out?(text: string): void;
  err?(text: string): void;
  setExitCode?(code: number): void;
}

async function parseBody(input: string | undefined): Promise<unknown> {
  if (input === undefined) return undefined;
  let text = input;
  if (input.startsWith("@")) {
    if (input.length === 1) throw new Error("--data @file requires a file path.");
    const file = await open(input.slice(1), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BODY) throw new Error("API data must be a regular JSON file of at most 1 MB.");
      const buffer = Buffer.alloc(MAX_BODY + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BODY) throw new Error("API data exceeds 1 MB.");
      text = buffer.subarray(0, length).toString("utf8");
    } finally { await file.close(); }
  }
  if (Buffer.byteLength(text) > MAX_BODY) throw new Error("API data exceeds 1 MB.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error("--data must contain valid JSON, or @file containing JSON."); }
  // The registry bounds the serialized request too; reject it before a handshake.
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) throw new Error("API data exceeds 1 MB.");
  return body;
}

/** A deterministic HTTP projection of the same trusted transport used by the web app. */
export async function runApiCommand(path: string | undefined, options: ApiCommandOptions, deps: ApiCommandDependencies = {}): Promise<void> {
  const out = deps.out ?? (text => { process.stdout.write(`${text}\n`); });
  const err = deps.err ?? (text => { process.stderr.write(`${text}\n`); });
  const fail = deps.setExitCode ?? (code => { process.exitCode = code; });
  let registry: BackendConnectionRegistry | undefined;
  try {
    const method = (options.method ?? "GET").toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`--method must be one of ${METHODS.join(", ")}.`);
    if (options.data !== undefined && (method === "GET" || method === "HEAD")) throw new Error("GET and HEAD cannot include --data.");
    if (options.engineUrl && (options.backend || options.backendsConfig)) throw new Error("--engine-url cannot be combined with --backend or --backends-config.");
    if (Boolean(options.engineUrl) !== Boolean(options.engineTokenEnv)) throw new Error("Direct attachment requires both --engine-url and --engine-token-env.");
    if (!options.engineUrl && !options.backend) throw new Error("Select --backend or --engine-url with --engine-token-env explicitly.");
    if (options.backend === "local") throw new Error("Use an explicit HTTP engine URL or registered HTTP backend; local is not an API transport.");
    const requestPath = path ?? "/api/backend/handshake";
    if (requestPath.includes("#")) throw new Error("API paths cannot contain fragments.");
    // Unknown routes cannot cause even a discovery request. The registry owns
    // path canonicalization, capability checks, identity pins and all HTTP I/O.
    if (!requestPath.startsWith("/api/") || (requestPath.split("?")[0] !== "/api/backend/handshake" && !backendCapabilitiesForApiPath(requestPath.split("?")[0]!).length)) throw new Error("Supply an admitted /api/ path.");
    const body = await parseBody(options.data);
    const env = deps.env ?? process.env;
    const backendId = options.backend ?? "attached-engine";
    const connections = options.engineUrl
      ? [{ id: backendId, name: "Attached engine", url: options.engineUrl, bearerTokenEnv: options.engineTokenEnv! }]
      : loadBackendConnectionConfig(options.backendsConfig);
    const connection = connections.find(row => row.id === backendId);
    if (!connection) throw new Error("Backend is not registered.");
    // The registry may resolve managed-host credentials from its existing local
    // registry. Direct attachment must have its named credential before I/O.
    if (options.engineUrl) backendBearerFromEnv(connection.bearerTokenEnv, env);
    const localHandshake: BackendHandshake = { protocolVersion: BACKEND_PROTOCOL_VERSION, engineId: "api-client", capabilities: [], platform: { os: process.platform, pathStyle: process.platform === "win32" ? "windows" : "posix" } };
    registry = new BackendConnectionRegistry({ ...(options.engineUrl ? { connections } : { configPath: options.backendsConfig }), env, ...(deps.fetch ? { fetch: deps.fetch } : {}), localHandshake });
    const response = await registry.request(backendId, requestPath, { method, ...(body !== undefined ? { body } : {}) });
    const text = method === "HEAD" || response.status === 204 ? "" : await response.text();
    let data: unknown = text || null;
    if (text && /(?:application\/json|\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
      try { data = JSON.parse(text); } catch { throw new Error(`Engine returned malformed JSON (HTTP ${response.status}).`); }
    }
    out(JSON.stringify({ ok: response.ok, status: response.status, data }));
    if (!response.ok) {
      err(JSON.stringify({ ok: false, status: response.status, error: `Engine request failed (HTTP ${response.status}).` }));
      fail(2);
    }
  } catch (error) {
    err(JSON.stringify({ ok: false, status: error instanceof BackendConnectionError ? error.statusCode : null, error: error instanceof Error ? error.message : "API request failed." }));
    fail(2);
  } finally { registry?.dispose(); }
}

export function registerApiCommand(program: Command, deps: ApiCommandDependencies = {}): void {
  program.command("api [path]").description("Call a trusted engine API with deterministic JSON output (defaults to its handshake)")
    .option("--method <method>", "GET, POST, PATCH, PUT, DELETE or HEAD", "GET")
    .option("--data <json-or-@file>", "JSON body, or @regular-file containing JSON (at most 1 MB)")
    .option("--backend <id>", "Registered HTTP engine ID")
    .option("--backends-config <path>", "Operator backend registry JSON file")
    .option("--engine-url <url>", "Attach directly to a trusted HTTP engine")
    .option("--engine-token-env <name>", "Environment variable containing its engine token")
    .action((path: string | undefined, options: ApiCommandOptions) => runApiCommand(path, options, deps));
}
