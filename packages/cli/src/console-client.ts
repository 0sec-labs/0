import { Option, type Command } from "commander";
import { BackendIdSchema } from "@0/engine/shared";

/**
 * Thin client over the console API route table: the same `/api/console/...` calls the web UI makes.
 * It attaches to the running local host (private descriptor, control token), or to an explicit
 * `--engine-url`/`--computer`. Authority is identical to the web: the server applies its own
 * privileged-route and owner gates, so nothing here widens access.
 */
export class ConsoleRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ConsoleRequestError"; }
}
export interface ConsoleClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  dispose(): void;
}
export interface ConsoleTransportOptions {
  engineUrl?: string; engineTokenEnv?: string; computer?: string; computersConfig?: string; dbPath?: string;
}
interface Registry {
  request(id: string, path: string, options: { method: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  dispose(): void;
}

/** Transport flags shared by every console-backed noun command. */
export function consoleTransportOptions(command: Command): Command {
  return command
    .option("--engine-url <url>", "Attach directly to a running trusted engine")
    .option("--engine-token-env <name>", "Environment variable holding the attached engine token")
    .option("--computer <id>", "Use a registered remote computer")
    .addOption(new Option("--engine <id>").hideHelp().argParser(value => value))
    .option("--computers-config <path>", "Operator computer connection registry JSON file")
    .addOption(new Option("--engines-config <path>").hideHelp())
    .option("--db-path <path>", "Control database of the local engine to attach to");
}
/** Fold hidden legacy spellings into the documented names. */
export function normalizeTransport<T extends ConsoleTransportOptions & { engine?: string; enginesConfig?: string }>(options: T): T {
  return { ...options, computer: options.computer ?? options.engine, computersConfig: options.computersConfig ?? options.enginesConfig };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  try { value = text ? JSON.parse(text) : null; }
  catch { throw new ConsoleRequestError(`The engine returned invalid JSON (HTTP ${response.status}).`, response.status); }
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value ? (value as { error: unknown }).error : undefined;
    throw new ConsoleRequestError(typeof error === "string" ? error.slice(0, 2048) : `The engine rejected the request (HTTP ${response.status}).`, response.status);
  }
  return value;
}

export interface OpenConsoleDeps {
  connectLocal?(options: { dbPath?: string }): Promise<{ registry: Registry; backendId: string } | null>;
  homeDir?: string;
}
export async function openConsole(raw: ConsoleTransportOptions, deps: OpenConsoleDeps = {}): Promise<ConsoleClient> {
  const options = normalizeTransport(raw);
  if (options.engineTokenEnv && !options.engineUrl) throw new Error("--engine-token-env requires --engine-url.");
  if (options.engineUrl && (options.computer || options.computersConfig)) throw new Error("--engine-url cannot be combined with --computer.");
  if (options.computersConfig && !options.computer) throw new Error("--computers-config requires --computer.");
  let registry: Registry; let backendId: string;
  if (options.engineUrl) {
    if (!options.engineTokenEnv) throw new Error("Direct attachment requires both --engine-url and --engine-token-env.");
    backendId = "attached-engine";
    const { BackendConnectionRegistry } = await import("./web/backend-connections.js");
    registry = new BackendConnectionRegistry({ connections: [{ id: backendId, name: "Attached engine", url: options.engineUrl, bearerTokenEnv: options.engineTokenEnv }] });
  } else if (options.computer) {
    backendId = BackendIdSchema.parse(options.computer);
    const { BackendConnectionRegistry } = await import("./web/backend-connections.js");
    registry = new BackendConnectionRegistry({ configPath: options.computersConfig });
  } else {
    const connect = deps.connectLocal ?? (async (o: { dbPath?: string }) => (await import("./local-engine.js")).connectLocalConsoleRegistry({ ...o, homeDir: deps.homeDir }));
    const local = await connect({ dbPath: options.dbPath });
    if (!local) throw new Error("No console running. Start one with: 0 web --headless (or pass --engine-url or --computer).");
    ({ registry, backendId } = local);
  }
  const abort = new AbortController();
  return {
    async request(method, path, body) {
      return readBody(await registry.request(backendId, path, { method, ...(body === undefined ? {} : { body }), signal: abort.signal, timeoutMs: 30_000 }));
    },
    dispose() { abort.abort(); registry.dispose(); },
  };
}
