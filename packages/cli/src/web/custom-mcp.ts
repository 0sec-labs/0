import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpHost, isAllowedLocalOrigin, isPrivateAddress } from "@0/engine";
import { homeStateDir } from "@0/engine/shared";
import { consoleExecutionProfile } from "../console-execution.js";
import { connectorLogo } from "./connector-logos.js";

/**
 * Operator-defined MCP servers. A stdio server is arbitrary code as the user, so
 * every create/edit/enable is bound to a reviewed fingerprint of the exact
 * command, args, cwd, env key names, URL and header names. Nothing runs on save.
 * Env values and header values are write-only secrets (0600 file, never returned).
 */
export type McpTransport = "stdio" | "http" | "sse";
interface StoredServer {
  id: string; name: string; transport: McpTransport;
  command: string | null; args: string[]; cwd: string | null; env: Record<string, string>;
  url: string | null; headers: Record<string, string>;
  enabled: boolean; testStatus: "untested" | "ok" | "error"; statusMessage: string | null;
  tools: Array<{ name: string; description: string }>; resourceCount: number; version: string | null;
  testedAt: string | null; createdAt: string; updatedAt: string; approvedFingerprint: string | null;
}
type Config = Pick<StoredServer, "name" | "transport" | "command" | "args" | "cwd" | "env" | "url" | "headers">;
export interface McpTestResult { tools: Array<{ name: string; description: string }>; resources: Array<{ uri: string; name: string }>; version: string | null }
export type McpConnector = (server: LaunchConfig) => Promise<McpTestResult>;
export type LaunchConfig =
  | { id: string; transport: "stdio"; command: string; args: string[]; cwd: string; env: Record<string, string> }
  | { id: string; transport: "http" | "sse"; url: string; headers: Record<string, string> };
export interface CustomMcpOptions {
  homeDir?: string;
  /** Mission workspace root used as the stdio launch directory. */
  workspaceRoot?: () => string;
  connector?: McpConnector;
  resolveHost?: (host: string) => Promise<string[]>;
}

class McpApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}
const bad = (message: string, code = "invalid_configuration") => new McpApiError(400, code, message);
const MAX_FILE = 1_048_576;
const BLOCKED_ENV = /^(LD_[A-Z_]*|DYLD_[A-Z_]*|NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS)$/;
/** Variables that change which code a stdio server loads. Allowed only when named in an explicit dangerous-env approval. */
const DANGEROUS_ENV = /^(PATH|NODE_PATH|PYTHONPATH|PYTHONHOME|PERL5LIB|RUBYLIB|GEM_PATH|GEM_HOME|CLASSPATH|GOFLAGS|GOPATH|NPM_CONFIG_PREFIX|HOME)$/i;
function dangerousEnvKeys(env: Record<string, string>): string[] { return Object.keys(env).filter(key => DANGEROUS_ENV.test(key)).sort(); }
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_IDS = new Set(["zeroverse", "github", "elastic", "semgrep", "snyk", "linear", "jira", "cloudflare", "slack", "teams"]);

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad(`Expected ${what} to be an object.`);
  return value as Record<string, unknown>;
}
function str(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\x00/.test(value)) throw bad(`Invalid ${what}.`);
  return value.trim();
}
function stringMap(value: unknown, what: string, keyOk: (key: string) => boolean, previous: Record<string, string> = {}): Record<string, string> {
  if (value === undefined) return {};
  const input = record(value, what);
  const keys = Object.keys(input);
  if (keys.length > 64) throw bad(`Too many ${what}.`);
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (!keyOk(key) || key === "__proto__") throw bad(`Invalid ${what} name.`);
    const raw = input[key];
    if (typeof raw !== "string" || raw.length > 8192 || /[\x00\r\n]/.test(raw)) throw bad(`Invalid ${what} value.`);
    if (raw === "") { if (previous[key] === undefined) throw bad(`Enter a value for ${key}.`); out[key] = previous[key]!; }
    else out[key] = raw;
  }
  return out;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
}

