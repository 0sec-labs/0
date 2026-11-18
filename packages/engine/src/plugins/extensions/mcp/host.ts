/**
 * The extension MCP host: lazy, hash-pinned MCP servers declared by enabled extensions.
 *
 *   - Nothing starts until the model loads a server (`load_tool` on its index entry). Until then the model sees one
 *     catalog line per server and no tool schema, so the tool list is byte-stable for prompt caching.
 *   - Starting a server goes through the `beforeCommand` gate (`process` for a command, `network` for a URL) and the
 *     extension environment allowlist. An unpinned package launcher (npx, uvx...) is refused.
 *   - Every connection compares each tool's hash with the operator's approval. Anything changed, new or removed blocks
 *     the whole server until the operator approves again, with a readable diff (fail closed).
 *   - The pin is enforced for the whole session, not only at connect: a `tools/list_changed` notice blocks calls until the
 *     list is reviewed again, a dead or hung server is dropped, and each call re-checks the pin first.
 *   - Output is labelled with a per-call nonce, neutralised and capped.
 * Everything else (the operator's own servers, service plugins) stays on `base` and is untouched.
 */
import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolResult } from "../../../agent/types.js";
import type { McpLazyView, McpOperatorChannel, McpToolGateFlags, McpToolHost } from "../../../agent/mcp-host.js";
import { parseMcpToolName } from "../../../agent/mcp-adapt.js";
import type { LoadedExtension } from "../runtime.js";
import { buildDefinitions, indexDefinition, indexEntry, indexName, serverId } from "./core/definitions.js";
import { launchFor, launchHookInput } from "./core/launch.js";
import { mcpToolHash, hashTools, type McpToolInfo } from "./core/tool-hash.js";
import { labelUntrustedOutput } from "./core/untrusted.js";
import type { McpConnector, McpGate, McpObservationLog, McpPinStore, McpSession, McpSnapshotStore } from "./ports.js";
import { reviewServer } from "./review-flow.js";
import { message, newServer, redactWith, type Server, type State } from "./server-state.js";

export interface ExtensionMcpHostOptions {
  extensions: readonly LoadedExtension[];
  connector: McpConnector; pins: McpPinStore; observed: McpObservationLog; gate: McpGate;
  /** What the operator last approved, as text, so an approval prompt can show a diff. */
  snapshots?: McpSnapshotStore;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** The operator's own servers and service plugins; this host adds to them. */
  base?: McpToolHost;
  now?: () => Date;
}

const FLAGS: McpToolGateFlags = { networkCapable: true, readOnly: false };
const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : 1);

export class ExtensionMcpHost implements McpToolHost {
  readonly #servers = new Map<string, Server>();
  readonly #o: ExtensionMcpHostOptions;
  #operator: McpOperatorChannel | undefined;

