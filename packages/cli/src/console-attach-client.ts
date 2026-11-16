/**
 * One transport for CLI commands that mirror the web console: the same /api/console route table,
 * the same request shape, the same authority.
 *
 * 1. Attach: a running local engine publishes a private descriptor; requests go through its HTTP API
 *    with the control token (never printed, never in argv), so a live process stays consistent and the
 *    server records the audit trail exactly as for the browser.
 * 2. Embed: with no live host, the transport-agnostic operator handlers run in process and the
 *    privileged action is written to the local audit log as actor "cli".
 *
 * Remote engines are not reachable through here: their bearer is browser-only denied for these routes.
 */
import { resolveOsecDbPath } from "@0/engine/storage";
import { connectLocalConsole } from "./local-engine.js";
import { WebOperatorServices } from "./web/operator-services.js";
import { GitHubPublicationAuth } from "./web/github-auth.js";
import { RepositoryCatalog, handleRepositoriesRequest } from "./web/repositories.js";
import { audit, configureAudit, describeConsoleAudit } from "./web/audit.js";

export interface ConsoleResult { status: number; data: any }
export interface ConsoleClient {
  mode: "attached" | "embedded";
  request(method: string, path: string, body?: unknown): Promise<ConsoleResult>;
  dispose(): Promise<void>;
}
export interface ConsoleClientOptions { dbPath?: string; homeDir?: string }
export interface ConsoleClientDeps { attach?: typeof connectLocalConsole }

const PREFIX = "/api/console/";

function embedded(options: ConsoleClientOptions): ConsoleClient {
  const operator = new WebOperatorServices({ allowChatGptPlan: true });
  let github: GitHubPublicationAuth | undefined;
  const githubAuth = () => (github ??= new GitHubPublicationAuth());
  let catalog: RepositoryCatalog | undefined;
  configureAudit(options.dbPath);
  return {
    mode: "embedded",
    async request(method, path, body) {
      if (!path.startsWith(PREFIX)) return { status: 404, data: { error: "Unknown route." } };
      const url = new URL(path, "http://local.invalid");
      const route = url.pathname.slice(PREFIX.length);
      let result: { status: number; data: unknown } | null = null;
      try {
        if (route === "github" && method === "GET") result = { status: 200, data: { github: await githubAuth().status() } };
        else if (route === "github/connect" && method === "POST") result = { status: 200, data: { github: await githubAuth().connect(body) } };
        else if (route === "repositories") {
          catalog ??= new RepositoryCatalog({ status: () => githubAuth().status() });
          result = await handleRepositoriesRequest(catalog, route, method, url.searchParams);
        } else result = await operator.handle(url.pathname, method, body, url.searchParams);
      } catch (error) {
        const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
        result = { status, data: { error: error instanceof Error ? error.message : "Request failed." } };
      }
      if (!result) return { status: 503, data: { error: "This needs a running 0 engine. Start one with `0 --headless`." } };
      const descriptor = describeConsoleAudit(route, method, body);
      if (descriptor && (result.status < 400 || result.status === 401 || result.status === 403)) {
        audit({ actor: "cli", action: descriptor.action, subject: descriptor.subject, outcome: result.status < 400 ? "ok" : "denied", detail: { ...descriptor.detail, status: result.status } });
      }
      return result as ConsoleResult;
    },
    async dispose() { operator.dispose(); await github?.dispose(); configureAudit(null); },
  };
}

export async function openConsoleClient(options: ConsoleClientOptions = {}, deps: ConsoleClientDeps = {}): Promise<ConsoleClient> {
  const attach = deps.attach ?? connectLocalConsole;
  const live = resolveOsecDbPath(options.dbPath) === ":memory:" ? null : await attach({ dbPath: options.dbPath, homeDir: options.homeDir });
  if (live) {
    return {
      mode: "attached",
      async request(method, path, body) {
        const response = await live.request(method, path, body);
        const text = response.status === 204 ? "" : await response.text();
        let data: unknown = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { error: `Engine returned an unreadable response (HTTP ${response.status}).` }; }
        return { status: response.status, data };
      },
      async dispose() { live.dispose(); },
    };
  }
  return embedded(options);
}
