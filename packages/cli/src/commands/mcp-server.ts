import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ToolExecutor,
  getToolsForRole,
  loadScope,
  isScopeEnforcementEnabled,
  getScopeEnforcementState,
  extractAttributionFromScopeJson,
  resolveAttribution,
  RateLimiter,
  parseRateLimitFlag,
  resolveEngagementProfile,
  extractEngagementFromScopeJson,
  describeEngagementPosture,
} from "@0/core";
import type {
  EngagementPosture,
  EngagementProfileInputs,
  HostRateConfig,
  RateLimiterConfig,
} from "@0/core";
import { osecDB, resolveOsecRunStorage } from "@0/db";
import { SecurityWorkflowBindingsSchema, type AuthConfig } from "@0/shared";
import { z } from "zod";

type McpServerOptions = {
  target?: string;
  scanId?: string;
  workflows?: boolean;
  workspace?: string;
  allowApply?: boolean;
  dbPath?: string;
  timeout?: string;
  scope?: string;
  tools?: string;
  rateLimit?: string;
  allowScanners?: boolean;
  engagementProfile?: string;
  /**
   * Commander's `--no-waf-evasion` inverse flag: `false` when the operator
   * passed it, `true` when they did not. Never "unset" — see the mapping in
   * the action, which turns the absent case back into `undefined` so the
   * scope file and env keep their precedence.
   */
  wafEvasion?: boolean;
};

/**
 * Per-host rps the server falls back to when no `--rate-limit` spec is given.
 * Matches the historical default so an unconfigured session is unchanged.
 */
const MCP_DEFAULT_RPS = 5;

type ToolParam = ReturnType<typeof getToolsForRole>[number]["parameters"][string];

const MCP_LIVE_TOOL_NAMES = new Set([
  "http_request",
  "crawl",
  "submit_form",
  "send_prompt",
  "save_finding",
  "update_target",
  "query_findings",
  "update_finding",
  "done",
  "payload_lookup",
  "wp_fingerprint",
  "mongo_objectid",
]);

const MCP_WORKFLOW_TOOL_NAMES = new Set([
  "list_templates", "get_template", "list_workflows", "get_workflow", "save_workflow",
  "start_run", "get_run", "get_run_results", "cancel_run",
]);

function resolveMcpToolNames(raw: string | undefined, workflows = false): ReadonlySet<string> {
  if (raw === undefined) return workflows ? MCP_WORKFLOW_TOOL_NAMES : MCP_LIVE_TOOL_NAMES;
  const requested = [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new Error("--tools must name at least one 0 MCP tool.");
  }
  const unsupported = requested.filter((name) => !MCP_LIVE_TOOL_NAMES.has(name) && !MCP_WORKFLOW_TOOL_NAMES.has(name));
  if (unsupported.length > 0) {
    throw new Error(`--tools contains unsupported 0 MCP tool(s): ${unsupported.join(", ")}`);
  }
  return new Set(requested);
}

function parseJsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function parseAuthEnv(): AuthConfig | undefined {
  const auth = parseJsonEnv<Partial<AuthConfig>>("ZERO_MCP_AUTH_JSON");
  if (!auth) return undefined;

  const requireString = (key: string): string => {
    const value = (auth as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`ZERO_MCP_AUTH_JSON ${auth.type ?? "auth"} auth requires non-empty string field '${key}'.`);
    }
    return value;
  };

  switch (auth.type) {
    case "bearer":
      requireString("token");
      break;
    case "cookie":
      // AuthConfigCookie stores the complete Cookie header value, e.g. "sid=abc".
      requireString("value");
      break;
    case "basic":
      requireString("username");
      requireString("password");
      break;
    case "header":
      requireString("name");
      requireString("value");
      break;
    default:
      throw new Error("ZERO_MCP_AUTH_JSON has an invalid auth type.");
  }

  return auth as AuthConfig;
}

function zodForParam(param: ToolParam): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  if (param.enum && param.enum.length > 0) {
    schema = z.enum(param.enum as [string, ...string[]]);
  } else if (param.type === "number") {
    schema = z.number();
  } else if (param.type === "boolean") {
    schema = z.boolean();
  } else if (param.type === "object") {
    schema = z.record(z.unknown());
  } else {
    schema = z.string();
  }
  return schema.describe(param.description);
}

