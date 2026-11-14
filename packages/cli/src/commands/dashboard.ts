import { createServer, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { URL } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { z } from "zod";
import { BackendRequestIdSchema, BackendDescriptorSchema, ScanResumeRequestSchema } from "@0/shared";
import { exportReport, isReportExportFormat } from "@0/core";
import { ConsoleGateway } from "../web/console-gateway.js";
import { WebOperatorServices } from "../web/operator-services.js";
import { WebWorkflowService } from "../web/workflows.js";
import { WorkflowTriggerService } from "../web/workflow-triggers.js";
import { GitHubPublicationAuth } from "../web/github-auth.js";
import { findDashboardInstance } from "../web/dashboard-instance.js";
import { startManagedHostReconnect } from "../web/managed-host-reconnect.js";
import { LocalProviderSessions, LocalProviderSessionError } from "../web/local-provider-sessions.js";
import { handleRemoteProviderRelayRequest } from "../web/remote-provider-relay.js";
import { BackendConnectionRegistry, backendBearerFromEnv, createBackendHandshake, handleBackendConnectionRequest } from "../web/backend-connections.js";
import { WorkflowEngineService } from "../workflow-engine-service.js";
import { retainedScanSnapshot, retainedFindingSnapshot } from "../web/report-artifacts.js";
import { handleFindingImpactRequest } from "../web/finding-impact.js";
import { FindingsAccessError, FindingsAccessTokenStore, handleFindingsAccessTokenRequest } from "../web/findings-access-tokens.js";
import { FindingsReadApi, handleFindingsReadRequest } from "../web/findings-read-api.js";
import { engagementMarkdown } from "../web/engagement-report.js";
import { createWorkspaceServices } from "../web/workspace-services.js";
import { findTeamConfigPath, handleTeamSetupRequest, TeamSetupService } from "../web/team-setup.js";
import { TeamAuth, TeamAuthError } from "../web/team-auth.js";
import { CollaborationService } from "../web/collaboration.js";
import { authorizeTeamApi, handleTeamRequest, assertTeamConsoleMutation } from "../web/team-web.js";
import { handleTeamPresenceStream } from "../web/team-presence-stream.js";
import { homeStateDir } from "@0/shared";
import { assertLocalEngineAvailable, registerLocalEngine } from "../local-engine.js";
import { loadManagedWorker, validateWorkerOptions, type WorkerDeployResult } from "../worker-deploy.js";
import { discoverSshHosts } from "../worker-hosts.js";
import { WebRequestError, errorStatusCode, authorizeWebRequest, json, text, sendFile, readJson, requireControlToken, isLoopbackDashboardHost } from "../web/dashboard-http.js";
import { resolveDashboardAssetDir, resolveAssetPath } from "../web/dashboard-assets.js";
import { resolveCliEntrypoint } from "../web/dashboard-daemon.js";
import { handleWebConsoleApiRequest, handleApiRequest } from "../web/dashboard-api.js";

type DashboardOptions = {
  dbPath?: string;
  port?: string;
  host?: string;
  assetDir?: string;
  devUrl?: string;
  readyJson?: boolean;
  backendsConfig?: string;
  teamConfig?: string;
  engineTokenEnv?: string;
  engineWorkspace?: string;
  engineScope?: string;
  engineTarget?: string;
  engineAllowApply?: boolean;
  engineTimeCap?: string;
  engineCostCap?: string;
  // Commander 12 maps `--no-open` to `opts.open = false` (not `opts.noOpen = true`).
  // See: https://github.com/tj/commander.js/blob/master/Readme.md#other-option-types-negatable-boolean-and-booleanvalue
  open?: boolean;
};


function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("web")
    .description("Run the local browser console and operations workspace")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--port <port>", "Port to bind; 0 chooses a free loopback port", "48123")
    .option("--host <host>", "Loopback host to bind (127.0.0.0/8 or ::1)", "127.0.0.1")
    .option("--asset-dir <path>", "Path to built dashboard assets")
    .option("--dev-url <url>", "Loopback Vite server for authenticated frontend hot reload")
    .option("--backends-config <path>", "Trusted backend connection registry JSON (default ~/.0/backends.json)")
    .option("--team-config <path>", "Enable workspace accounts, roles, and shared conversation controls")
    .option("--engine-token-env <name>", "Environment variable holding the engine bearer credential (32–4096 characters)")
    .option("--engine-workspace <path>", "Engine-owned authorized workspace for persistent workflow calls")
    .option("--engine-scope <path>", "Engine-owned scope JSON for persistent live-target workflows")
    .option("--engine-target <target>", "Restrict persistent workflow calls to this target")
    .option("--engine-allow-apply", "Admit explicitly approved patch application in persistent workflow calls")
    .option("--engine-time-cap <ms>", "Server workflow deadline ceiling (default 600000 ms)")
    .option("--engine-cost-cap <usd>", "Server workflow estimated cost ceiling (default $5)")
    .option("--ready-json", "Emit the bound dashboard URL as machine-readable JSON")
    .option("--no-open", "Do not auto-open a browser")
    .action(async (opts: DashboardOptions) => {
      const host = opts.host?.trim() || "127.0.0.1";
      const port = parseInt(opts.port ?? "48123", 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${opts.port ?? "48123"}`);
      }
      if (!isLoopbackDashboardHost(host)) {
        throw new Error(
          "Dashboard only binds loopback addresses (127.0.0.0/8 or ::1). Use an SSH tunnel or an authenticated reverse proxy bound to local loopback for remote access.",
        );
      }
      let origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
      let devUrl: URL | undefined;
      if (opts.devUrl) {
        devUrl = new URL(opts.devUrl);
        const devHost = devUrl.hostname.replace(/^\[|\]$/g, "");
        if (devUrl.protocol !== "http:" || devUrl.username || devUrl.password || !isLoopbackDashboardHost(devHost)) {
          throw new Error("The frontend development server must use an HTTP loopback URL without credentials.");
        }
      }


      if (port !== 0 && !opts.dbPath && !opts.assetDir && !opts.devUrl && !opts.backendsConfig && !opts.engineTokenEnv && !opts.engineWorkspace && !opts.engineScope && !opts.engineTarget && !opts.engineAllowApply && !opts.engineTimeCap && !opts.engineCostCap && await findDashboardInstance(origin)) {
        console.log(chalk.gray(`  0 web is already running: ${origin}`));
        if (opts.readyJson) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url: origin })}`);
        if (opts.open !== false) openBrowser(`${origin}/console`);
        return;
      }

      const engineBearer = backendBearerFromEnv(opts.engineTokenEnv);
      const explicitTeamConfig = opts.teamConfig ?? process.env.ZERO_TEAM_CONFIG;
      const teamConfigPath = findTeamConfigPath({ workspacePath: opts.engineWorkspace ?? process.cwd(), explicitConfigPath: explicitTeamConfig });
      if (!engineBearer && !teamConfigPath && [opts.engineWorkspace, opts.engineScope, opts.engineTarget, opts.engineAllowApply, opts.engineTimeCap, opts.engineCostCap].some(value => value !== undefined && value !== false)) throw new Error("Engine admission options require --engine-token-env or --team-config.");
      const timeCapMs = opts.engineTimeCap === undefined ? 600_000 : Number(opts.engineTimeCap);
      const costCapUsd = opts.engineCostCap === undefined ? 5 : Number(opts.engineCostCap);
      if (!Number.isInteger(timeCapMs) || timeCapMs < 1 || timeCapMs > 86_400_000 || !Number.isFinite(costCapUsd) || costCapUsd <= 0 || costCapUsd > 1000) throw new Error("Engine limits must be positive, with time at most 86400000 ms and cost at most $1000.");
      const controlToken = randomUUID();
      let teamAuth = new TeamAuth({ configPath: teamConfigPath, origin });
      let teamDirectory = teamAuth.enabled ? join(homeStateDir(), "teams", createHash("sha256").update(teamAuth.workspaceId!).digest("hex")) : undefined;
      if (teamDirectory) { mkdirSync(teamDirectory, { recursive: true, mode: 0o700 }); if (!explicitTeamConfig) opts.dbPath = join(teamDirectory, "data.db"); else opts.dbPath ??= join(teamDirectory, "data.db"); }
      let collaboration = teamAuth.enabled ? new CollaborationService({ workspaceId: teamAuth.workspaceId!, stateDir: join(teamDirectory!, "collaboration"), resolveSession: sessionId => teamAuth.resolveSessionId(sessionId) }) : undefined;
      // Never recover another live host's database while opening a second UI.
      assertLocalEngineAvailable(opts.dbPath);
      const capabilities = ["sessions", "workflows", "schedules", "approvals", "events", "workspaces", "artifacts", "model-connections", "provider-relay", "operator-services", "process-controls", "learning", "workflow-engine"];
      let localHandshake = createBackendHandshake(opts.dbPath, capabilities);
      let backends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake });
      // Keep model frames independent of long-lived browser event subscriptions.
      let modelBackends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake });
      const modelRegistry = {
        handshake: (id: string) => { modelBackends.reload(); return modelBackends.handshake(id); },
        request: (...args: Parameters<BackendConnectionRegistry["request"]>) => { modelBackends.reload(); return modelBackends.request(...args); },
      };
      let localProviderSessions = new LocalProviderSessions({ registry: modelRegistry });
      const hostRepairs = new Map<string, Promise<unknown>>();
      const hostRepairAbort = new AbortController();
      const repairManagedHost = (backendId: string, signal?: AbortSignal): Promise<unknown> => {
        const pending = hostRepairs.get(backendId); if (pending) return pending;
        const compiled = import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("/$bunfs/");
        const args = [...(compiled ? [] : [resolveCliEntrypoint()]), "worker", "repair", backendId];
        const task = new Promise<unknown>((resolveRepair, reject) => {
          execFile(process.execPath, args, { timeout: 75_000, maxBuffer: 65_536, signal: signal ? AbortSignal.any([signal, hostRepairAbort.signal]) : hostRepairAbort.signal }, (error, stdout) => {
            if (error) { reject(new WebRequestError("This host could not reconnect. Check its SSH connection and managed engine installation.", 409)); return; }
            try { resolveRepair(JSON.parse(stdout)); } catch { reject(new WebRequestError("Host reconnect returned an invalid result.", 502)); }
          });
        }).finally(() => { hostRepairs.delete(backendId); });
        hostRepairs.set(backendId, task); return task;
      };
      let stopHostReconnect: (() => void) | undefined;
      const watchManagedHosts = () => startManagedHostReconnect({ getRegistry: () => backends, repair: repairManagedHost, onRecovered: async id => { backends.reload(); await backends.handshake(id); } });
      let engine: WorkflowEngineService | undefined;
      let startupGateway: ConsoleGateway | undefined;
      let startupOperator: WebOperatorServices | undefined;
      let startupWorkflows: WebWorkflowService | undefined;
      let startupTriggers: WorkflowTriggerService | undefined;
      let startupGitHub: GitHubPublicationAuth | undefined;
      let startupAssetCleanup: (() => void) | undefined;
      try {
        const { path: assetDir, cleanup: cleanupAssetDir } = resolveDashboardAssetDir(import.meta.url, opts.assetDir);
        startupAssetCleanup = cleanupAssetDir;
        const buildServices = (auth: TeamAuth, dbPath = opts.dbPath, stateDir = teamDirectory, relayEpoch = localHandshake.serverInstanceId) => createWorkspaceServices({ relayEpoch, auth, dbPath, stateDir, workspace: opts.engineWorkspace, scopePath: opts.engineScope, target: opts.engineTarget, allowApply: opts.engineAllowApply, controlToken, engineBearer, timeCapMs, costCapUsd });
        let services = await buildServices(teamAuth);
        stopHostReconnect = watchManagedHosts();
        let { skills, gateway: consoleGateway, engagements, operator, workflows, triggers, github } = services;
        engine = services.engine;
        startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupTriggers = triggers; startupGitHub = github;
        let findingsAccess = new FindingsAccessTokenStore({ workspaceId: teamAuth.workspaceId ?? localHandshake.engineId, stateDir: join(teamDirectory ?? homeStateDir(), "findings-api-access") });
        let findingsRead = new FindingsReadApi({ workspaceId: teamAuth.workspaceId ?? localHandshake.engineId, dbPath: opts.dbPath });
        const activeResponses = new Set<ServerResponse>();
        let setupResponse: ServerResponse | undefined;
        const setup = new TeamSetupService({ workspacePath: opts.engineWorkspace ?? process.cwd(), configPath: teamConfigPath, origin: () => origin, currentAuth: () => teamAuth,
          activate: async prepared => {
            if (consoleGateway.hasActiveTurns() || workflows.hasActiveWork()) throw new TeamAuthError("Finish active work before creating a team workspace.", 409);
            const nextHandshake = createBackendHandshake(prepared.dbPath, capabilities);
            const next = await buildServices(prepared.auth, prepared.dbPath, prepared.stateDir, nextHandshake.serverInstanceId);
            let nextBackends: BackendConnectionRegistry | undefined;
            let nextUnregister: (() => void) | undefined;
            try {
              nextBackends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake: nextHandshake });
              const nextAccess = new FindingsAccessTokenStore({ workspaceId: prepared.workspaceId, stateDir: join(prepared.stateDir, "findings-api-access") });
              const nextRead = new FindingsReadApi({ workspaceId: prepared.workspaceId, dbPath: prepared.dbPath });
              const nextCollaboration = new CollaborationService({ workspaceId: prepared.workspaceId, stateDir: join(prepared.stateDir, "collaboration"), resolveSession: sessionId => prepared.auth.resolveSessionId(sessionId) });
              nextUnregister = registerLocalEngine({ url: origin, token: controlToken, engineId: nextHandshake.engineId, serverInstanceId: nextHandshake.serverInstanceId!, pid: process.pid, workspace: opts.engineWorkspace ?? process.cwd() }, prepared.dbPath);
              if (consoleGateway.hasActiveTurns() || workflows.hasActiveWork()) throw new TeamAuthError("Finish active work before creating a team workspace.", 409);
              await services.dispose();
              for (const response of activeResponses) if (response !== setupResponse) response.end();
              stopHostReconnect?.();
              await localProviderSessions.dispose();
              modelBackends.dispose(); backends.dispose(); unregisterLocalEngine?.();
              services = next; teamAuth = prepared.auth; teamDirectory = prepared.stateDir; opts.dbPath = prepared.dbPath; collaboration = nextCollaboration; localHandshake = nextHandshake; backends = nextBackends; modelBackends = new BackendConnectionRegistry({ configPath: opts.backendsConfig, localHandshake: nextHandshake }); localProviderSessions = new LocalProviderSessions({ registry: modelRegistry }); unregisterLocalEngine = nextUnregister;
              ({ skills, gateway: consoleGateway, engagements, operator, workflows, triggers, github } = next); engine = next.engine; findingsAccess = nextAccess; findingsRead = nextRead;
              startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupTriggers = triggers; startupGitHub = github;
              stopHostReconnect = watchManagedHosts();
            } catch (cause) { nextBackends?.dispose(); nextUnregister?.(); await next.dispose().catch(() => {}); throw cause; }
          },
        });

        const server = createServer(async (req, res) => {
          activeResponses.add(res); const releaseResponse = () => activeResponses.delete(res); res.once("close", releaseResponse); res.once("finish", releaseResponse);
          try { authorizeWebRequest(req, origin); }
          catch (error) {
            json(res, error instanceof WebRequestError ? error.statusCode : 403, { error: error instanceof Error ? error.message : "Invalid request origin." });
            return;
          }
          let requestUrl = new URL(req.url ?? "/", origin);
          const requestId = BackendRequestIdSchema.safeParse(req.headers["x-0-request-id"]);
          res.setHeader("X-0-Request-ID", requestId.success ? requestId.data : randomUUID());

          try {
            if (requestUrl.pathname.startsWith("/api/")) {
              const findingsCredential = findingsAccess.authenticate(req, requestUrl);
              if (requestUrl.pathname === "/api/v1/findings" || requestUrl.pathname.startsWith("/api/v1/findings/")) {
                if (setup.status().pending) throw new WebRequestError("Workspace setup is in progress. Try again shortly.", 503);
                if (!findingsCredential) throw new FindingsAccessError("A findings API key is required in the Authorization header.", 401);
                const reply = handleFindingsReadRequest(req, requestUrl, findingsRead);
                if (!reply) throw new FindingsAccessError("Findings API route was not found.", 404);
                json(res, reply.status, reply.data); return;
              }
              const ssoNavigation = requestUrl.pathname === "/api/team/auth/sso" || requestUrl.pathname === "/api/team/auth/callback";
              if (!(ssoNavigation && req.method === "GET") && !requireControlToken(req, res, controlToken, engineBearer)) return;
              if (requestUrl.pathname === "/api/team/setup" || requestUrl.pathname === "/api/team/users") {
                if (requestUrl.pathname === "/api/team/setup" && req.method === "POST" && !setup.status().pending) setupResponse = res;
                try {
                  const reply = await handleTeamSetupRequest(req, requestUrl, setup, () => readJson(req));
                  if (reply) { for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value); json(res, reply.status, reply.data); return; }
                } finally { if (setupResponse === res) setupResponse = undefined; }
              }
              if (setup.status().pending && requestUrl.pathname !== "/api/team/session") throw new WebRequestError("Workspace setup is in progress. Try again shortly.", 503);
              if (handleTeamPresenceStream(req, res, requestUrl, teamAuth, collaboration)) return;
              const teamReply = await handleTeamRequest(req, requestUrl, teamAuth, collaboration, consoleGateway, () => readJson(req), async (kind, id) => {
                if (kind === "report") { engagements.get(id); return; }
                const definition = await workflows.handle(`/api/console/workflow-definitions/${encodeURIComponent(id)}`, "GET", undefined, new URLSearchParams());
                if (!definition || definition.status !== 200) throw new WebRequestError("Workflow was not found.", 404);
              });
              if (teamReply) {
                for (const [name, value] of Object.entries(teamReply.headers ?? {})) res.setHeader(name, value);
                if (teamReply.redirect) { res.writeHead(teamReply.status, { Location: teamReply.redirect, "Cache-Control": "no-store" }); res.end(); }
                else json(res, teamReply.status, teamReply.data);
                return;
              }
              const bearer = req.headers.authorization;
              const engineRequest = Boolean(engineBearer && typeof bearer === "string" && bearer.startsWith("Bearer ") && Buffer.byteLength(bearer.slice(7)) === Buffer.byteLength(engineBearer) && timingSafeEqual(Buffer.from(bearer.slice(7)), Buffer.from(engineBearer)));
              if (!engineRequest) authorizeTeamApi(teamAuth, req, requestUrl.pathname);
              res.setHeader("X-0-Engine-ID", localHandshake.engineId);
              const expectedEngineId = req.headers["x-0-expected-engine-id"];
              if (expectedEngineId !== undefined && expectedEngineId !== localHandshake.engineId) throw new WebRequestError("Request belongs to a different engine identity.", 409);
              const findingsAccessReply = await handleFindingsAccessTokenRequest(req, requestUrl, teamAuth, findingsAccess, () => readJson(req));
              if (findingsAccessReply) { json(res, findingsAccessReply.status, findingsAccessReply.data); return; }
              const remoteSessionRoute = /^\/api\/console\/remote-sessions(?:\/([^/]+)\/(configuration|status))?$/.exec(requestUrl.pathname);
              if (remoteSessionRoute) {
                const ownerId = engineRequest ? "engine" : teamAuth.resolveSession(req)?.userId ?? "local";
                try {
                  if (remoteSessionRoute[1] && remoteSessionRoute[2] === "status" && req.method === "GET") {
                    const backendId = BackendDescriptorSchema.shape.id.parse(requestUrl.searchParams.get("backendId"));
                    json(res, 200, await localProviderSessions.status(backendId, decodeURIComponent(remoteSessionRoute[1]), ownerId));
                  } else if (!remoteSessionRoute[1] && req.method === "POST") {
                    const body = z.object({ backendId: z.string().min(1).max(128), configuration: z.unknown() }).strict().parse(await readJson(req));
                    json(res, 201, await localProviderSessions.create(body.backendId, body.configuration, ownerId));
                  } else if (remoteSessionRoute[1] && remoteSessionRoute[2] === "configuration" && req.method === "PATCH") {
                    const body = z.object({ backendId: z.string().min(1).max(128), runtime: z.unknown() }).strict().parse(await readJson(req));
                    json(res, 200, await localProviderSessions.configure(body.backendId, decodeURIComponent(remoteSessionRoute[1]), body.runtime, ownerId));
                  } else throw new WebRequestError("Method not allowed.", 405);
                } catch (error) {
                  if (error instanceof LocalProviderSessionError) { json(res, error.statusCode, { error: error.message }); return; }
                  throw error;
                }
                return;
              }
              if (requestUrl.pathname === "/api/console/provider-relays" || requestUrl.pathname.startsWith("/api/console/provider-relays/")) {
                if (!engineRequest) throw new WebRequestError("Provider relay transport requires an authenticated engine connection.", 403);
                if (await handleRemoteProviderRelayRequest(req, res, requestUrl, services.remoteProviderRelays, () => readJson(req))) return;
              }
              const backendRoute = await handleBackendConnectionRequest(req, res, requestUrl, backends, (backendId, sessionId) => localProviderSessions.release(backendId, sessionId, engineRequest ? "engine" : teamAuth.resolveSession(req)?.userId ?? "local"));
              if (backendRoute.handled) { modelBackends.reload(); return; }
              if (backendRoute.localPath) requestUrl = new URL(backendRoute.localPath, origin);
              const skillsRoute = requestUrl.pathname.match(/^\/api\/skills(?:\/(.*))?$/);
              if (skillsRoute) {
                const member = teamAuth.resolveSession(req);
                const access = { allowHostEdits: !teamAuth.enabled || engineRequest || member?.role === "owner", canWrite: !teamAuth.enabled || engineRequest || member?.role !== "viewer" };
                const path = skillsRoute[1] ?? "";
                let decodedPath: string;
                try { decodedPath = decodeURIComponent(path); } catch { throw new WebRequestError("Invalid skill identifier.", 400); }
                const method = req.method ?? "GET";
                if (!path && method === "GET") json(res, 200, skills.list(access));
                else if (!path && method === "POST") json(res, 201, { skill: skills.create(await readJson(req)) });
                else if (path === "import" && method === "POST") json(res, 201, { skill: skills.import(await readJson(req, 12 * 1024 * 1024)) });
                else if (path === "mounts" && method === "POST") json(res, 201, { mount: skills.mount(await readJson(req)) });
                else if (path.startsWith("mounts/") && method === "DELETE") { skills.unmount(decodedPath.slice(7)); json(res, 200, { ok: true }); }
                else if (path.endsWith("/copy") && method === "POST") json(res, 201, { skill: skills.copy(decodedPath.slice(0, -5), await readJson(req), access) });
                else if (path.endsWith("/export") && method === "GET") {
                  const id = decodedPath.slice(0, -7); const bundle = skills.export(id);
                  res.setHeader("Content-Disposition", `attachment; filename="${bundle.name}.skill.json"`); json(res, 200, bundle);
                }
                else if (path && method === "GET") json(res, 200, { skill: skills.get(decodedPath, access) });
                else if (path && method === "PUT") json(res, 200, { skill: skills.update(decodedPath, await readJson(req), access) });
                else throw new WebRequestError("Method not allowed.", 405);
                return;
              }
              const engagementRoute = requestUrl.pathname.match(/^\/api\/engagements(?:\/([^/]+)(?:\/(report))?)?$/);
              if (engagementRoute) {
                const member = teamAuth.resolveSession(req);
                const engagementActor = member ? { userId: member.userId, displayName: member.displayName } : undefined;
                const id = engagementRoute[1] ? decodeURIComponent(engagementRoute[1]) : undefined;
                if (engagementRoute[2]) {
                  if (req.method !== "GET") throw new WebRequestError("Use GET to read an engagement report.", 405);
                  const format = requestUrl.searchParams.get("format") ?? "json";
                  if (format !== "json" && format !== "markdown") throw new WebRequestError("Use json or markdown for an engagement report.", 400);
                  const report = engagements.report(id!);
                  if (format === "json") { res.setHeader("Content-Disposition", `attachment; filename="engagement-${id}.json"`); json(res, 200, report); }
                  else { res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="engagement-${id}.md"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(engagementMarkdown(report)); }
                } else if (req.method === "GET") json(res, 200, id ? { engagement: engagements.get(id) } : { engagements: engagements.list() });
                else if (req.method === "POST" && !id) {
                  const engagement = engagements.create(await readJson(req), engagementActor);
                  collaboration?.notifyChanged("report", engagement.id);
                  json(res, 201, { engagement });
                }
                else if (req.method === "PATCH" && id) {
                  const engagement = engagements.update(id, await readJson(req), engagementActor);
                  collaboration?.notifyChanged("report", engagement.id);
                  json(res, 200, { engagement });
                }
                else throw new WebRequestError("Method not allowed.", 405);
                return;
              }
              if (requestUrl.pathname === "/api/workers/hosts") {
                if (req.method !== "GET") throw new WebRequestError("Method not allowed.", 405);
                json(res, 200, { hosts: discoverSshHosts() });
                return;
              }
              if (requestUrl.pathname === "/api/workers/managed") {
                if (req.method !== "GET") throw new WebRequestError("Method not allowed.", 405);
                const workers = backends.list().flatMap(backend => {
                  try { loadManagedWorker(backend.id); return [{ backendId: backend.id }]; } catch { return []; }
                });
                json(res, 200, { workers });
                return;
              }
              if (requestUrl.pathname === "/api/control/repair-worker") {
                if (req.method !== "POST") throw new WebRequestError("Use POST to reconnect a host.", 405);
                const body = z.object({ backendId: BackendDescriptorSchema.shape.id }).strict().parse(await readJson(req));
                const repaired = await repairManagedHost(body.backendId);
                backends.reload(); json(res, 200, repaired);
                return;
              }
              const workerStop = requestUrl.pathname.match(/^\/api\/workers\/([^/]+)\/stop$/);
              if (workerStop) {
                if (req.method !== "POST") throw new WebRequestError("Use POST to stop a worker.", 405);
                const backendId = BackendDescriptorSchema.shape.id.parse(decodeURIComponent(workerStop[1]!));
                const compiledBinary = import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("/$bunfs/");
                const args = [...(compiledBinary ? [] : [resolveCliEntrypoint()]), "worker", "stop", backendId];
                const result = await new Promise<unknown>((resolveStop, reject) => {
                  // foxguard: ignore[js/no-command-injection] process.execPath and the CLI entrypoint are trusted; backendId is schema-validated and execFile never invokes a shell.
                  execFile(process.execPath, args, { timeout: 60_000, maxBuffer: 65_536 }, (error, stdout, stderr) => { // foxguard: ignore[js/no-command-injection]
                    if (error) { reject(new WebRequestError(stderr.includes("no managed deployment metadata") ? "This connection has no managed deployment metadata. Stop its engine directly on the host." : "Worker could not be stopped safely. Check the host connection and managed engine PID.", 409)); return; }
                    try { resolveStop(JSON.parse(stdout)); } catch { reject(new WebRequestError("Worker stop returned an invalid result.", 502)); }
                  });
                });
                json(res, 200, result);
                return;
              }
              if (requestUrl.pathname === "/api/workers/deploy") {
                if (req.method !== "POST") throw new WebRequestError("Use POST to deploy a worker.", 405);
                const body = z.object({
                  ssh: z.string().trim().min(1).max(512).optional(),
                  lima: z.string().trim().min(1).max(128).optional(),
                  targetGit: z.string().trim().max(4096).optional(),
                  forwardProviderKey: z.boolean().optional(),
                  enginePort: z.number().int().min(1).max(65535).optional(),
                }).strict().parse(await readJson(req));
                validateWorkerOptions(body);
                const compiledBinary = import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("/$bunfs/");
                const args = [...(compiledBinary ? [] : [resolveCliEntrypoint()]), "worker", "deploy", ...(body.ssh ? ["--ssh", body.ssh] : ["--lima", body.lima ?? "zero-worker"]), ...(body.targetGit ? ["--target-git", body.targetGit] : []), ...(body.enginePort ? ["--engine-port", String(body.enginePort)] : []), ...(body.forwardProviderKey ? ["--forward-provider-key"] : []), ...(opts.backendsConfig ? ["--backends-config", opts.backendsConfig] : [])];
                const result = await new Promise<WorkerDeployResult>((resolveDeploy, reject) => {
                  // foxguard: ignore[js/no-command-injection] all request values are strict-schema validated and passed as execFile argv without a shell.
                  execFile(process.execPath, args, { timeout: 3_600_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => { // foxguard: ignore[js/no-command-injection]
                    if (error && stderr.includes("Worker deployment requires the built CLI")) { reject(new WebRequestError("Worker deployment needs the npm or repository build with dist/ and vendor/ assets. Install with npm install -g 0sec-cli, or run pnpm build from the repository.", 422)); return; }
                    if (error) { reject(new WebRequestError("Worker deployment failed. Check SSH access and the worker's installation requirements.", 502)); return; }
                    try { resolveDeploy(JSON.parse(stdout)); } catch { reject(new WebRequestError("Worker deployment returned an invalid result.", 502)); }
                  });
                });
                backends.reload();
                json(res, 202, result);
                return;
              }
              if (requestUrl.pathname === "/api/control/launch-run") {
                if (req.method !== "POST") throw new WebRequestError("Use POST to launch a run.", 405);
                const body = z.object({ target: z.string().trim().min(1).max(4096), depth: z.enum(["quick", "default", "deep"]).optional(), runtime: z.enum(["api", "auto"]).optional(), mode: z.enum(["deep", "web"]).optional(), ensureDaemon: z.boolean().optional() }).strict().parse(await readJson(req));
                if (body.runtime !== undefined || body.mode !== undefined) throw new WebRequestError("The selected engine owns its model and assessment execution. Submit a target and depth, or use a workflow for specialized execution.", 400);
                if (body.ensureDaemon) throw new WebRequestError("Engine runs do not require a separate orchestration daemon. Configure a workflow schedule for recurring work.", 400);
                const session = await engine!.invoke("create_session", { config: { target: body.target, title: `Assessment: ${body.target}` } }) as { id: string };
                const execution = await engine!.invoke("start_assessment", { sessionId: session.id, target: body.target, plan: { goal: "unknown-vulnerabilities", depth: body.depth ?? "default", runCount: 1, executionMode: "sequential", timeCapMs, costCapUsd } }) as { id: string; jobId?: string };
                json(res, 202, { ok: true, engineOwned: true, sessionId: session.id, runId: execution.id, jobId: execution.jobId });
                return;
              }
              const workRecord = requestUrl.pathname.match(/^\/api\/work\/([^/]+)$/);
              if (requestUrl.pathname === "/api/work" || workRecord) {
                if (req.method !== "GET") throw new WebRequestError("Use GET to inspect work history.", 405);
                if (!engine) throw new WebRequestError("This engine does not expose work history.", 403);
                try {
                  json(res, 200, await engine.invoke(workRecord ? "get_work" : "list_work", workRecord ? { workId: decodeURIComponent(workRecord[1]!) } : {}));
                } catch (error) {
                  if (error instanceof Error && error.message === "Work record was not found in this engine.") throw new WebRequestError(error.message, 404);
                  throw error;
                }
                return;
              }
              if (requestUrl.pathname === "/api/workflow-engine/call") {
                if (!engine) throw new WebRequestError("This engine does not admit persistent workflow calls.", 403);
                if (req.method !== "POST") throw new WebRequestError("Method not allowed.", 405);
                const input = z.object({ name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()) }).strict().parse(await readJson(req));
                if (!engineRequest && typeof input.args.sessionId === "string") assertTeamConsoleMutation(req, input.args.sessionId, teamAuth, collaboration, consoleGateway);
                json(res, 200, await engine.invoke(input.name, input.args));
                return;
              }
              const resumeScan = requestUrl.pathname.match(/^\/api\/scans\/([^/]+)\/resume$/);
              if (resumeScan) {
                if (req.method !== "POST") throw new WebRequestError("Use POST to resume a scan.", 405);
                const request = ScanResumeRequestSchema.parse(await readJson(req));
                const result = await workflows.resumeScan(decodeURIComponent(resumeScan[1]!), { ...request, timeCapMs: Math.min(request.timeCapMs ?? timeCapMs, timeCapMs), costCapUsd: Math.min(request.costCapUsd ?? costCapUsd, costCapUsd) });
                json(res, result.status, result.data);
                return;
              }
              if (/^\/api\/findings\/[^/]+\/impact-assessment$/.test(requestUrl.pathname)) {
                const input = req.method === "POST" || req.method === "DELETE" ? await readJson(req) : undefined;
                const result = handleFindingImpactRequest(requestUrl.pathname, req.method ?? "GET", input, { dbPath: opts.dbPath });
                if (result) { json(res, result.status, result.data); return; }
              }
              const exportScan = requestUrl.pathname.match(/^\/api\/scans\/([^/]+)\/export$/);
              if (exportScan || requestUrl.pathname === "/api/findings/export") {
                if (req.method !== "GET") throw new WebRequestError("Use GET to export a report.", 405);
                const requestedFormat = requestUrl.searchParams.get("format") ?? "json";
                const format = requestedFormat === "md" ? "markdown" : requestedFormat;
                if (!isReportExportFormat(format)) throw new WebRequestError("Unsupported report export format.", 400);
                const report = exportScan
                  ? retainedScanSnapshot(decodeURIComponent(exportScan[1]!), engine?.resolveScanDatabase(decodeURIComponent(exportScan[1]!)) ?? opts.dbPath, workflows.retainedScanReport(decodeURIComponent(exportScan[1]!)))
                  : retainedFindingSnapshot((requestUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean), opts.dbPath);
                const artifact = await exportReport(report, format, exportScan ? `0-scan-${decodeURIComponent(exportScan[1]!)}` : "0-findings");
                res.writeHead(200, { "Content-Type": artifact.contentType, "Content-Disposition": `attachment; filename="${artifact.filename}"`, "Content-Length": artifact.body.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                res.end(artifact.body);
                return;
              }
              const consoleHandled = await handleWebConsoleApiRequest(req, res, requestUrl, consoleGateway, operator, workflows, triggers, github, engineRequest ? undefined : { auth: teamAuth, collaboration });
              if (consoleHandled) return;
              const handled = await handleApiRequest(req, res, requestUrl.pathname, opts.dbPath, controlToken, engineBearer, engine ? id => engine!.resolveScanDatabase(id) : undefined);
              if (!handled) json(res, 404, { error: "Not found" });
              return;
            }

            if (devUrl) {
              if (req.method !== "GET" && req.method !== "HEAD") throw new WebRequestError("Asset method not allowed.", 405);
              const assetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, devUrl);
              const response = await fetch(assetUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
              const contentType = response.headers.get("content-type") ?? "application/octet-stream";
              const data = Buffer.from(await response.arrayBuffer());
              if (data.length > 16_000_000) throw new WebRequestError("Development asset is too large.", 413);
              const body = contentType.includes("text/html")
                ? data.toString("utf8").replace("</head>", `<meta name="0-control-token" content="${controlToken}"></head>`)
                : data;
              res.writeHead(response.status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
              res.end(req.method === "HEAD" ? undefined : body);
              return;
            }
            const explicitAsset = resolveAssetPath(assetDir, requestUrl.pathname);
            if (explicitAsset) {
              sendFile(res, explicitAsset, controlToken);
              return;
            }

            if (extname(requestUrl.pathname)) {
              json(res, 404, { error: "Asset not found" });
              return;
            }

            // Inject the control token into HTML so the dashboard JS can read it.
            sendFile(res, join(assetDir, "index.html"), controlToken);
          } catch (err) {
            json(res, errorStatusCode(err), { error: err instanceof Error ? err.message : "Web application request failed." });
          }
        });
        let dashboardAssetsCleaned = false;
        let unregisterLocalEngine: (() => void) | undefined;
        const cleanupDashboardAssets = () => {
          if (dashboardAssetsCleaned) return;
          dashboardAssetsCleaned = true;
          unregisterLocalEngine?.();
          cleanupAssetDir?.();
        };
        server.once("close", cleanupDashboardAssets);

        let retriedPort = false;
        server.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" && port !== 0 && !retriedPort) {
            retriedPort = true;
            console.log(chalk.gray(`  Port ${port} is in use; opening 0 web on a free port.`));
            server.listen(0, host, onListening);
            return;
          }
          console.error(`Unable to start 0 web: ${error.message}`);
          cleanupDashboardAssets();
          process.exit(1);
        });
        const onListening = () => {
          const address = server.address();
          if (address && typeof address !== "string") {
            origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
          }
          const url = origin;
          try {
            unregisterLocalEngine = registerLocalEngine({ url, token: controlToken, engineId: localHandshake.engineId, serverInstanceId: localHandshake.serverInstanceId!, pid: process.pid, workspace: opts.engineWorkspace ?? process.cwd() }, opts.dbPath);
          } catch (error) {
            console.error(error instanceof Error ? error.message : "Unable to register the local engine.");
            void Promise.resolve().then(shutdown);
            return;
          }
          console.log(chalk.red.bold("  ◆ 0") + chalk.gray(" dashboard"));
          console.log(chalk.gray(`  ${url}`));
          if (opts.readyJson) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url })}`);
          console.log(chalk.gray("  Ctrl+C to stop"));
          if (opts.open !== false) openBrowser(`${url}/console`);
        };
        server.listen(port, host, onListening);

        let shuttingDown = false;
        const shutdown = () => {
          if (shuttingDown) return;
          shuttingDown = true;
          stopHostReconnect?.(); hostRepairAbort.abort();
          services.remoteProviderRelays.dispose();
          void localProviderSessions.dispose().then(() => { modelBackends.dispose(); backends.dispose(); return engine?.dispose(); }).then(() => triggers.dispose()).then(() => consoleGateway.closeAll()).then(() => workflows.dispose()).finally(() => {
            operator.dispose();
            github.dispose();
            for (const response of activeResponses) response.end();
            server.close(() => {
              cleanupDashboardAssets();
              process.exit(0);
            });
            server.closeAllConnections();
          });
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        stopHostReconnect?.(); hostRepairAbort.abort();
        await localProviderSessions.dispose();
        modelBackends.dispose(); backends.dispose();
        await startupTriggers?.dispose().catch(() => {});
        await startupGateway?.closeAll().catch(() => {});
        await startupWorkflows?.dispose().catch(() => {});
        startupOperator?.dispose();
        startupGitHub?.dispose();
        await engine?.dispose().catch(() => {});
        startupAssetCleanup?.();
        throw error;
      }
    });
}
