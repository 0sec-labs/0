/**
 * The extension MCP host: lazy, hash-pinned MCP servers declared by enabled extensions.
 *
 *   - Nothing starts until the model loads a server (`load_tool` on its index entry). Until then the model sees one
 *     catalog line per server and no tool schema, so the tool list is byte-stable for prompt caching.
 *   - Starting a server goes through the `beforeCommand` gate (`process` for a command, `network` for a URL) and the
 *     extension environment allowlist.
 *   - Every connection compares each tool's hash with the operator's approval. Anything changed, new or removed blocks
 *     the whole server until the operator approves again (fail closed). Nothing is advertised or callable before that.
 *   - Output is labelled untrusted and capped.
 * Everything else (the operator's own servers, service plugins) stays on `base` and is untouched.
 */
import type { ToolDefinition, ToolResult } from "../../../agent/types.js";
import type { McpLazyView, McpOperatorChannel, McpToolGateFlags, McpToolHost } from "../../../agent/mcp-host.js";
import { parseMcpToolName } from "../../../agent/mcp-adapt.js";
import type { LoadedExtension } from "../runtime.js";
import type { McpServerDecl } from "../core/manifest.js";
import { buildDefinitions, indexDefinition, indexEntry, indexName, serverId, type ServerIndexEntry } from "./core/definitions.js";
import { launchFor, launchHookInput } from "./core/launch.js";
import { reviewTools, type ToolReview } from "./core/review.js";
import { hashTools, type McpToolInfo } from "./core/tool-hash.js";
import { labelUntrustedOutput } from "./core/untrusted.js";
import type { McpConnector, McpGate, McpObservationLog, McpPinStore, McpSession } from "./ports.js";

export interface ExtensionMcpHostOptions {
  extensions: readonly LoadedExtension[];
  connector: McpConnector; pins: McpPinStore; observed: McpObservationLog; gate: McpGate;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** The operator's own servers and service plugins; this host adds to them. */
  base?: McpToolHost;
  now?: () => Date;
}

type State = "idle" | "ready" | "blocked";
interface Server {
  readonly id: string; readonly ext: LoadedExtension; readonly decl: McpServerDecl; readonly entry: ServerIndexEntry;
  state: State; reason: string; session?: McpSession; tools: McpToolInfo[]; allowed: Set<string>; defs: ToolDefinition[]; secrets: string[]; loading?: Promise<void>;
}