  constructor(options: ExtensionMcpHostOptions) {
    this.#o = options;
    for (const ext of [...options.extensions].sort(byName)) {
      for (const decl of [...ext.manifest.mcpServers].sort(byName)) {
        const wanted = serverId(ext.name, decl.name); let id = wanted;
        for (let i = 2; this.#servers.has(id); i++) id = `${wanted.slice(0, 36)}-${i}`;
        this.#servers.set(id, newServer(id, ext, decl, indexEntry(id, ext.name, decl.description, ext.manifest.description)));
      }
    }
  }

  attachOperator(channel: McpOperatorChannel): void { this.#operator = channel; }

  /** Servers that are declared, for status and tests. */
  serverIds(): string[] { return [...this.#servers.keys()]; }
  stateOf(id: string): { state: State; reason: string } | undefined { const s = this.#servers.get(id); return s && { state: s.state, reason: s.reason }; }

  /** The ids the operator's own host already uses. An extension server may never share one: the operator's wins, ours is refused. */
  #baseIds(): Set<string> {
    const base = this.#o.base; const ids = new Set<string>();
    for (const d of base?.registeredTools() ?? []) { const p = parseMcpToolName(d.name); if (p) ids.add(p.server); }
    for (const d of base?.lazyServers?.().index ?? []) ids.add(d.name.replace(/^mcp__/, ""));
    return ids;
  }
  #collides(server: Server): boolean { return this.#baseIds().has(server.id); }

  lazyServers(): McpLazyView {
    const own = [...this.#servers.values()].filter(s => !this.#collides(s));
    const index = own.filter(s => s.state !== "ready").map(s => indexDefinition(s.entry));
    return { index, loaded: new Set(own.flatMap(s => s.defs.map(d => d.name))) };
  }

  registeredTools(): ToolDefinition[] {
    const base = this.#o.base?.registeredTools() ?? []; const taken = new Set(base.map(d => d.name));
    return [...base, ...[...this.#servers.values()].filter(s => s.state === "ready" && !s.stale && !this.#collides(s)).flatMap(s => s.defs).filter(d => !taken.has(d.name))];
  }

  toolGateFlags(name: string): McpToolGateFlags | undefined { return this.#own(name) ? FLAGS : this.#o.base?.toolGateFlags?.(name); }

  #own(name: string): { server: Server; tool: string } | null {
    const parsed = parseMcpToolName(name); const server = parsed && this.#servers.get(parsed.server);
    return parsed && server && !this.#collides(server) ? { server, tool: parsed.tool } : null;
  }

  async loadServer(name: string): Promise<{ ok: boolean; message: string }> {
    const server = [...this.#servers.values()].find(s => indexName(s.id) === name);
    if (!server) return { ok: false, message: `${name} is not an MCP server of an enabled extension.` };
    if (this.#collides(server)) return { ok: false, message: `MCP server "${server.id}" is refused: its id is already used by one of the operator's own servers.` };
    server.loading ??= this.#start(server).finally(() => { server.loading = undefined; });
    await server.loading;
    return server.state === "ready"
      ? { ok: true, message: `MCP server "${server.id}" loaded: ${server.defs.length} tool(s), callable on your next turn: ${server.defs.map(d => d.name).join(", ")}.` }
      : { ok: false, message: `MCP server "${server.id}" is not available: ${redactWith(server, server.reason)}` };
  }

  #block(server: Server, reason: string): void { server.state = "blocked"; server.reason = reason; server.defs = []; server.allowed = new Set(); server.tools = new Map(); }

  /** Forget a session that is gone or untrusted and close it. A server that merely died may be started again (and reviewed again). */
  async #drop(server: Server, session: McpSession, state: "idle" | "blocked", reason: string): Promise<void> {
    if (server.session !== session) return;
    server.session = undefined; server.stale = false;
    this.#block(server, reason); if (state === "idle") server.state = "idle";
    await session.close();
  }

  async #start(server: Server): Promise<void> {
    if (server.state === "ready") return;
    const { ext, decl } = server;
    const plan = launchFor(decl, { extension: ext.name, dir: ext.dir, parentEnv: ext.connected(this.#o.parentEnv ?? process.env), approvedEnv: [...ext.approvedEnv, ...decl.env] });
    if ("refused" in plan) return this.#block(server, plan.refused);
    const launch = plan.launch;
    server.secrets = launch.kind === "stdio" ? Object.entries(launch.env).filter(([k, v]) => !k.startsWith("ZERO_") && v.length >= 6).map(([, v]) => v) : [];
    const operator = this.#operator;
    const hook = await this.#o.gate(launchHookInput(launch, operator?.thread() ?? {}, operator?.cwd ?? ext.dir)).catch(e => ({ decision: "deny" as const, reason: `gate failed: ${message(e)}` }));
    if (hook.decision === "deny") return this.#block(server, `denied before it started: ${hook.reason}`);
    if (hook.decision === "ask") {
      const what = launch.kind === "stdio" ? `start ${[launch.command, ...launch.args].join(" ")}` : `connect to ${launch.url}`;
      if (!operator?.approve) return this.#block(server, `needs your approval to ${what} and no one can be asked here`);
      if (!await operator.approve({ name: "mcp_server_start", summary: `Extension ${ext.name} wants to ${what} (MCP server ${decl.name}). ${hook.reason}` })) return this.#block(server, "you did not approve starting it");
    }
    let session: McpSession;
    try { session = await this.#o.connector.connect(launch); } catch (e) { return this.#block(server, redactWith(server, `could not start: ${message(e)}`)); }
    try {
      const tools = await session.tools();
      const ready = await this.#adopt(server, tools);
      if (!ready.ok) { await session.close(); return this.#block(server, ready.reason); }
      server.session = session; server.state = "ready"; server.reason = ""; server.stale = false;
      session.onToolsChanged(() => { server.stale = true; void this.#revalidate(server, session); });
      session.onClosed(reason => { void this.#drop(server, session, "idle", `the server stopped: ${reason}`); });
    } catch (e) { await session.close(); this.#block(server, `could not list its tools: ${redactWith(server, message(e))}`); }
  }

  /** Review `tools` against the pin (asking the operator on a mismatch) and, if they pass, make them the callable set. */
  async #adopt(server: Server, tools: McpToolInfo[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { ext, decl } = server;
    const review = await reviewServer({ pins: this.#o.pins, ...(this.#o.snapshots ? { snapshots: this.#o.snapshots } : {}), operator: this.#operator }, server, tools);
    this.#o.observed.record(ext.name, ext.revision, decl.name, { at: (this.#o.now?.() ?? new Date()).toISOString(), tools: hashTools(tools), review: review.needsApproval ? review : null, blocked: review.needsApproval ? review.reason : null });
    if (review.needsApproval) return { ok: false, reason: review.reason };
    server.tools = new Map(tools.map(t => [t.name, t])); server.allowed = new Set(review.allowed); server.defs = buildDefinitions(server.id, tools, server.allowed).definitions;
    return { ok: true };
  }

  /** The server said its tools changed. Calls stay refused until the new list is reviewed; unreviewed changes block the server. */
  #revalidate(server: Server, session: McpSession): Promise<void> {
    server.revalidating ??= (async () => {
      try {
        const tools = await session.tools();
        if (server.session !== session) return;
        const result = await this.#adopt(server, tools);
        if (!result.ok) await this.#drop(server, session, "blocked", `its tools changed while it was running: ${result.reason}`);
        else server.stale = false;
      } catch (e) { await this.#drop(server, session, "blocked", `its tools changed and could not be reviewed: ${redactWith(server, message(e))}`); }
    })().finally(() => { server.revalidating = undefined; });
    return server.revalidating;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const own = this.#own(name);
    if (!own) return this.#o.base ? this.#o.base.callTool(name, args) : { success: false, output: null, error: `MCP tool ${name} is not available` };
    const { server, tool } = own; const { ext, decl } = server;
    const fail = (error: string): ToolResult => ({ success: false, output: null, error });
    if (server.state !== "ready" || !server.session || !server.allowed.has(tool)) return fail(`MCP tool ${name} is blocked${server.reason ? `: ${redactWith(server, server.reason)}` : ": load its server first"}`);
    if (server.stale || server.revalidating) return fail(`MCP tool ${name} is blocked: the server reported changed tools and they are being reviewed`);
    // Cheap re-check from cached state: the definition this call was built from must still be the one the operator pinned.
    const cached = server.tools.get(tool); const pinned = this.#o.pins.pins(ext.name, ext.revision)[decl.name]?.tools[tool];
    if (!cached || pinned === undefined || mcpToolHash(cached) !== pinned) return fail(`MCP tool ${name} is blocked: it no longer matches what you approved`);
    try {
      const res = await server.session.call(tool, args);
      const labelled = labelUntrustedOutput({ extension: ext.name, server: server.id, tool }, redactWith(server, res.text), randomUUID().replaceAll("-", ""));
      return res.isError ? fail(labelled.text) : { success: true, output: { text: labelled.text, untrusted: true, truncated: labelled.truncated } };
    } catch (e) { return fail(redactWith(server, message(e))); }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.#servers.values()].flatMap(s => (s.session ? [s.session] : []));
    for (const s of this.#servers.values()) { s.session = undefined; s.state = "idle"; s.defs = []; s.allowed = new Set(); s.tools = new Map(); }
    await Promise.allSettled([...sessions.map(s => s.close()), this.#o.base?.closeAll()]);
  }
}
