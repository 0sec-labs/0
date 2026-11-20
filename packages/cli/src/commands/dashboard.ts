import { createServer, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { URL } from "node:url";
import { enginesConfigOption } from "./shared-options.js";
import type { Command } from "commander";
import chalk from "chalk";
import { z } from "zod";
import { BackendRequestIdSchema, BackendDescriptorSchema } from "@0/engine/shared";
import { exportReport, runStartupImport, isReportExportFormat, modelTransportStats } from "@0/engine";
import { ConsoleGateway } from "../web/console-gateway.js";
import { closeSharedDbs } from "../web/shared-db.js";
import { WebOperatorServices } from "../web/operator-services.js";
import { WebWorkflowService } from "../web/workflows.js";
import type { WebSentinelService } from "../web/sentinels.js";
import { GitHubPublicationAuth } from "../web/github-auth.js";
import { findDashboardInstance } from "../web/dashboard-instance.js";
import { startManagedHostReconnect } from "../web/managed-host-reconnect.js";
import { LocalProviderSessions, LocalProviderSessionError } from "../web/local-provider-sessions.js";
import { handleRemoteProviderRelayRequest } from "../web/remote-provider-relay.js";
import { BackendConnectionRegistry, backendBearerFromEnv, createBackendHandshake, handleBackendConnectionRequest } from "../web/backend-connections.js";
import { WorkflowEngineService } from "../workflow-engine-service.js";
import { retainedScanSnapshot } from "../web/report-artifacts.js";
import { findingsServiceFor } from "../web/findings-service.js";
import { retainedFindingsAcrossDatabases } from "../web/findings-export.js";
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
import { homeStateDir, VERSION } from "@0/engine/shared";
import { getSettings } from "../state/settings-store.js";
import { UpdateManager } from "../web/update-manager.js";
import { restartCommand, spawnRestart } from "../web/self-restart.js";
import { assertLocalEngineAvailable, registerLocalEngine } from "../local-engine.js";
import { loadManagedWorker, validateWorkerOptions, type WorkerDeployResult } from "../worker-deploy.js";
import { discoverSshHosts } from "../worker-hosts.js";
import { WebRequestError, errorStatusCode, authorizeWebRequest, json, text, sendFile, readJson, requireControlToken, isLoopbackDashboardHost } from "../web/dashboard-http.js";
import { resolveDashboardAssetDir, resolveAssetPath } from "../web/dashboard-assets.js";
import { resolveCliEntrypoint } from "../web/dashboard-daemon.js";
import { handleWebConsoleApiRequest, handleApiRequest } from "../web/dashboard-api.js";
import { frameProtectionHeaders } from "../web/self-edit-preview.js";
import { isAnonymousApiExemption, isBrowserOnlyRoute, privilegedRouteDenial } from "../web/privileged-routes.js";
import { audit, auditDenial, configureAudit } from "../web/audit.js";
import { ServerModeGuard, handleHealth, isHealthRequest, isWildcardHost, resolveAccessSecret, splitList, validateAccessToken, type ServerPhase, type ServerRequestContext } from "../web/server-mode.js";
import { listAudit } from "@0/engine/storage";
import { GITHUB_WEBHOOK_PATH, GitHubWebhookReceiver, WebhookSecretStore } from "../web/github-webhook.js";

type DashboardOptions = {
  dbPath?: string;
  port?: string;
  host?: string;
  assetDir?: string;
  devUrl?: string;
  readyJson?: boolean;
  headless?: boolean;
  enginesConfig?: string;
  teamConfig?: string;
  engineTokenEnv?: string;
  engineWorkspace?: string;
  engineAllowApply?: boolean;
  engineTimeCap?: string;
  engineCostCap?: string;
  serverMode?: boolean;
  allowedHost?: string[];
  trustedProxy?: string[];
  publicUrl?: string;
  accessTokenEnv?: string;
  shutdownTimeout?: string;
  // Commander 12 maps `--no-open` to `opts.open = false` (not `opts.noOpen = true`).
  // See: https://github.com/tj/commander.js/blob/master/Readme.md#other-option-types-negatable-boolean-and-booleanvalue
  open?: boolean;
};


function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

const STATIC_ASSET_EXTENSION = /^\.(?:js|mjs|cjs|css|map|json|txt|xml|html?|wasm|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|pdf|zip|gz|md|passwd)$/i;
export function registerDashboardCommand(program: Command): void {
  const web = program
    .command("web")
    .description("Run the local browser console and operations workspace")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--port <port>", "Port to bind; 0 chooses a free loopback port", "48123")
    .option("--host <host>", "Loopback host to bind (127.0.0.0/8 or ::1)", "127.0.0.1")
    .option("--asset-dir <path>", "Path to the built web app")
    .option("--dev-url <url>", "Loopback Vite server for authenticated frontend hot reload")
    .option("--team-config <path>", "Enable workspace accounts, roles, and shared conversation controls")
    .option("--engine-token-env <name>", "Environment variable holding the engine bearer credential (32–4096 characters)")
    .option("--engine-workspace <path>", "Engine-owned authorized workspace for persistent workflow calls")
    .option("--engine-allow-apply", "Admit explicitly approved patch application in persistent workflow calls")
    .option("--engine-time-cap <ms>", "Server workflow deadline ceiling (default 600000 ms)")
    .option("--engine-cost-cap <usd>", "Server workflow estimated cost ceiling (default $5)")
    .option("--server-mode", "Serve the console to a network behind a TLS proxy: requires sign-in, an allowed-host list and a single node (off by default)")
    .option("--allowed-host <host...>", "Server mode: accepted Host header names (default: only the bind host); also ZERO_ALLOWED_HOSTS")
    .option("--trusted-proxy <cidr...>", "Server mode: proxy addresses or CIDRs whose X-Forwarded-* headers are trusted; also ZERO_TRUSTED_PROXY")
    .option("--public-url <url>", "Server mode: the public https URL of this console (sign-in cookies, single sign-on); also ZERO_PUBLIC_URL")
    .option("--access-token-env <name>", "Server mode: environment variable holding the access token (32+ characters); default ZERO_ACCESS_TOKEN, else one is generated")
    .option("--shutdown-timeout <seconds>", "Server mode: seconds to finish in-flight requests on SIGTERM (default 20)")
    .option("--ready-json", "Emit the bound console URL as machine-readable JSON")
    .option("--no-open", "Do not auto-open a browser")
    .option("--headless", "Serve the API only: no browser, and no web app files needed (use with `0 threads`)")
    .action(async (opts: DashboardOptions) => {
      if (opts.headless) opts.open = false;
      const serverMode = opts.serverMode === true || process.env.ZERO_SERVER_MODE === "1";
      const host = opts.host?.trim() || "127.0.0.1";
      const port = parseInt(opts.port ?? "48123", 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${opts.port ?? "48123"}`);
      }
      if (!serverMode && !isLoopbackDashboardHost(host)) {
        throw new Error(
          "The console only binds loopback addresses (127.0.0.0/8 or ::1). Use an SSH tunnel or an authenticated reverse proxy bound to local loopback for remote access, or run a single-node server with --server-mode (see the Docker page).",
        );
      }
      if (serverMode && opts.devUrl) throw new Error("--server-mode cannot be combined with --dev-url.");
      const shutdownSeconds = opts.shutdownTimeout === undefined ? 20 : Number(opts.shutdownTimeout);
      if (!Number.isFinite(shutdownSeconds) || shutdownSeconds < 1 || shutdownSeconds > 600) throw new Error("--shutdown-timeout must be between 1 and 600 seconds.");
      const allowedHosts = splitList(opts.allowedHost, process.env.ZERO_ALLOWED_HOSTS);
      if (serverMode && allowedHosts.length === 0 && !isWildcardHost(host)) allowedHosts.push(host.replace(/^\[|\]$/g, "").toLowerCase());
      const trustedProxies = splitList(opts.trustedProxy, process.env.ZERO_TRUSTED_PROXY);
      const publicUrl = opts.publicUrl ?? process.env.ZERO_PUBLIC_URL;
      // A server-mode wildcard bind is reached locally (engine discovery, URL base) through loopback.
      const originHost = serverMode && !isLoopbackDashboardHost(host) ? "127.0.0.1" : host;
      let origin = `http://${originHost.includes(":") ? `[${originHost}]` : originHost}:${port}`;
      let devUrl: URL | undefined;
      if (opts.devUrl) {
        devUrl = new URL(opts.devUrl);
        const devHost = devUrl.hostname.replace(/^\[|\]$/g, "");
        if (devUrl.protocol !== "http:" || devUrl.username || devUrl.password || !isLoopbackDashboardHost(devHost)) {
          throw new Error("The frontend development server must use an HTTP loopback URL without credentials.");
        }
      }


      if (!serverMode && port !== 0 && !opts.dbPath && !opts.assetDir && !opts.devUrl && !opts.enginesConfig && !opts.engineTokenEnv && !opts.engineWorkspace && !opts.engineAllowApply && !opts.engineTimeCap && !opts.engineCostCap && await findDashboardInstance(origin)) {
        console.log(chalk.gray(`  0 is already running: ${origin}`));
        if (opts.readyJson) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url: origin })}`);
        if (opts.open !== false) openBrowser(`${origin}/chats`);
        return;
      }

      const engineBearer = backendBearerFromEnv(opts.engineTokenEnv);
      const explicitTeamConfig = opts.teamConfig ?? process.env.ZERO_TEAM_CONFIG;
      const teamConfigPath = findTeamConfigPath({ workspacePath: opts.engineWorkspace ?? process.cwd(), explicitConfigPath: explicitTeamConfig });
      if (!engineBearer && !teamConfigPath && [opts.engineWorkspace, opts.engineAllowApply, opts.engineTimeCap, opts.engineCostCap].some(value => value !== undefined && value !== false)) throw new Error("Engine admission options require --engine-token-env or --team-config.");
      const timeCapMs = opts.engineTimeCap === undefined ? 600_000 : Number(opts.engineTimeCap);
      const costCapUsd = opts.engineCostCap === undefined ? 5 : Number(opts.engineCostCap);
      if (!Number.isInteger(timeCapMs) || timeCapMs < 1 || timeCapMs > 86_400_000 || !Number.isFinite(costCapUsd) || costCapUsd <= 0 || costCapUsd > 1000) throw new Error("Engine limits must be positive, with time at most 86400000 ms and cost at most $1000.");
      const controlToken = randomUUID();
      const publicOrigin = serverMode && publicUrl ? new URL(publicUrl).origin : origin;
      let teamAuth = new TeamAuth({ configPath: teamConfigPath, origin: publicOrigin });
      let serverGuard: ServerModeGuard | undefined;
      let generatedAccess: { path?: string; token: string } | undefined;
      if (serverMode) {
        const configured = validateAccessToken(process.env[opts.accessTokenEnv ?? "ZERO_ACCESS_TOKEN"], opts.accessTokenEnv ?? "ZERO_ACCESS_TOKEN");
        if (opts.accessTokenEnv && !process.env[opts.accessTokenEnv]) throw new Error(`--access-token-env ${opts.accessTokenEnv} is not set.`);
        // Team accounts are the credential when configured; otherwise a strong shared access token.
        let accessToken: string | undefined;
        if (!teamAuth.enabled) {
          const secret = resolveAccessSecret({ configured, stateDir: homeStateDir() });
          accessToken = secret.token;
          if (secret.generated) generatedAccess = secret;
        } else if (configured) console.error(chalk.yellow("  Team sign-in is configured, so the access token is ignored."));
        serverGuard = new ServerModeGuard({ allowedHosts, trustedProxies, publicUrl, accessToken });
      }
      // The GitHub webhook receiver exists only in server mode; without it the route is not mounted at all.
      let webhookSentinels: () => WebSentinelService | undefined = () => undefined;
      const webhook = serverMode ? new GitHubWebhookReceiver({
        secrets: new WebhookSecretStore(homeStateDir()),
        dispatcher: () => { const service = webhookSentinels(); return service ? { targets: (repo, base) => service.webhookTargets(repo, base), check: id => service.checkTrigger(id) } : undefined; },
      }) : undefined;
      const webhookConsole = webhook ? { receiver: webhook, ...(publicUrl ? { payloadUrl: new URL(GITHUB_WEBHOOK_PATH, publicUrl).toString() } : {}) } : undefined;
      let phase: ServerPhase = "starting";
      let dbProbe = { at: 0, ok: false };
      const dbOk = () => {
        if (Date.now() - dbProbe.at < 5_000) return dbProbe.ok;
        let ok = true; try { listAudit({ limit: 1 }, { dbPath: opts.dbPath ?? undefined }); } catch { ok = false; }
        dbProbe = { at: Date.now(), ok }; return ok;
      };
      let teamDirectory = teamAuth.enabled ? join(homeStateDir(), "teams", createHash("sha256").update(teamAuth.workspaceId!).digest("hex")) : undefined;
      if (teamDirectory) { mkdirSync(teamDirectory, { recursive: true, mode: 0o700 }); if (!explicitTeamConfig) opts.dbPath = join(teamDirectory, "data.db"); else opts.dbPath ??= join(teamDirectory, "data.db"); }
      let collaboration = teamAuth.enabled ? new CollaborationService({ workspaceId: teamAuth.workspaceId!, stateDir: join(teamDirectory!, "collaboration"), resolveSession: sessionId => teamAuth.resolveSessionId(sessionId) }) : undefined;
      // Never recover another live host's database while opening a second UI.
      assertLocalEngineAvailable(opts.dbPath);
      configureAudit(opts.dbPath);
      const imported = runStartupImport();
      if (imported && !imported.alreadyDone && (imported.migrated.length || imported.notMigrated.length)) process.stderr.write(`Imported ${imported.migrated.length} item(s) from your earlier setup; ${imported.notMigrated.length} could not be migrated. See the Extensions page.\n`);
      const capabilities = ["sessions", "workflows", "schedules", "approvals", "events", "workspaces", "artifacts", "model-connections", "provider-relay", "operator-services", "process-controls", "learning", "workflow-engine"];
      let localHandshake = createBackendHandshake(opts.dbPath, capabilities);
      let backends = new BackendConnectionRegistry({ configPath: opts.enginesConfig, localHandshake });
      // Keep model frames independent of long-lived browser event subscriptions.
      let modelBackends = new BackendConnectionRegistry({ configPath: opts.enginesConfig, localHandshake });
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
      // Keeps a long-running console current: background checks, the one-click update and its restart.
      let restartRequested: { version: string; supervised: boolean } | undefined;
      let requestShutdown: (() => void) | undefined;
      let runningThreads = () => 0;
      let boundPort = port;
      const updates = new UpdateManager({
        current: VERSION, serverMode, threadCount: () => runningThreads(), policy: () => getSettings().updatePolicy,
        restart: info => { restartRequested = info; requestShutdown?.(); },
      });
      let engine: WorkflowEngineService | undefined;
      let startupGateway: ConsoleGateway | undefined;
      let startupOperator: WebOperatorServices | undefined;
      let startupWorkflows: WebWorkflowService | undefined;
      let startupGitHub: GitHubPublicationAuth | undefined;
      let startupSentinels: WebSentinelService | undefined;
      let startupAssetCleanup: (() => void) | undefined;
      try {
        // Without a browser to serve (--headless or --no-open) the console works from the API alone, so missing dashboard assets are not fatal.
        let assetDir: string | undefined; let cleanupAssetDir: (() => void) | undefined;
        try { ({ path: assetDir, cleanup: cleanupAssetDir } = resolveDashboardAssetDir(import.meta.url, opts.assetDir)); }
        catch (error) {
          if (opts.open !== false || serverMode || opts.devUrl) throw error;
          console.log(chalk.gray("  Dashboard assets not found: serving the API only."));
        }
        startupAssetCleanup = cleanupAssetDir;
        const buildServices = (auth: TeamAuth, dbPath = opts.dbPath, stateDir = teamDirectory, relayEpoch = localHandshake.serverInstanceId) => createWorkspaceServices({ updates, relayEpoch, auth, dbPath, stateDir, workspace: opts.engineWorkspace, allowApply: opts.engineAllowApply, controlToken, engineBearer, timeCapMs, costCapUsd });
        let services = await buildServices(teamAuth);
        stopHostReconnect = watchManagedHosts();
        let { skills, gateway: consoleGateway, engagements, operator, workflows, github, sentinels } = services;
        engine = services.engine;
        webhookSentinels = () => sentinels;
        // Opt-in: close resumed-but-never-used chats after this many idle ms (>= 1000).
        const reapIdleMs = Number(process.env["ZERO_REAP_IDLE_RESUMED_MS"]);
        if (Number.isFinite(reapIdleMs) && reapIdleMs >= 1_000) {
          setInterval(() => { void consoleGateway.reapIdleResumed(reapIdleMs).catch(() => undefined); }, Math.min(60_000, Math.floor(reapIdleMs / 2))).unref();
        }
        runningThreads = () => consoleGateway.activeThreadCount() + (workflows.hasActiveWork() ? 1 : 0);
        startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupGitHub = github; startupSentinels = sentinels;
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
              nextBackends = new BackendConnectionRegistry({ configPath: opts.enginesConfig, localHandshake: nextHandshake });
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
              services = next; teamAuth = prepared.auth; teamDirectory = prepared.stateDir; opts.dbPath = prepared.dbPath; configureAudit(opts.dbPath); collaboration = nextCollaboration; localHandshake = nextHandshake; backends = nextBackends; modelBackends = new BackendConnectionRegistry({ configPath: opts.enginesConfig, localHandshake: nextHandshake }); localProviderSessions = new LocalProviderSessions({ registry: modelRegistry }); unregisterLocalEngine = nextUnregister;
              ({ skills, gateway: consoleGateway, engagements, operator, workflows, github, sentinels } = next); engine = next.engine; findingsAccess = nextAccess; findingsRead = nextRead;
              startupGateway = consoleGateway; startupOperator = operator; startupWorkflows = workflows; startupGitHub = github; startupSentinels = sentinels;
              stopHostReconnect = watchManagedHosts();
            } catch (cause) { nextBackends?.dispose(); nextUnregister?.(); await next.dispose().catch(() => {}); throw cause; }
          },
        });

        const server = createServer(async (req, res) => {
          activeResponses.add(res); const releaseResponse = () => activeResponses.delete(res); res.once("close", releaseResponse); res.once("finish", releaseResponse);
          // Orchestrator probes carry arbitrary Host values and read nothing but a status word.
          if (serverGuard && isHealthRequest(req)) { handleHealth(req, res, { phase: () => phase, dbOk, model: modelTransportStats }); return; }
          let serverContext: ServerRequestContext | undefined;
          try { if (serverGuard) serverContext = serverGuard.authorize(req); else authorizeWebRequest(req, origin); }
          catch (error) {
            if (serverGuard) audit({ actor: "anonymous", action: "access.host_denied", subject: (req.url ?? "/").split("?")[0] ?? "/", outcome: "denied", detail: { reason: "host_or_origin", status: error instanceof WebRequestError ? error.statusCode : 403, method: req.method ?? "GET", client: req.socket.remoteAddress } });
            json(res, error instanceof WebRequestError ? error.statusCode : 403, { error: error instanceof Error ? error.message : "Invalid request origin." });
            return;
          }
          if (!serverGuard && isHealthRequest(req)) { handleHealth(req, res, { phase: () => phase, dbOk, model: modelTransportStats }); return; }
          let requestUrl = new URL(req.url ?? "/", origin);
          const requestId = BackendRequestIdSchema.safeParse(req.headers["x-0-request-id"]);
          res.setHeader("X-0-Request-ID", requestId.success ? requestId.data : randomUUID());

          try {
            // The one anonymous API path in server mode: GitHub cannot sign in, so it is authenticated by an HMAC of the raw
            // body inside the handler instead. It sits before the session gate and the control-token check and nothing else does.
            if (webhook && serverContext && isAnonymousApiExemption(requestUrl.pathname)) { await webhook.handle(req, res, serverContext.clientIp); return; }
            if (serverGuard && serverContext) {
              if (await serverGuard.handleAccessRoute(req, res, requestUrl.pathname, serverContext, teamAuth, () => readJson(req, 16_384))) return;
              const hasBearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ");
              if (!serverGuard.isAuthenticated(req, teamAuth)) {
                const api = requestUrl.pathname.startsWith("/api/");
                const sso = req.method === "GET" && (requestUrl.pathname === "/api/team/auth/sso" || requestUrl.pathname === "/api/team/auth/callback");
                if (api && !sso && !hasBearer) { serverGuard.denyAnonymous(req, res, serverContext); return; }
                if (!api) {
                  if (req.method !== "GET" && req.method !== "HEAD") { serverGuard.denyAnonymous(req, res, serverContext); return; }
                  if (STATIC_ASSET_EXTENSION.test(extname(requestUrl.pathname)) || requestUrl.pathname.startsWith("/assets/")) { json(res, 401, { code: "access_required", error: "Sign in to use this console." }); return; }
                  serverGuard.sendLoginPage(req, res, serverContext, teamAuth); return;
                }
              } else if (requestUrl.pathname.startsWith("/api/") && !hasBearer) {
                const refusal = serverGuard.csrfDenial(req, serverContext);
                if (refusal) { json(res, 403, { code: "csrf", error: refusal }); return; }
              }
            }
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
              const bearer = req.headers.authorization;
              const engineRequest = Boolean(engineBearer && typeof bearer === "string" && bearer.startsWith("Bearer ") && Buffer.byteLength(bearer.slice(7)) === Buffer.byteLength(engineBearer) && timingSafeEqual(Buffer.from(bearer.slice(7)), Buffer.from(engineBearer)));
              // Default-deny for the engine bearer on every mutating /api route (team setup/auth included) before any handler runs.
              if (engineRequest && isBrowserOnlyRoute(requestUrl.pathname, req.method ?? "GET")) { auditDenial(req, requestUrl.pathname, "browser_only", "engine"); json(res, 403, { code: "browser_only", error: "This action is only available from the browser console." }); return; }
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
              if (!engineRequest) authorizeTeamApi(teamAuth, req, requestUrl.pathname);
              const privilegedDenial = privilegedRouteDenial(requestUrl.pathname, req.method ?? "GET", { engineRequest, teamEnabled: teamAuth.enabled, role: teamAuth.resolveSession(req)?.role });
              if (privilegedDenial) { auditDenial(req, requestUrl.pathname, privilegedDenial.data.code, engineRequest ? "engine" : "browser"); json(res, privilegedDenial.status, privilegedDenial.data); return; }
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
                else if (path && method === "DELETE") json(res, 200, skills.delete(decodedPath, access));
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
                  trustNewHost: z.boolean().optional(),
                  enginePort: z.number().int().min(1).max(65535).optional(),
                }).strict().parse(await readJson(req));
                try { validateWorkerOptions(body); } catch (cause) {
                  const message = cause instanceof Error ? cause.message : "";
                  throw new WebRequestError(message.startsWith("--ssh") ? "Enter a host name or user@host." : message.startsWith("--lima") ? "Enter a valid instance name." : message.startsWith("--target-git") ? "Enter a repository URL without spaces or quotes." : "Check the computer details and try again.", 400);
                }
                const compiledBinary = import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("/$bunfs/");
                const args = [...(compiledBinary ? [] : [resolveCliEntrypoint()]), "worker", "deploy", ...(body.ssh ? ["--ssh", body.ssh] : ["--lima", body.lima ?? "zero-worker"]), ...(body.targetGit ? ["--target-git", body.targetGit] : []), ...(body.enginePort ? ["--engine-port", String(body.enginePort)] : []), ...(body.forwardProviderKey ? ["--forward-provider-key"] : []), ...(body.trustNewHost ? ["--trust-new-host"] : []), ...(opts.enginesConfig ? ["--engines-config", opts.enginesConfig] : [])];
                const result = await new Promise<WorkerDeployResult>((resolveDeploy, reject) => {
                  // foxguard: ignore[js/no-command-injection] all request values are strict-schema validated and passed as execFile argv without a shell.
                  execFile(process.execPath, args, { timeout: 3_600_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => { // foxguard: ignore[js/no-command-injection]
                    if (error) {
                      // The CLI explains what went wrong in its last stderr line; progress lines come before it.
                      const reason = (stderr.trim().split("\n").at(-1)?.replace(/^error:\s*/, "").trim() ?? "").replace(/, or add it again with --trust-new-host to trust it on first connection\./, ", or tick “This is the first time I connect to it” under Another computer or options and try again.");
                      const explained = reason.length > 0 && reason.length <= 600 && !/^\s*at /.test(reason);
                      reject(new WebRequestError(explained ? reason : "Could not set up the computer. Check that you can sign in to it with SSH, then try again.", /source checkout has not been bundled|does not include the files/.test(reason) ? 422 : 502)); return;
                    }
                    try { resolveDeploy(JSON.parse(stdout)); } catch { reject(new WebRequestError("Worker deployment returned an invalid result.", 502)); }
                  });
                });
                backends.reload();
                json(res, 202, result);
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
              if (/^\/api\/findings\/[^/]+\/impact-assessment$/.test(requestUrl.pathname)) {
                const input = req.method === "POST" || req.method === "DELETE" ? await readJson(req) : undefined;
                const impactId = decodeURIComponent(requestUrl.pathname.split("/")[3] ?? "");
                const owner = await findingsServiceFor(opts.dbPath).sourceOfFinding(impactId);
                const result = handleFindingImpactRequest(requestUrl.pathname, req.method ?? "GET", input, { dbPath: owner?.id ?? opts.dbPath });
                if (result) { json(res, result.status, result.data); return; }
              }
              const exportScan = requestUrl.pathname.match(/^\/api\/scans\/([^/]+)\/export$/);
              if (exportScan || requestUrl.pathname === "/api/findings/export") {
                if (req.method !== "GET") throw new WebRequestError("Use GET to export a report.", 405);
                const requestedFormat = requestUrl.searchParams.get("format") ?? "json";
                const format = requestedFormat === "md" ? "markdown" : requestedFormat;
                if (!isReportExportFormat(format)) throw new WebRequestError("Unsupported report export format.", 400);
                const report = exportScan
                  ? retainedScanSnapshot(decodeURIComponent(exportScan[1]!), engine?.resolveScanDatabase(decodeURIComponent(exportScan[1]!)) ?? (await findingsServiceFor(opts.dbPath).sourceOfScan(decodeURIComponent(exportScan[1]!)))?.id ?? opts.dbPath)
                  : await retainedFindingsAcrossDatabases((requestUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean), opts.dbPath);
                const artifact = await exportReport(report, format, exportScan ? `0-scan-${decodeURIComponent(exportScan[1]!)}` : "0-findings");
                res.writeHead(200, { "Content-Type": artifact.contentType, "Content-Disposition": `attachment; filename="${artifact.filename}"`, "Content-Length": artifact.body.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
                res.end(artifact.body);
                return;
              }
              const consoleHandled = await handleWebConsoleApiRequest(req, res, requestUrl, consoleGateway, operator, workflows, github, sentinels, engineRequest ? undefined : { auth: teamAuth, collaboration }, skills, webhookConsole);
              if (consoleHandled) return;
              const handled = await handleApiRequest(req, res, requestUrl.pathname, opts.dbPath, controlToken, engineBearer, engine ? id => engine!.resolveScanDatabase(id) : undefined, (() => {
                const member = engineRequest ? null : teamAuth.resolveSession(req);
                return { engineRequest, teamEnabled: teamAuth.enabled, ...(member ? { displayName: member.displayName, userId: member.userId } : {}) };
              })());
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
              res.writeHead(response.status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...frameProtectionHeaders() });
              res.end(req.method === "HEAD" ? undefined : body);
              return;
            }
            if (!assetDir) { json(res, 404, { error: "This console serves the API only; the web app is not installed." }); return; }
            const explicitAsset = resolveAssetPath(assetDir, requestUrl.pathname);
            if (explicitAsset) {
              sendFile(res, explicitAsset, controlToken);
              return;
            }

            // Only real file requests miss; a route whose last segment has a dot (plugin:foxguard.scanner) is an app route.
            if (STATIC_ASSET_EXTENSION.test(extname(requestUrl.pathname)) || requestUrl.pathname.startsWith("/assets/")) {
              json(res, 404, { error: "Asset not found" });
              return;
            }

            // Inject the control token into HTML so the dashboard JS can read it.
            sendFile(res, join(assetDir, "index.html"), controlToken);
          } catch (err) {
            if (res.headersSent) { res.destroy(); return; }
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
          if (error.code === "EADDRINUSE" && port !== 0 && !retriedPort && !serverMode) {
            retriedPort = true;
            console.log(chalk.gray(`  Port ${port} is in use; opening the web console on a free port.`));
            server.listen(0, host, onListening);
            return;
          }
          console.error(`Unable to start the web console: ${error.message}`);
          cleanupDashboardAssets();
          process.exit(1);
        });
        const onListening = () => {
          const address = server.address();
          if (address && typeof address !== "string") {
            origin = `http://${originHost.includes(":") ? `[${originHost}]` : originHost}:${address.port}`;
          }
          const url = origin;
          if (address && typeof address !== "string") boundPort = address.port;
          try {
            unregisterLocalEngine = registerLocalEngine({ url, token: controlToken, engineId: localHandshake.engineId, serverInstanceId: localHandshake.serverInstanceId!, pid: process.pid, workspace: opts.engineWorkspace ?? process.cwd() }, opts.dbPath);
          } catch (error) {
            console.error(error instanceof Error ? error.message : "Unable to register the local engine.");
            void Promise.resolve().then(shutdown);
            return;
          }
          console.log(chalk.red.bold("  ◆ 0") + chalk.gray(" console"));
          console.log(chalk.gray(`  ${serverMode ? publicUrl || `http://${host.includes(":") ? `[${host}]` : host}:${address && typeof address !== "string" ? address.port : port}` : url}`));
          if (serverGuard) {
            console.log(chalk.gray(`  Server mode: single node, one process owns the database. Allowed hosts: ${allowedHosts.join(", ") || publicUrl}`));
            if (generatedAccess) {
              console.log(chalk.yellow.bold("  Access token (shown once; stored 0600 at " + (generatedAccess.path ?? "the state directory") + "):"));
              console.log(`  ${generatedAccess.token}`);
            }
            if (!serverGuard.trustsProxy && !isLoopbackDashboardHost(host)) {
              console.error(chalk.red.bold("  WARNING: listening on a network address without a trusted TLS proxy. Plain HTTP exposes the access token and the session cookie. Put a TLS-terminating proxy in front and pass --trusted-proxy and --public-url, or keep this port private."));
            }
          }
          phase = "ready";
          if (opts.readyJson || serverMode) console.log(`ZERO_DASHBOARD_READY ${JSON.stringify({ url: serverMode && publicUrl ? publicUrl : url, ...(serverMode ? { mode: "server" } : {}) })}`);
          console.log(chalk.gray("  Ctrl+C to stop"));
          updates.start();
          if (opts.open !== false && !serverMode) openBrowser(`${url}/chats`);
        };
        server.listen(port, host, onListening);

        let shuttingDown = false;
        const shutdown = () => {
          if (shuttingDown) return;
          shuttingDown = true;
          phase = "draining";
          updates.stop();
          // Stop accepting, end long-lived streams, let ordinary requests finish within the deadline, then dispose and exit 0.
          const drainMs = shutdownSeconds * 1000;
          const failsafe = setTimeout(() => { console.error("0: shutdown deadline exceeded; exiting."); process.exit(1); }, drainMs + 10_000); failsafe.unref();
          const closed = new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
          server.closeIdleConnections();
          for (const response of activeResponses) if (String(response.getHeader("content-type") ?? "").includes("text/event-stream")) response.end();
          const drained = new Promise<void>(resolveDrain => {
            const deadline = Date.now() + drainMs;
            const poll = setInterval(() => { server.closeIdleConnections(); if (activeResponses.size === 0 || Date.now() >= deadline) { clearInterval(poll); resolveDrain(); } }, 100);
            poll.unref?.();
          });
          void drained.then(() => {
          stopHostReconnect?.(); hostRepairAbort.abort();
          services.remoteProviderRelays.dispose();
          void localProviderSessions.dispose().then(() => { modelBackends.dispose(); backends.dispose(); return engine?.dispose(); }).then(() => sentinels.dispose()).then(() => consoleGateway.closeAll()).then(() => workflows.dispose()).finally(() => {
            operator.dispose();
            closeSharedDbs();
            github.dispose();
            for (const response of activeResponses) response.end();
            void closed.then(() => {
              cleanupDashboardAssets();
              if (restartRequested?.supervised) console.log(chalk.gray(`  Updated to ${restartRequested.version}. Exiting so the service manager starts it again.`));
              else if (restartRequested) {
                const compiled = import.meta.url.startsWith("file:///$bunfs/") || import.meta.url.startsWith("/$bunfs/");
                const pid = spawnRestart(restartCommand({ execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, compiled, port: boundPort }));
                console.log(chalk.gray(`  Updated to ${restartRequested.version}. Restarted as process ${pid ?? "?"}.`));
              }
              process.exit(0);
            });
            server.closeAllConnections();
          });
          });
        };
        requestShutdown = shutdown;
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        stopHostReconnect?.(); hostRepairAbort.abort();
        await localProviderSessions.dispose();
        modelBackends.dispose(); backends.dispose();
        await startupSentinels?.dispose().catch(() => {});
        await startupGateway?.closeAll().catch(() => {});
        await startupWorkflows?.dispose().catch(() => {});
        startupOperator?.dispose();
        startupGitHub?.dispose();
        await engine?.dispose().catch(() => {});
        startupAssetCleanup?.();
        throw error;
      }
    });
  enginesConfigOption(web, "Trusted engine connection registry JSON (default ~/.0/engines.json)");
}

export { buildWorkflowSummary } from "../web/dashboard-summaries.js";