const FLAGS: McpToolGateFlags = { networkCapable: true, localScope: false, readOnly: false };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class ExtensionMcpHost implements McpToolHost {
  readonly #servers = new Map<string, Server>();
  readonly #o: ExtensionMcpHostOptions;
  #operator: McpOperatorChannel | undefined;

  constructor(options: ExtensionMcpHostOptions) {
    this.#o = options;
    for (const ext of [...options.extensions].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      for (const decl of [...ext.manifest.mcpServers].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        let id = serverId(ext.name, decl.name); for (let i = 2; this.#servers.has(id); i++) id = `${serverId(ext.name, decl.name).slice(0, 36)}-${i}`;
        this.#servers.set(id, { id, ext, decl, entry: indexEntry(id, ext.name, decl.description, ext.manifest.description), state: "idle", reason: "", tools: [], allowed: new Set(), defs: [], secrets: [] });
      }
    }
  }

  attachOperator(channel: McpOperatorChannel): void { this.#operator = channel; }

  /** Servers that are declared, for status and tests. */
  serverIds(): string[] { return [...this.#servers.keys()]; }
  stateOf(id: string): { state: State; reason: string } | undefined { const s = this.#servers.get(id); return s && { state: s.state, reason: s.reason }; }

  lazyServers(): McpLazyView {
    const index = [...this.#servers.values()].filter(s => s.state !== "ready").map(s => indexDefinition(s.entry));
    return { index, loaded: new Set([...this.#servers.values()].flatMap(s => s.defs.map(d => d.name))) };
  }

  registeredTools(): ToolDefinition[] {
    return [...(this.#o.base?.registeredTools() ?? []), ...[...this.#servers.values()].filter(s => s.state === "ready").flatMap(s => s.defs)];
  }

  toolGateFlags(name: string): McpToolGateFlags | undefined {
    return this.#own(name) ? FLAGS : this.#o.base?.toolGateFlags?.(name);
  }

  #own(name: string): { server: Server; tool: string } | null {
    const parsed = parseMcpToolName(name); const server = parsed && this.#servers.get(parsed.server);
    return parsed && server ? { server, tool: parsed.tool } : null;
  }

  async loadServer(name: string): Promise<{ ok: boolean; message: string }> {
    const server = [...this.#servers.values()].find(s => indexName(s.id) === name);
    if (!server) return { ok: false, message: `${name} is not an MCP server of an enabled extension.` };
    server.loading ??= this.#start(server).finally(() => { server.loading = undefined; });
    await server.loading;
    return server.state === "ready"
      ? { ok: true, message: `MCP server "${server.id}" loaded: ${server.defs.length} tool(s), callable on your next turn: ${server.defs.map(d => d.name).join(", ")}.` }
      : { ok: false, message: `MCP server "${server.id}" is not available: ${server.reason}` };
  }

  #block(server: Server, reason: string): void { server.state = "blocked"; server.reason = reason; server.defs = []; server.allowed = new Set(); }

  async #start(server: Server): Promise<void> {
    if (server.state === "ready") return;
    const { ext, decl } = server;
    const launch = launchFor(decl, { extension: ext.name, dir: ext.dir, parentEnv: this.#o.parentEnv ?? process.env });
    if (!launch) return this.#block(server, "its declaration has no command or url");
    server.secrets = launch.kind === "stdio" ? Object.values(launch.env).filter(v => v.length >= 8) : [];
    const operator = this.#operator;
    const hook = await this.#o.gate(launchHookInput(launch, operator?.thread() ?? {}, operator?.cwd ?? ext.dir)).catch(e => ({ decision: "deny" as const, reason: `gate failed: ${message(e)}` }));
    if (hook.decision === "deny") return this.#block(server, `denied before it started: ${hook.reason}`);
    if (hook.decision === "ask") {
      const what = launch.kind === "stdio" ? `start ${[launch.command, ...launch.args].join(" ")}` : `connect to ${launch.url}`;
      if (!operator?.approve) return this.#block(server, `needs your approval to ${what} and no one can be asked here`);
      if (!await operator.approve({ name: "mcp_server_start", summary: `Extension ${ext.name} wants to ${what} (MCP server ${decl.name}). ${hook.reason}` })) return this.#block(server, "you did not approve starting it");
    }
    let session: McpSession;
    try { session = await this.#o.connector.connect(launch); } catch (e) { return this.#block(server, `could not start: ${message(e)}`); }
    try {
      const tools = await session.tools();
      const review = await this.#review(server, tools);
      this.#o.observed.record(ext.name, ext.revision, decl.name, { at: (this.#o.now?.() ?? new Date()).toISOString(), tools: hashTools(tools), review: review.needsApproval ? review : null, blocked: review.needsApproval ? review.reason : null });
      if (review.needsApproval) { await session.close(); return this.#block(server, review.reason); }
      const built = buildDefinitions(server.id, tools, new Set(review.allowed));
      server.session = session; server.tools = tools; server.allowed = new Set(review.allowed); server.defs = built.definitions; server.state = "ready"; server.reason = "";
    } catch (e) { await session.close(); this.#block(server, `could not list its tools: ${message(e)}`); }
  }

  /** Compare with the approval; on a mismatch ask the operator once, and record the pin only on a yes. */
  async #review(server: Server, tools: McpToolInfo[]): Promise<ToolReview> {
    const { ext, decl } = server;
    const review = reviewTools(this.#o.pins.pins(ext.name, ext.revision)[decl.name]?.tools, tools);
    if (!review.needsApproval || !this.#operator?.approve) return review;
    const names = tools.map(t => t.name).sort().slice(0, 12).join(", ");
    const ok = await this.#operator.approve({ name: "mcp_tools_approve", summary: `Approve the tools of MCP server ${decl.name} from extension ${ext.name}? ${review.reason}. Tools: ${names}${tools.length > 12 ? ", ..." : ""}.` });
    if (!ok) return review;
    const pinned = this.#o.pins.approve(ext.name, ext.revision, decl.name, hashTools(tools));
    return pinned.ok ? reviewTools(hashTools(tools), tools) : { ...review, reason: `${review.reason}; could not record your approval: ${pinned.error.message}` };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const own = this.#own(name);
    if (!own) return this.#o.base ? this.#o.base.callTool(name, args) : { success: false, output: null, error: `MCP tool ${name} is not available` };
    const { server, tool } = own;
    if (server.state !== "ready" || !server.session || !server.allowed.has(tool)) return { success: false, output: null, error: `MCP tool ${name} is blocked${server.reason ? `: ${server.reason}` : ": load its server first"}` };
    const redact = (v: string) => server.secrets.reduce((r, s) => r.split(s).join("[redacted]"), v);
    try {
      const res = await server.session.call(tool, args);
      const labelled = labelUntrustedOutput({ extension: server.ext.name, server: server.id, tool }, redact(res.text));
      return res.isError ? { success: false, output: null, error: labelled.text } : { success: true, output: { text: labelled.text, untrusted: true, truncated: labelled.truncated } };
    } catch (e) { return { success: false, output: null, error: redact(message(e)) }; }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.#servers.values()].flatMap(s => (s.session ? [s.session] : []));
    for (const s of this.#servers.values()) { s.session = undefined; s.state = "idle"; s.defs = []; s.allowed = new Set(); }
    await Promise.allSettled([...sessions.map(s => s.close()), this.#o.base?.closeAll()]);
  }
}
