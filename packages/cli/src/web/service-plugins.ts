import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homeStateDir, SERVICE_PLUGIN_CATALOG } from "@0/shared";
import { consoleExecutionProfile } from "../console-execution.js";

export interface ServicePluginConnection { id: string; enabled: boolean; fields: Record<string, string> }
interface StoredConnection extends ServicePluginConnection { tools: Array<{ name: string; description: string }>; testedAt: string }
export interface ServicePluginServicesOptions {
  homeDir?: string;
  probe?: (connection: ServicePluginConnection) => Promise<{ tools: Array<{ name: string; description: string }> }>;
}
class ServicePluginError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message = "Invalid plugin configuration.") => new ServicePluginError(400, "invalid_configuration", message);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function descriptor(id: string) {
  const plugin = SERVICE_PLUGIN_CATALOG.find((item) => item.id === id);
  if (!plugin) throw new ServicePluginError(404, "unknown_plugin", "Plugin does not exist.");
  return plugin;
}
function validateFields(id: string, value: unknown, previous: Record<string, string> = {}): Record<string, string> {
  const plugin = descriptor(id);
  const supplied = object(value);
  if (Object.keys(supplied).some((key) => !plugin.fields.some((field) => field.key === key))) throw invalid();
  const result: Record<string, string> = {};
  for (const field of plugin.fields) {
    const suppliedValue = supplied[field.key];
    const raw = (suppliedValue === undefined || (field.type === "secret" && suppliedValue === "")) && field.type === "secret" ? previous[field.key] : suppliedValue;
    if (raw === undefined || raw === "") { if (field.required) throw invalid(`Enter ${field.label}.`); continue; }
    if (typeof raw !== "string" || raw.length > 8192 || /[\x00-\x1f\x7f]/.test(raw)) throw invalid();
    const text = raw.trim();
    if (!text) { if (field.required) throw invalid(`Enter ${field.label}.`); continue; }
    if (field.type === "url") {
      let url: URL;
      try { url = new URL(text); } catch { throw invalid("Enter a valid service URL."); }
      if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw invalid("Use HTTPS, or localhost HTTP, without credentials or query parameters.");
      result[field.key] = url.href.replace(/\/$/, "");
    } else result[field.key] = text;
  }
  return result;
}
function assertRegular(path: string, directory = false): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unsafe plugin configuration path.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function readStore(homeDir?: string): StoredConnection[] {
  const directory = homeStateDir(homeDir);
  assertRegular(directory, true);
  const path = join(directory, "service-plugins.json");
  assertRegular(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid plugin configuration file.");
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!Array.isArray(raw)) throw new Error("Invalid plugin configuration file.");
    const ids = new Set<string>();
    return raw.map((value) => {
      const row = object(value);
      if (typeof row.id !== "string" || ids.has(row.id) || typeof row.enabled !== "boolean" || typeof row.testedAt !== "string" || row.testedAt.length > 64 || !Array.isArray(row.tools) || row.tools.length > 512) throw invalid();
      ids.add(row.id);
      const fields = validateFields(row.id, row.fields);
      const tools = row.tools.map((value) => { const tool = object(value); if (typeof tool.name !== "string" || tool.name.length > 256 || typeof tool.description !== "string" || tool.description.length > 16384) throw invalid(); return { name: tool.name, description: tool.description }; });
      return { id: row.id, enabled: row.enabled, fields, testedAt: row.testedAt, tools };
    });
  } finally { closeSync(fd); }
}
function saveStore(rows: StoredConnection[], homeDir?: string): void {
  const serialized = JSON.stringify(rows) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > 1_048_576) throw new Error("Plugin configuration is too large.");
  const directory = homeStateDir(homeDir);
  assertRegular(directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "service-plugins.json");
  assertRegular(path);
  const temporary = join(directory, `.service-plugins-${randomUUID()}.tmp`);
  try { writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
/** Private credentials are consumed by runtimes, never returned from the operator API. */
export function loadServicePluginConnections(homeDir?: string): ServicePluginConnection[] {
  return readStore(homeDir).map(({ id, enabled, fields }) => ({ id, enabled, fields }));
}

export class ServicePluginServices {
  readonly #options: ServicePluginServicesOptions;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(options: ServicePluginServicesOptions = {}) { this.#options = options; }
  #view() {
    const rows = readStore(this.#options.homeDir);
    const secrets = rows.flatMap((row) => descriptor(row.id).fields.filter((field) => field.type === "secret").map((field) => row.fields[field.key])).filter((value): value is string => Boolean(value));
    const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
    return { executionProfile: consoleExecutionProfile(), items: SERVICE_PLUGIN_CATALOG.map((plugin) => {
      const row = rows.find((item) => item.id === plugin.id);
      const values = Object.fromEntries(plugin.fields.filter((field) => field.type !== "secret").flatMap((field) => row?.fields[field.key] ? [[field.key, redact(row.fields[field.key])]] : []));
      const tools = row?.tools.map((tool) => ({ name: redact(tool.name), description: redact(tool.description) })) ?? [];
      return { ...plugin, configured: Boolean(row), enabled: row?.enabled ?? false, tools, values, testedAt: row?.testedAt ?? null };
    }) };
  }
  async #probe(connection: ServicePluginConnection) {
    try {
      const probe = this.#options.probe ?? (await import("@0/core")).testServicePluginConnection;
      const result = await probe(connection);
      if (!Array.isArray(result.tools) || result.tools.length > 512 || result.tools.some((tool) => typeof tool.name !== "string" || tool.name.length > 256 || typeof tool.description !== "string" || tool.description.length > 16384)) throw new Error("Invalid tool catalog.");
      // Descriptions are server-controlled and can contain echoed credentials.
      const configurations = [...readStore(this.#options.homeDir), connection];
      const secrets = configurations.flatMap((row) => descriptor(row.id).fields.filter((field) => field.type === "secret").map((field) => row.fields[field.key])).filter((value): value is string => Boolean(value));
      const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
      return { tools: result.tools.map(({ name, description }) => ({ name: redact(name), description: redact(description) })) };
    } catch { throw new ServicePluginError(409, "connection_failed", "Could not connect. Check the service URL and credentials."); }
  }
  async #handle(path: string, method: string, input: unknown) {
    if (path === "service-plugins" && method === "GET") return this.#view();
    const match = /^service-plugins\/([a-z0-9-]+)(\/connect)?$/.exec(path);
    if (!match) throw new ServicePluginError(405, "method_not_allowed", "Unsupported plugin operation.");
    const id = match[1]!; descriptor(id);
    const rows = readStore(this.#options.homeDir);
    const previous = rows.find((row) => row.id === id);
    let next: StoredConnection | undefined;
    if (match[2] && method === "POST") {
      const body = object(input);
      if (body.approved !== true) throw new ServicePluginError(400, "approval_required", "Confirm connecting this plugin.");
      const connection = { id, enabled: true, fields: validateFields(id, body.fields, previous?.fields) };
      const result = await this.#probe(connection);
      next = { ...connection, ...result, testedAt: new Date().toISOString() };
    } else if (!match[2] && method === "PATCH") {
      const body = object(input);
      if (typeof body.enabled !== "boolean") throw invalid();
      if (!previous) throw new ServicePluginError(409, "not_connected", "Connect this plugin first.");
      next = { ...previous, enabled: body.enabled };
      if (body.enabled) next = { ...next, ...await this.#probe(next), testedAt: new Date().toISOString() };
    } else if (!match[2] && method === "DELETE") { /* Forget credentials, preserving other plugins. */ }
    else throw new ServicePluginError(405, "method_not_allowed", "Unsupported plugin operation.");
    saveStore([...rows.filter((row) => row.id !== id), ...(next ? [next] : [])], this.#options.homeDir);
    return this.#view();
  }
  async handle(path: string, method: string, input: unknown): Promise<{ status: number; data: unknown } | null> {
    if (!/^service-plugins(?:\/|$)/.test(path)) return null;
    const operation = async () => {
      try { return { status: 200, data: await this.#handle(path, method, input) }; }
      catch (error) { return { status: error instanceof ServicePluginError ? error.status : 500, data: { code: error instanceof ServicePluginError ? error.code : "configuration_unavailable", error: error instanceof ServicePluginError ? error.message : "Plugin configuration could not be read or saved." } }; }
    };
    const result = this.#pending.then(operation, operation);
    this.#pending = result;
    return result;
  }
}
