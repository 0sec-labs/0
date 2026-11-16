import { resolve } from "node:path";
import { discoverLocalEngine, assertLocalEngineAvailable } from "./local-engine.js";

/**
 * One way for noun commands to reach the same /api/console route table the web UI uses.
 *
 * Attach first: a running local host (descriptor in ~/.0/engines) is called over loopback with its control
 * token, so authorisation, validation and audit match the browser. Otherwise embed the route handler in
 * process against the same database; routes that need a live host (launching missions, schedules) say so.
 * The token is never printed or placed in argv.
 */
export class ConsoleRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface ConsoleClient {
  readonly mode: "attached" | "embedded";
  /** `path` is the full console path, e.g. `/api/console/sentinels?status=active`. Throws ConsoleRequestError on HTTP >= 400. */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface ConsoleClientOptions {
  dbPath?: string;
  homeDir?: string;
  /** Set when the route only works against a running host; embedding is refused with this feature name. */
  requireHost?: string;
}

interface Embedded { handle(pathname: string, method: string, input: unknown, query: URLSearchParams): Promise<{ status: number; data: unknown } | null>; dispose(): Promise<void> }

const LOOPBACK_TIMEOUT_MS = 30_000;

function failure(status: number, data: unknown): ConsoleRequestError {
  const error = data && typeof data === "object" && "error" in data ? (data as { error: unknown }).error : undefined;
  return new ConsoleRequestError(typeof error === "string" && error ? error : `Request failed (HTTP ${status}).`, status);
}

function attach(descriptor: NonNullable<ReturnType<typeof discoverLocalEngine>>, fetchImpl: typeof fetch): ConsoleClient {
  return {
    mode: "attached",
    async request(method, path, body) {
      let response: Response;
      try {
        response = await fetchImpl(new URL(`.${path}`, descriptor.url), {
          method, redirect: "error", signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${descriptor.token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        throw new ConsoleRequestError(`The running local engine could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
      const pinned = response.headers.get("x-0-engine-id");
      if (pinned !== null && pinned !== descriptor.engineId) throw new ConsoleRequestError("Response identity does not match the registered local engine.", 409);
      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { if (response.ok) throw new ConsoleRequestError("The local engine returned invalid JSON.", 502); }
      if (!response.ok) throw failure(response.status, data);
      return data;
    },
    dispose: async () => {},
  };
}

/** Embedded services are built on first use so a Sentinel read never opens the mission gateway. */
function embed(options: ConsoleClientOptions): ConsoleClient {
  const services = new Map<string, Promise<Embedded>>();
  const build = async (kind: "workflows" | "sentinels"): Promise<Embedded> => {
    if (kind === "workflows") {
      const { ConsoleGateway } = await import("./web/console-gateway.js");
      const { WebWorkflowService } = await import("./web/workflows.js");
      const gateway = new ConsoleGateway({ projectPath: resolve(process.cwd()), dbPath: options.dbPath, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
      // Recovery would mark executions of a host that is already gone; an offline edit must not rewrite history.
      const workflows = new WebWorkflowService({ gateway, dbPath: options.dbPath, recoverInterrupted: false });
      return { handle: (p, m, i, q) => workflows.handle(p, m, i, q), dispose: async () => { try { await workflows.dispose(); } finally { await gateway.closeAll(); } } };
    }
    const { WebSentinelService } = await import("./web/sentinels.js");
    const offline = (): never => { throw new ConsoleRequestError("Agents are only available while the engine is running. Start it with `0 --headless`.", 409); };
    const sentinels = new WebSentinelService({ dbPath: options.dbPath, missions: { create: offline, send: async () => offline(), pendingDecisions: () => 0 } });
    return { handle: (p, m, i, q) => sentinels.handle(p, m, i, q), dispose: () => sentinels.dispose() };
  };
  const service = (kind: "workflows" | "sentinels") => { let found = services.get(kind); if (!found) { found = build(kind); services.set(kind, found); } return found; };
  return {
    mode: "embedded",
    async request(method, path, body) {
      const url = new URL(path, "http://embedded.invalid");
      const kind = /^\/api\/console\/sentinel(?:s|-presets)(?:\/|$)/.test(url.pathname) ? "sentinels"
        : /^\/api\/console\/workflow-(?:definitions|executions)(?:\/|$)/.test(url.pathname) ? "workflows" : undefined;
      if (!kind) throw new ConsoleRequestError("This action needs a running engine. Start it with `0 --headless`.", 409);
      const result = await (await service(kind)).handle(url.pathname, method, body, url.searchParams);
      if (!result) throw new ConsoleRequestError("Unknown route.", 404);
      if (result.status >= 400) throw failure(result.status, result.data);
      return result.data;
    },
    async dispose() {
      const open = [...services.values()];
      services.clear();
      for (const pending of open) await (await pending).dispose();
    },
  };
}

export async function openConsoleClient(options: ConsoleClientOptions = {}, deps: { fetch?: typeof fetch } = {}): Promise<ConsoleClient> {
  const descriptor = discoverLocalEngine(options);
  if (descriptor) return attach(descriptor, deps.fetch ?? fetch);
  if (options.requireHost) throw new ConsoleRequestError(`${options.requireHost} needs a running engine. Start it with \`0 --headless\`.`, 409);
  assertLocalEngineAvailable(options.dbPath, options.homeDir);
  return embed(options);
}