function zodForTool(tool: ReturnType<typeof getToolsForRole>[number]): z.ZodObject<z.ZodRawShape> {
  const required = new Set(tool.required ?? []);
  const shape: z.ZodRawShape = {};
  for (const [name, param] of Object.entries(tool.parameters)) {
    const schema = zodForParam(param);
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return z.object(shape);
}

function toTextResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function toolResultToMcp(result: Awaited<ReturnType<ToolExecutor["execute"]>>) {
  if (!result.success) {
    return toTextResult(`ERROR: ${result.error ?? "tool failed"}`, {
      success: false,
      error: result.error,
    });
  }

  const text =
    typeof result.output === "string"
      ? result.output
      : JSON.stringify(result.output ?? {}, null, 2);
  return toTextResult(text, { success: true, output: result.output });
}

function withToolTimeout(
  task: Promise<Awaited<ReturnType<ToolExecutor["execute"]>>>,
  timeoutMs: number,
) {
  return new Promise<Awaited<ReturnType<ToolExecutor["execute"]>>>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        success: false,
        output: null,
        error: `MCP tool timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    task.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

/**
 * Resolve the engagement hardening posture, or exit 2 on malformed config.
 *
 * Same contract as the `0 scan` pre-flight: a typo'd
 * `--engagement-profile`, a bad `ZERO_ENGAGEMENT_RATE_RPS`, or a malformed
 * scope-file `engagement` block is an operator error that must surface at boot
 * — not after the server has already served a session at default noise levels.
 * Exit code 2 matches `scan` so callers can treat "bad posture config" the same
 * way whichever entry point they drove.
 */
function resolveEngagementPostureOrExit(inputs: EngagementProfileInputs): EngagementPosture {
  try {
    return resolveEngagementProfile(inputs);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(2);
  }
}

/**
 * Clamp a parsed `--rate-limit` config to an active engagement posture.
 *
 * The posture may only ever make the server QUIETER. Every configured rate —
 * the default bucket and every per-host override — becomes the MINIMUM of
 * itself and the posture's rps, and the posture's full-jitter config is applied
 * to every bucket. So `--engagement-profile conservative --rate-limit 50` runs
 * at 1 rps, while `--engagement-profile conservative --rate-limit 0.2` still
 * runs at 0.2: the flag can lower the ceiling below the profile but never raise
 * it above.
 *
 * This is deliberately STRONGER than the scan path's `effectiveFallbackRps`,
 * where the posture only supplies the fallback and an explicit `--rate-limit`
 * default wins. A scan is one operator command with a visible end; an MCP
 * server is a long-lived session driven by an external client, so the posture
 * is a hard ceiling here rather than a default.
 *
 * Burst is clamped alongside rps because burst is the bucket capacity: leaving
 * a burst of 10 on a 1 rps bucket would let the first ten requests to each host
 * fire at the loud rate anyway.
 *
 * Returns `cfg` untouched for an inactive posture, so a session with no profile
 * requested is byte-for-byte unchanged.
 */
function clampRateLimitToPosture(
  cfg: RateLimiterConfig,
  posture: EngagementPosture,
): RateLimiterConfig {
  if (!posture.active) return cfg;
  const clamp = (host: HostRateConfig): HostRateConfig => {
    const rps = Math.min(host.rps, posture.rateLimitRps);
    return host.burst === undefined ? { rps } : { rps, burst: Math.min(host.burst, rps) };
  };
  return {
    ...cfg,
    default: clamp(cfg.default),
    perHost: cfg.perHost
      ? Object.fromEntries(Object.entries(cfg.perHost).map(([host, c]) => [host, clamp(c)]))
      : undefined,
    jitter: posture.jitter ? { baseMs: posture.jitter.baseMs } : cfg.jitter,
  };
}

const workflowInputsSchema = SecurityWorkflowBindingsSchema;

type WorkflowRuntime = Awaited<ReturnType<typeof import("../workflow-runtime.js")["createCliWorkflowRuntime"]>>;

async function registerWorkflowTools(server: McpServer, selected: ReadonlySet<string>, opts: McpServerOptions): Promise<WorkflowRuntime> {
  const { createCliWorkflowRuntime } = await import("../workflow-runtime.js");
  const runtime = await createCliWorkflowRuntime({
    ownerId: `mcp:${randomUUID()}`,
    workspace: opts.workspace,
    target: opts.target,
    scopePath: opts.scope,
    dbPath: opts.dbPath,
    allowApply: opts.allowApply,
  });
  const id = z.string().trim().min(1).max(160);
  const tools = [
    { name: "list_templates", description: "List workflow templates and supported target types.", schema: z.object({}).strict(), run: () => runtime.listTemplates() },
    { name: "get_template", description: "Read a workflow template.", schema: z.object({ id }).strict(), run: (args: any) => runtime.getTemplate(args.id) },
    { name: "list_workflows", description: "List saved workflow definitions.", schema: z.object({}).strict(), run: () => runtime.listWorkflows() },
    { name: "get_workflow", description: "Read a saved workflow and its revision.", schema: z.object({ id }).strict(), run: (args: any) => runtime.getWorkflow(args.id) },
    { name: "save_workflow", description: "Validate and save a workflow definition with optional revision protection.", schema: z.object({ definition: z.record(z.unknown()), expectedRevision: z.number().int().positive().optional() }).strict(), run: (args: any) => runtime.saveWorkflow(args.definition, args.expectedRevision) },
    { name: "start_run", description: "Start a template or saved workflow using 0's configured model provider. Returns a run ID promptly. Target must be within the server's authorized workspace or live scope.", schema: z.object({ templateId: id.optional(), workflowId: id.optional(), revision: z.number().int().positive().optional(), target: z.string().trim().min(1).max(4096), idempotencyKey: id.optional(), inputs: workflowInputsSchema.optional(), allowApply: z.boolean().optional(), timeCapMs: z.number().int().positive().max(86_400_000).optional(), costCapUsd: z.number().positive().max(1000).optional() }).strict(), run: (args: any) => {
      if (Boolean(args.templateId) === Boolean(args.workflowId)) throw new Error("Select exactly one templateId or workflowId.");
      if (args.workflowId && !args.revision) throw new Error("Saved workflow runs require a pinned revision.");
      if (args.allowApply && !opts.allowApply) throw new Error("Applying workflow changes requires the host --allow-apply capability.");
      return runtime.startRun(args);
    } },
    { name: "get_run", description: "Read status of a run owned by this MCP session.", schema: z.object({ runId: id }).strict(), run: (args: any) => runtime.getRun(args.runId) },
    { name: "get_run_results", description: "Read paginated findings and artifact references from an owned run.", schema: z.object({ runId: id, cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), run: (args: any) => runtime.getRunResults(args.runId, { cursor: args.cursor, limit: args.limit }) },
    { name: "cancel_run", description: "Cancel an active run owned by this MCP session.", schema: z.object({ runId: id }).strict(), run: (args: any) => runtime.cancelRun(args.runId) },
  ];
  for (const tool of tools) {
    if (!selected.has(tool.name)) continue;
    server.registerTool(tool.name, { title: tool.name, description: tool.description, inputSchema: tool.schema }, async (args: Record<string, unknown>) => {
      try {
        const result = await tool.run(tool.schema.parse(args));
        return toTextResult(JSON.stringify(result ?? null, null, 2), { success: true, output: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...toTextResult(`ERROR: ${message}`, { success: false, error: message }), isError: true };
      }
    });
  }
  return runtime;
}

async function connectWorkflowServer(server: McpServer, runtime: WorkflowRuntime): Promise<void> {
  const transport = new StdioServerTransport();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };
  const shutdown = async () => {
    await dispose();
    await server.close();
    process.exit(0);
  };
  const interrupt = () => { void shutdown(); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  transport.onclose = () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    void dispose();
  };
  try {
    await server.connect(transport);
    console.error("0 MCP workflow server running; assessments use 0's configured provider.");
  } catch (error) {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await dispose();
    throw error;
  }
}

export function registerMcpServerCommand(program: Command): void {
  program
    .command("mcp-server")
    .description("Expose selected target tools or managed workflows over MCP stdio")
    .option("--target <target>", "Target URL for this MCP session")
    .option("--scan-id <scanId>", "Scan ID to associate persisted findings and target updates with")
    .option("--workflows", "Expose workflow discovery and run lifecycle tools instead of live tools", false)
    .option("--allow-apply", "Permit explicit workflow apply requests inside the authorized workspace", false)
    .option("--workspace <path>", "Absolute authorized local root for workflow source assessments")
    .option("--db-path <path>", "Path to SQLite database")
    .option("--timeout <ms>", "Default tool timeout in milliseconds", "30000")
    .option("--scope <path>", "Path to a 0 scope JSON file. Out-of-scope URLs are refused by every target tool.")
    .option("--tools <names>", "Comma-separated 0 MCP tools to expose (default: live tools, or workflow tools with --workflows).")
    .option("--rate-limit <spec>", "Per-host request rate-limit spec. Defaults to 5 rps when unset. An active --engagement-profile caps this: the effective rate is the minimum of the two, so the profile can only lower it.")
    .option("--allow-scanners", "Disable generic-scanner suppression for scoped engagements.", false)
    .option(
      "--engagement-profile <name>",
      "Engagement hardening posture for authorized enterprise work. 'standard' (default) is the existing behaviour. 'conservative' applies the quiet posture to this MCP session: no adaptive WAF-evasion ladder, full jitter on the per-host token bucket, and a 1 rps/host ceiling. The profile can only ever make the session quieter — the effective rate is the minimum of the profile and --rate-limit. The applied posture is recorded as an `engagement_posture_applied` event on the scan so it can be handed to the client as evidence. Lower precedence than the scope file's `engagement` block and ZERO_ENGAGEMENT_PROFILE.",
    )
    .option(
      "--no-waf-evasion",
      "Disable the adaptive WAF-evasion ladder (default: on). When a response classifies as blocked, the engine normally retries with encoding/casing/whitespace-mutated payload variants, which escalates a routine WAF block into a SOC incident. Detection and reporting of the block are unaffected. Independent of --engagement-profile; env form: ZERO_WAF_EVASION=0.",
    )
    .action(async (opts: McpServerOptions) => {
      const timeoutMs = Math.max(1_000, parseInt(opts.timeout ?? "30000", 10));
      const selectedToolNames = resolveMcpToolNames(opts.tools, opts.workflows);
      const liveEnabled = [...selectedToolNames].some(name => MCP_LIVE_TOOL_NAMES.has(name));
      const workflowsEnabled = [...selectedToolNames].some(name => MCP_WORKFLOW_TOOL_NAMES.has(name));
      const target = opts.target?.trim() ?? "";
      const scanId = opts.scanId?.trim() ?? "";
      if (liveEnabled && (!target || !scanId)) {
        throw new Error("Live MCP tools require --target and --scan-id.");
      }
      if (opts.workspace && !workflowsEnabled) {
        throw new Error("--workspace requires workflow tools; it does not authorize local access for live tools.");
      }
      if (opts.allowApply && !workflowsEnabled) throw new Error("--allow-apply requires workflow tools.");
      if (opts.workspace && !isAbsolute(opts.workspace)) {
        throw new Error("--workspace must be an absolute authorized local root.");
      }
      const scope = opts.scope ? loadScope(opts.scope) : undefined;
      console.error(getScopeEnforcementState().message);
      if (target && isScopeEnforcementEnabled() && scope) {
        const verdict = scope.match(target);
        if (!verdict.allowed) {
          throw new Error(`--target ${target} is out of scope per ${opts.scope}: ${verdict.reason}`);
        }
      }
      // Workflow-only sessions never construct a live executor or scan database.
      if (!liveEnabled) {
        const server = new McpServer({ name: "0-mcp", version: "0.1.0" }, { capabilities: { logging: {} } });
        const runtime = await registerWorkflowTools(server, selectedToolNames, opts);
        await connectWorkflowServer(server, runtime);
        return;
      }
      // Engagement hardening posture (`scope/engagement-profile.ts`). Resolved
      // BEFORE the DB is opened, matching the scope-rejection ordering above:
      // a config error must fail without leaving a DB handle behind. Same
      // scope-file > env > CLI precedence and same exit code as `0 scan`.
      //
      // `--no-waf-evasion` sets opts.wafEvasion to false; commander leaves it
      // `true` when the flag is absent, which we map back to "unset" so the
      // scope file / env keep their precedence.
      const cliWafEvasion = opts.wafEvasion === false ? false : undefined;
      const posture = resolveEngagementPostureOrExit({
        scopeFileBlock: scope ? extractEngagementFromScopeJson(scope.raw) : undefined,
        env: process.env,
        cliProfile: opts.engagementProfile,
        cliWafEvasion,
      });

      const storage = resolveOsecRunStorage({
        dbPath: opts.dbPath,
        runId: scanId,
        resume: true,
      });
      const db = new osecDB(storage.dbPath);

      const attributionHeaders =
        parseJsonEnv<string[]>("ZERO_MCP_ATTRIBUTION_HEADERS_JSON");
      const attribution = resolveAttribution({
        scopeFileBlock: scope ? extractAttributionFromScopeJson(scope.raw) : undefined,
        env: process.env,
        cliHeaders: attributionHeaders,
        cliUaToken: process.env["ZERO_MCP_ATTRIBUTION_UA_TOKEN"],
      });
      const rateLimitConfig = clampRateLimitToPosture(
        parseRateLimitFlag(opts.rateLimit ?? "", MCP_DEFAULT_RPS),
        posture,
      );
      const rateLimiter = new RateLimiter(rateLimitConfig);

      // Auditable evidence of how this session actually ran: the same
      // `engagement_posture_applied` record the scan path writes, so an
      // MCP-driven engagement can answer "how did you run this against our
      // estate?" from the DB as well as from the session transcript. Only when
      // a profile is active — a default session records nothing new.
      // The record's `per_host_rps` is the posture's nominal rate. Because the
      // clamp above can only lower it, the record can never claim the session
      // ran quieter than it did; the stderr line prints the exact effective
      // rate for the case where `--rate-limit` was stricter still.
      if (posture.active) {
        const postureRecord = describeEngagementPosture(posture);
        try {
          db.logEvent({
            scanId,
            stage: "mcp-server",
            eventType: "engagement_posture_applied",
            payload: { ...postureRecord },
            timestamp: Date.now(),
          });
        } catch (err) {
          // pipeline_events FKs to scans(id). An MCP session pointed at a scan
          // this DB has never seen must not fail to start over an audit row —
          // the stderr record below still stands as evidence.
          console.error(
            `warning: could not persist engagement posture for scan ${scanId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        // stdout is the MCP transport, so operator-facing output goes to stderr.
        console.error(
          `Engagement profile '${postureRecord.profile}': ` +
            `WAF evasion ladder ${postureRecord.waf_evasion_ladder}, ` +
            `${rateLimitConfig.default.rps} rps/host with ${postureRecord.request_jitter}`,
        );
      }

      const executor = new ToolExecutor(
        {
          target,
          scanId,
          findings: [],
          attackResults: [],
          targetInfo: {},
          persistFindings: true,
          scope,
          rateLimiter,
          allowScanners: opts.allowScanners,
          attribution,
          engagement: posture,
          authConfig: parseAuthEnv(),
        },
        db,
      );

      const server = new McpServer(
        { name: "0-mcp", version: "0.1.0" },
        { capabilities: { logging: {} } },
      );

      const tools = getToolsForRole("attack", { webMode: true })
        .filter((tool) => selectedToolNames.has(tool.name));
      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.name,
            description: tool.description,
            inputSchema: zodForTool(tool),
          },
          async (args) => toolResultToMcp(
            await withToolTimeout(
              executor.execute({
                name: tool.name,
                arguments: args as Record<string, unknown>,
              }),
              timeoutMs,
            ),
          ),
        );
      }

      let workflowRuntime: WorkflowRuntime | undefined;
      try {
        if (workflowsEnabled) workflowRuntime = await registerWorkflowTools(server, selectedToolNames, opts);
      } catch (error) {
        await executor.cleanup();
        db.close();
        throw error;
      }
      const transport = new StdioServerTransport();

      const shutdown = async () => {
        await workflowRuntime?.dispose();
        await executor.cleanup();
        await server.close();
        db.close();
        process.exit(0);
      };

      transport.onclose = () => { void workflowRuntime?.dispose(); };

      process.on("SIGINT", () => { void shutdown(); });
      process.on("SIGTERM", () => { void shutdown(); });

      try {
        await server.connect(transport);
        console.error(`0 MCP server running for ${target} (scan ${scanId})`);
      } catch (error) {
        console.error("Fatal error in 0 MCP server:", error);
        await workflowRuntime?.dispose();
        await executor.cleanup();
        db.close();
        process.exit(1);
      }
    });
}
