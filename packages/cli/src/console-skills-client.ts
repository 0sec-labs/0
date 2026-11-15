/**
 * One way for a noun command to call the same route table the web UI uses.
 *
 * Attach first: when a local engine host owns the database, send the request to it with the
 * private descriptor's control token, so caches, locks and the audit trail stay the host's.
 * Otherwise embed: run the same route handlers in this process on the same files, then dispose.
 * A live descriptor whose host cannot be reached is an error, never a reason to start a second host.
 */
import { homeStateDir } from "@0/engine/shared";
import { findLiveLocalEngine } from "./local-engine.js";
import { SkillsStore, SkillsError } from "./web/skills.js";
import { SkillsCatalogService, handleSkillsCatalogRequest } from "./web/skills-catalog.js";
import { WebOperatorServices } from "./web/operator-services.js";
import { WebLearningService } from "./web/learning.js";

export interface ConsoleReply { status: number; data: unknown }
export interface ConsoleClient {
  readonly mode: "attached" | "embedded";
  request(method: string, path: string, body?: unknown): Promise<ConsoleReply>;
  dispose(): Promise<void>;
}
export interface ConsoleOptions { dbPath?: string; homeDir?: string; workspace?: string }
export interface ConsoleDependencies { fetch?: typeof fetch; timeoutMs?: number }

const MAX_BODY = 12 * 1024 * 1024;

async function attached(host: { url: string; token: string; engineId: string }, deps: ConsoleDependencies): Promise<ConsoleClient> {
  const doFetch = deps.fetch ?? fetch;
  return {
    mode: "attached",
    async request(method, path, body) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined && Buffer.byteLength(payload) > MAX_BODY) throw new Error("Request body is too large.");
      let response: Response;
      try {
        response = await doFetch(new URL(`.${path}`, host.url), {
          method, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000), ...(payload !== undefined ? { body: payload } : {}),
          headers: { Authorization: `Bearer ${host.token}`, Accept: "application/json", "X-0-Expected-Engine-ID": host.engineId, ...(payload !== undefined ? { "Content-Type": "application/json" } : {}) },
        });
      } catch { throw new Error("The running local engine could not be reached. Restart it; no replacement host was started."); }
      if (response.headers.get("x-0-engine-id") !== host.engineId) { await response.body?.cancel(); throw new Error("Response identity does not match the running local engine."); }
      const text = await response.text();
      let data: unknown = null;
      if (text) { try { data = JSON.parse(text); } catch { throw new Error(`Engine returned malformed JSON (HTTP ${response.status}).`); } }
      return { status: response.status, data };
    },
    dispose: async () => {},
  };
}

function embedded(options: ConsoleOptions): ConsoleClient {
  const stateDir = options.homeDir ? homeStateDir(options.homeDir) : homeStateDir();
  let skills: SkillsStore | undefined; let catalog: SkillsCatalogService | undefined;
  let operator: WebOperatorServices | undefined; let learning: WebLearningService | undefined; let definitions: { close(): void } | undefined;
  const skillStore = () => skills ??= new SkillsStore({ workspace: options.workspace ?? process.cwd(), stateDir });
  const skillRoutes = (method: string, path: string, body: unknown): ConsoleReply | null => {
    const match = /^\/api\/skills(?:\/(.*))?$/.exec(path); if (!match) return null;
    const store = skillStore(); const rest = match[1] ?? ""; const id = decodeURIComponent(rest);
    if (!rest && method === "GET") return { status: 200, data: store.list() };
    if (!rest && method === "POST") return { status: 201, data: { skill: store.create(body) } };
    if (rest === "import" && method === "POST") return { status: 201, data: { skill: store.import(body) } };
    if (rest === "mounts" && method === "POST") return { status: 201, data: { mount: store.mount(body) } };
    if (rest.startsWith("mounts/") && method === "DELETE") { store.unmount(decodeURIComponent(rest.slice(7))); return { status: 200, data: { ok: true } }; }
    if (rest.endsWith("/copy") && method === "POST") return { status: 201, data: { skill: store.copy(decodeURIComponent(rest.slice(0, -5)), body) } };
    if (rest.endsWith("/export") && method === "GET") return { status: 200, data: store.export(decodeURIComponent(rest.slice(0, -7))) };
    if (rest && method === "GET") return { status: 200, data: { skill: store.get(id) } };
    if (rest && method === "DELETE") return { status: 200, data: store.delete(id) };
    if (rest && method === "PUT") return { status: 200, data: { skill: store.update(id, body) } };
    return { status: 405, data: { error: "Method not allowed." } };
  };
  return {
    mode: "embedded",
    async request(method, pathWithQuery, body) {
      const url = new URL(pathWithQuery, "http://embedded.invalid");
      try {
        const direct = skillRoutes(method, url.pathname, body); if (direct) return direct;
        // The HTTP server routes on the decoded path; ids such as `memory:abc` arrive percent-encoded.
        const pathname = decodeURIComponent(url.pathname);
        if (pathname.startsWith("/api/console/skills/catalog")) {
          catalog ??= new SkillsCatalogService({ store: skillStore() });
          const result = await handleSkillsCatalogRequest(catalog, pathname.slice("/api/console/".length), method, body);
          if (result) return result;
        }
        if (pathname === "/api/console/learning" || pathname.startsWith("/api/console/learning/")) {
          if (!learning) {
            const { SecurityWorkflowStore } = await import("@0/engine/storage");
            const store = new SecurityWorkflowStore(options.dbPath); definitions = store; learning = new WebLearningService(store);
          }
          const result = await learning.handle(pathname, method, body, url.searchParams); if (result) return result;
        }
        operator ??= new WebOperatorServices({});
        const result = await operator.handle(pathname, method, body, url.searchParams); if (result) return result;
        return { status: 404, data: { error: "Route not found." } };
      } catch (error) {
        if (error instanceof SkillsError) return { status: error.statusCode, data: { error: error.message } };
        if (error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === "number") return { status: (error as unknown as { statusCode: number }).statusCode, data: { error: error.message } };
        throw error;
      }
    },
    async dispose() { operator?.dispose(); await learning?.dispose(); definitions?.close(); },
  };
}

export async function openConsole(options: ConsoleOptions = {}, deps: ConsoleDependencies = {}): Promise<ConsoleClient> {
  const workspace = options.workspace ?? process.cwd();
  const host = findLiveLocalEngine({ ...options, workspace });
  return host ? attached(host, deps) : embedded({ ...options, workspace });
}

/** Run `fn` against the console API and always release it. */
export async function withConsole<T>(options: ConsoleOptions, fn: (client: ConsoleClient) => Promise<T>, deps: ConsoleDependencies = {}): Promise<T> {
  const client = await openConsole(options, deps);
  try { return await fn(client); } finally { await client.dispose(); }
}