/** Validate one full config (synchronous parts only; network checks happen in `assertRemote`). */
export function normalizeMcpConfig(input: unknown, previous?: StoredServer): Config {
  const body = record(input, "config");
  const merged: Record<string, unknown> = previous ? { name: previous.name, transport: previous.transport, command: previous.command ?? undefined, args: previous.args, cwd: previous.cwd ?? undefined, url: previous.url ?? undefined, ...body } : body;
  const name = str(merged.name, "name", 60);
  const transport = merged.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") throw bad("Transport must be stdio, http or sse.");
  const switched = previous !== undefined && previous.transport !== transport;
  const prevEnv = switched ? {} : previous?.env ?? {}; const prevHeaders = switched ? {} : previous?.headers ?? {};
  if (transport === "stdio") {
    const command = str(merged.command, "command", 1024);
    if (/\s/.test(command)) throw bad("Command must be a single executable; put arguments in args.");
    const args = merged.args === undefined ? [] : merged.args;
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\x00"))) throw bad("Invalid args.");
    let cwd: string | null = null;
    if (merged.cwd !== undefined && merged.cwd !== null && merged.cwd !== "") {
      cwd = str(merged.cwd, "cwd", 1024);
      if (isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw bad("cwd must be a relative path inside the mission workspace.");
    }
    const env = stringMap(body.env === undefined && previous && !switched ? Object.fromEntries(Object.keys(previous.env).map(key => [key, ""])) : body.env, "env", key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !BLOCKED_ENV.test(key), prevEnv);
    return { name, transport, command, args: args as string[], cwd, env, url: null, headers: {} };
  }
  let url: URL;
  try { url = new URL(str(merged.url, "url", 2048)); } catch { throw bad("Enter a valid URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isAllowedLocalOrigin(url))) throw bad("Remote MCP servers require HTTPS.");
  if (url.username || url.password || url.hash) throw bad("The URL must not contain credentials or a fragment; use headers.");
  const headers = stringMap(body.headers === undefined && previous && !switched ? Object.fromEntries(Object.keys(previous.headers).map(key => [key, ""])) : body.headers, "headers", key => HEADER_NAME.test(key), prevHeaders);
  return { name, transport, command: null, args: [], cwd: null, env: {}, url: url.href, headers };
}

/**
 * Per-install secret for fingerprinting env/header VALUES. Never returned by any route; it lives next
 * to the (equally secret) server file with the same 0600 mode.
 */
function installKey(homeDir?: string): Buffer {
  const directory = homeStateDir(homeDir); assertRegular(directory, true);
  const path = join(directory, "mcp-fingerprint.key"); assertRegular(path);
  try { const existing = readFileSync(path); if (existing.length >= 32) return existing; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const key = randomBytes(32); const temporary = join(directory, `.mcp-key-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, key, { mode: 0o600, flag: "wx" }); try { renameSync(temporary, path); } catch { /* lost a race: use the winner */ } }
  finally { rmSync(temporary, { force: true }); }
  return readFileSync(path);
}
/** Keyed MAC of env and header values. A value change alters the fingerprint, yet the values stay unrecoverable from it. */
function valueMac(config: Pick<Config, "env" | "headers">, key: Buffer): string {
  const pairs = (map: Record<string, string>, fold: boolean) => Object.keys(map).map(name => [fold ? name.toLowerCase() : name, map[name]!]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
  return createHmac("sha256", key).update(JSON.stringify({ env: pairs(config.env, false), headers: pairs(config.headers, true) })).digest("hex");
}
function configFingerprint(config: Config, homeDir?: string): string {
  return createHash("sha256").update(JSON.stringify({
    transport: config.transport, command: config.command, args: config.args, cwd: config.cwd, url: config.url,
    env: Object.keys(config.env).sort(), headers: Object.keys(config.headers).map(key => key.toLowerCase()).sort(),
    values: valueMac(config, installKey(homeDir)),
  })).digest("hex");
}

/** Mission workspace containment for the stdio launch directory. */
function resolveLaunchCwd(workspaceRoot: string, sub: string | null): string {
  const root = realpathSync(resolve(workspaceRoot));
  if (!sub) return root;
  const target = realpathSync(resolve(root, sub));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw bad("cwd resolves outside the mission workspace.", "cwd_outside_workspace");
  return target;
}

/** Same network posture as scoped HTTP: public hosts only unless an exact local origin is operator-allowed. */
export async function assertRemoteAllowed(rawUrl: string, resolveHost?: (host: string) => Promise<string[]>): Promise<void> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isAllowedLocalOrigin(url)) return;
  const local = host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host);
  if (local) throw bad("Local or private network addresses are blocked for remote MCP servers.", "network_blocked");
  const addresses = await (resolveHost ?? (async (name: string) => (await lookup(name, { all: true })).map(row => row.address)))(host).catch(() => { throw bad("The server host could not be resolved.", "network_blocked"); });
  if (!addresses.length || addresses.some(address => isPrivateAddress(address))) throw bad("The server host resolves to a local or private network address.", "network_blocked");
}

function assertRegular(path: string, directory = false): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unsafe MCP configuration path.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function readStore(homeDir?: string): StoredServer[] {
  const directory = homeStateDir(homeDir); assertRegular(directory, true);
  const path = join(directory, "mcp-servers.json"); assertRegular(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("Invalid MCP configuration file.");
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!Array.isArray(raw)) throw new Error("Invalid MCP configuration file.");
    return raw.filter((row): row is StoredServer => !!row && typeof row === "object" && typeof (row as StoredServer).id === "string" && /^custom-[a-z0-9-]{1,40}$/.test((row as StoredServer).id));
  } finally { closeSync(fd); }
}
function writeStore(rows: StoredServer[], homeDir?: string): void {
  const serialized = JSON.stringify(rows) + "\n";
  if (Buffer.byteLength(serialized) > MAX_FILE) throw new Error("MCP configuration is too large.");
  const directory = homeStateDir(homeDir); assertRegular(directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = join(directory, "mcp-servers.json"); assertRegular(path);
  const temporary = join(directory, `.mcp-servers-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function launchFor(server: StoredServer, workspaceRoot: string): LaunchConfig {
  if (server.transport === "stdio") return { id: server.id, transport: "stdio", command: server.command!, args: server.args, cwd: resolveLaunchCwd(workspaceRoot, server.cwd), env: server.env };
  return { id: server.id, transport: server.transport, url: server.url!, headers: server.headers };
}
function secretsOf(server: Pick<StoredServer, "env" | "headers">): string[] {
  const values = [...Object.values(server.env), ...Object.values(server.headers)];
  for (const value of Object.values(server.headers)) values.push(value.replace(/^(Bearer|ApiKey|Basic|Token)\s+/i, ""));
  return [...new Set(values.filter(value => value.length >= 4))].sort((a, b) => b.length - a.length);
}
const redactWith = (secrets: string[]) => (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");

async function defaultConnector(config: LaunchConfig): Promise<McpTestResult> {
  const host = new McpHost();
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for the MCP server.")), 20_000).unref());
    const connect = config.transport === "stdio"
      ? host.connectStdio({ id: config.id, command: config.command, args: config.args, cwd: config.cwd, env: config.env })
      : host.connectHttp({ id: config.id, url: config.url, headers: config.headers, transport: config.transport });
    const defs = await Promise.race([connect, timeout]);
    const meta = await host.describeServer(config.id);
    return { tools: defs.map(def => ({ name: def.name, description: def.description ?? "" })), resources: meta.resources, version: meta.version };
  } finally { await host.closeAll(); }
}

export interface Approval {
  fingerprint: string; action: "create" | "edit" | "enable"; transport: McpTransport;
  summary: { command: string | null; args: string[]; cwd: string | null; envKeys: string[]; url: string | null; headerNames: string[] };
  /** Env names that change which code the server loads (PATH, NODE_PATH, ...). Needs `approvedDangerousEnv` echoing this list. */
  dangerousEnv: string[];
  warnings: string[];
}

export class CustomMcpServices {
  readonly #options: CustomMcpOptions;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(options: CustomMcpOptions = {}) { this.#options = options; }
  #workspace(): string { return this.#options.workspaceRoot?.() ?? process.cwd(); }
  #view(row: StoredServer) {
    const fingerprint = configFingerprint(row, this.#options.homeDir);
    const redact = redactWith(secretsOf(row));
    return {
      id: row.id, name: row.name, kind: "custom-mcp" as const, transport: row.transport, enabled: row.enabled,
      status: row.enabled ? row.testStatus : "disabled" as const, statusMessage: row.statusMessage === null ? null : redact(row.statusMessage),
      command: row.command, args: row.args, cwd: row.cwd, envKeys: Object.keys(row.env), url: row.url, headerNames: Object.keys(row.headers),
      toolCount: row.tools.length, resourceCount: row.resourceCount, skillCount: 0, version: row.version,
      tools: row.tools.map(tool => ({ name: redact(tool.name), description: redact(tool.description) })),
      logo: connectorLogo(row.id, row.name), testedAt: row.testedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
      fingerprint, approved: row.approvedFingerprint === fingerprint,
    };
  }
  #list() { return { items: readStore(this.#options.homeDir).map(row => this.#view(row)), executionProfile: consoleExecutionProfile() }; }
  #approval(config: Config, action: Approval["action"]): Approval {
    let cwd: string | null = null;
    if (config.transport === "stdio") { try { cwd = resolveLaunchCwd(this.#workspace(), config.cwd); } catch (error) { if (error instanceof McpApiError) throw error; cwd = null; } }
    return {
      fingerprint: configFingerprint(config, this.#options.homeDir), action, transport: config.transport,
      summary: { command: config.command, args: config.args, cwd, envKeys: Object.keys(config.env), url: config.url, headerNames: Object.keys(config.headers) },
      dangerousEnv: dangerousEnvKeys(config.env),
      warnings: [
        ...(dangerousEnvKeys(config.env).length ? [`Sets ${dangerousEnvKeys(config.env).join(", ")}, which can change which programs or libraries this server loads. Approve only if you trust the value.`] : []),
        "Environment and header values are part of this approval: changing a value requires approving again.",
        config.transport === "stdio" ? "Runs this exact command as your user, with only the declared environment variables, inside the mission workspace." : "Connects to this remote server and sends the declared headers to it.",
        "Tools from this server are available to missions and their output is untrusted data.",
      ],
    };
  }
  async #checkRemote(config: Config) { if (config.url) await assertRemoteAllowed(config.url, this.#options.resolveHost); }
  #requireApproval(config: Config, action: Approval["action"], supplied: unknown, dangerousAck?: unknown): void {
    const approval = this.#approval(config, action);
    if (supplied !== approval.fingerprint) throw new McpApiError(409, "approval_required", "Review and approve the exact command and settings first.", { approval });
    const acknowledged = Array.isArray(dangerousAck) ? dangerousAck.filter((name): name is string => typeof name === "string").map(name => name.toUpperCase()).sort() : [];
    if (approval.dangerousEnv.length && JSON.stringify(acknowledged) !== JSON.stringify(approval.dangerousEnv.map(name => name.toUpperCase()).sort())) {
      throw new McpApiError(409, "dangerous_env_approval_required", "This server sets environment variables that change which code it loads. Approve them by name to continue.", { approval });
    }
  }
  async #handle(path: string, method: string, input: unknown): Promise<unknown> {
    if (path === "mcp-servers" && method === "GET") return { data: this.#list() };
    const rows = readStore(this.#options.homeDir);
    if (path === "mcp-servers/preview" && method === "POST") {
      const config = normalizeMcpConfig(record(input, "request").config);
      await this.#checkRemote(config);
      return { data: { approval: this.#approval(config, "create") } };
    }
    if (path === "mcp-servers" && method === "POST") {
      const body = record(input, "request");
      const config = normalizeMcpConfig(body.config);
      await this.#checkRemote(config);
      this.#requireApproval(config, "create", body.approvedFingerprint, body.approvedDangerousEnv);
      if (rows.length >= 64) throw bad("Too many custom MCP servers.", "limit_reached");
      let id = `custom-${slug(config.name)}`; let n = 2;
      while (rows.some(row => row.id === id) || RESERVED_IDS.has(id)) id = `custom-${slug(config.name)}-${n++}`;
      const now = new Date().toISOString();
      const row: StoredServer = { ...config, id, enabled: body.enable === true, testStatus: "untested", statusMessage: null, tools: [], resourceCount: 0, version: null, testedAt: null, createdAt: now, updatedAt: now, approvedFingerprint: configFingerprint(config, this.#options.homeDir) };
      writeStore([...rows, row], this.#options.homeDir);
      return { status: 201, data: { item: this.#view(row), ...this.#list() } };
    }
    const match = /^mcp-servers\/(custom-[a-z0-9-]{1,40})(\/test)?$/.exec(path);
    if (!match) throw new McpApiError(405, "method_not_allowed", "Unsupported MCP server operation.");
    const index = rows.findIndex(row => row.id === match[1]);
    if (index < 0) throw new McpApiError(404, "unknown_server", "MCP server does not exist.");
    const previous = rows[index]!;
    if (match[2]) {
      if (method !== "POST") throw new McpApiError(405, "method_not_allowed", "Use POST to test.");
      const fingerprint = configFingerprint(previous, this.#options.homeDir);
      if (previous.approvedFingerprint !== fingerprint) throw new McpApiError(409, "approval_required", "Review and approve this configuration before testing it.", { approval: this.#approval(previous, "enable") });
      const started = Date.now();
      const redact = redactWith(secretsOf(previous));
      let result: McpTestResult;
      try {
        await this.#checkRemote(previous);
        result = await (this.#options.connector ?? defaultConnector)(launchFor(previous, this.#workspace()));
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
        const failed = { ...previous, testStatus: "error" as const, statusMessage: message, testedAt: new Date().toISOString() };
        writeStore(rows.map((row, i) => i === index ? failed : row), this.#options.homeDir);
        throw new McpApiError(409, "connection_failed", error instanceof McpApiError ? error.message : `Could not connect: ${message}`);
      }
      const tools = result.tools.slice(0, 512).map(tool => ({ name: redact(String(tool.name)).slice(0, 256), description: redact(String(tool.description ?? "")).slice(0, 4096) }));
      const resources = result.resources.slice(0, 512).map(res => ({ uri: redact(String(res.uri)).slice(0, 2048), name: redact(String(res.name)).slice(0, 256) }));
      const next: StoredServer = { ...previous, testStatus: "ok", statusMessage: null, tools, resourceCount: resources.length, version: result.version ? redact(result.version).slice(0, 64) : null, testedAt: new Date().toISOString() };
      writeStore(rows.map((row, i) => i === index ? next : row), this.#options.homeDir);
      return { data: { ok: true, toolCount: tools.length, resourceCount: resources.length, serverVersion: next.version, tools, resources, durationMs: Date.now() - started, item: this.#view(next) } };
    }
    if (method === "DELETE") {
      writeStore(rows.filter((_, i) => i !== index), this.#options.homeDir);
      return { data: this.#list() };
    }
    if (method !== "PATCH") throw new McpApiError(405, "method_not_allowed", "Unsupported MCP server operation.");
    const body = record(input, "request");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw bad("enabled must be a boolean.");
    const config = body.config === undefined ? (({ name, transport, command, args, cwd, env, url, headers }): Config => ({ name, transport, command, args, cwd, env, url, headers }))(previous) : normalizeMcpConfig(body.config, previous);
    const finalFingerprint = configFingerprint(config, this.#options.homeDir);
    const changed = finalFingerprint !== configFingerprint(previous, this.#options.homeDir);
    // Approval is verified against the FINAL merged config, computed here; the stored approval never counts.
    // A code-relevant change drops any carried-over enabled state: it only runs again after a fresh approval.
    const wantsEnabled = body.enabled === true || (body.enabled === undefined && previous.enabled && !changed);
    const needsApproval = changed || (wantsEnabled && (!previous.enabled || previous.approvedFingerprint !== finalFingerprint));
    if (needsApproval) {
      await this.#checkRemote(config);
      this.#requireApproval(config, changed ? "edit" : "enable", body.approvedFingerprint, body.approvedDangerousEnv);
    }
    const enabled = body.enabled === false ? false : wantsEnabled;
    const now = new Date().toISOString();
    const next: StoredServer = {
      ...previous, ...config, enabled, updatedAt: now,
      approvedFingerprint: needsApproval ? finalFingerprint : previous.approvedFingerprint,
      ...(changed ? { testStatus: "untested" as const, statusMessage: null, tools: [], resourceCount: 0, version: null, testedAt: null } : {}),
    };
    writeStore(rows.map((row, i) => i === index ? next : row), this.#options.homeDir);
    return { data: { item: this.#view(next), ...this.#list() } };
  }
  async handle(path: string, method: string, input: unknown): Promise<{ status: number; data: unknown } | null> {
    if (!/^mcp-servers(?:\/|$)/.test(path)) return null;
    const operation = async () => {
      try { const result = await this.#handle(path, method, input) as { status?: number; data: unknown }; return { status: result.status ?? 200, data: result.data }; }
      catch (error) {
        if (error instanceof McpApiError) return { status: error.status, data: { code: error.code, error: error.message, ...error.extra } };
        return { status: 500, data: { code: "configuration_unavailable", error: "MCP configuration could not be read or saved." } };
      }
    };
    const result = this.#pending.then(operation, operation);
    this.#pending = result;
    return result;
  }
}

/** Enabled and reviewed servers only. Fail-soft; one bad server never blocks a mission. */
export async function connectCustomMcpServers(existing: McpHost | undefined, workspaceRoot: string, options: { homeDir?: string } = {}): Promise<McpHost | undefined> {
  if (consoleExecutionProfile(options.homeDir) === "smolvm") return existing;
  let rows: StoredServer[];
  try { rows = readStore(options.homeDir); } catch { return existing; }
  const host = existing ?? new McpHost();
  for (const row of rows) {
    if (!row.enabled || host.hasServer(row.id)) continue;
    try { if (row.approvedFingerprint !== configFingerprint(row, options.homeDir)) continue; } catch { continue; }
    try {
      if (row.transport !== "stdio") await assertRemoteAllowed(row.url!);
      if (row.transport === "stdio") await host.connectStdio({ id: row.id, command: row.command!, args: row.args, cwd: resolveLaunchCwd(workspaceRoot, row.cwd), env: row.env });
      else await host.connectHttp({ id: row.id, url: row.url!, headers: row.headers, transport: row.transport });
    } catch { /* Surfaced by the operator Test action. */ }
  }
  if (host.serverIds().length) return host;
  if (!existing) await host.closeAll();
  return existing;
}
