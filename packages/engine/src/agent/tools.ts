
import { subagentBatchLimit, subagentConcurrency } from "./subagent-limits.js";
import { assertExpectedWorkspace, assertWorkspaceIdentity, type ExpectedWorkspace, type WorkspaceIdentity } from "./workspace-identity.js";
import { withWorkflowAuditExecutionPolicy, getWorkflowAuditExecutionPolicy, type WorkflowHttpMethod } from "../workflow-execution-policy.js";
import { DelegatedFindingPersistenceResult, DelegatedFindingUpdateResult } from "./types.js";
import { SubagentModelSelection } from "../runtime/types.js";
import { SubagentLifecyclePayload } from "../events/bus.js";
import { ToolHealthRecordInput } from "./tool-health.js";
import { drainInbox, newMessageId, sendMessage, type HubMessage } from "../hub/mailbox.js";
import { agentTaskLabel, assignAgentName } from "../hub/name-generator.js";
import { runPersistentAgent } from "../hub/supervisor.js";
import { BackgroundAgentQueue } from "./background-agent-queue.js";
import { MAX_DRAINS_PER_TURN, clampOutboundBody, decideAddressing, renderInboundBatch, type MessagingRuntime } from "./agent-messaging.js";
import { mapWithConcurrency } from "../concurrency.js";
import { SUBAGENT_MODEL_TIMEOUT_MS } from "./tools/exec-helpers.js";
import { SUBAGENT_PEER_PAGE_SIZE, sanitizeSubagentNote, REPORT_STATUS_TOOL, messagingRuntimeOf, buildSendMessageTool, subagentSiblingPrefix, buildSiblingMessagingBatch, CHECK_MESSAGES_TOOL, renderSubagentMessagingPrompt, PERSIST_POLL_MS, PERSIST_IDLE_TTL_MS, PERSIST_MAX_REVIVES, subagentWorkspaceSchema, subagentModelSelectionSchema, validateSpawnPersistentAgentArgs, type SubagentOutcome, type SubagentRunReport, type SubagentLifecycleBase, buildSubagentProgress, buildSubagentMessage, type SubagentDeps } from "./tools/subagents.js";
import { CHILD_LOCAL_DISPATCH } from "./tools/subagents.js";
import { join } from "node:path";
import { toolExecutorCheckpointSchema } from "./tools/agent-args.js";
import { PRIMARY_AGENT_NAME } from "../hub/name-generator.js";
import { captureWorkspaceIdentity } from "./workspace-identity.js";
import { filterWorkflowAgentTools, isWorkflowAgentToolAllowed, type WorkerPolicy, snapshotWorkerPolicy } from "../workflow-execution-policy.js";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync, existsSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import type { Finding } from "../shared/index.js";
import type { ToolDefinition, ToolCall, ToolResult, ToolResultMeta, ToolContext } from "./types.js";
import type { NativeRuntime } from "../runtime/types.js";
import { runBeforeCommand } from "./before-command.js";
import { hookInputForTool } from "./command-hook.js";
import { fetchScoped } from "../http.js";
import { buildAuthHeaders } from "./prompts.js";
import { formatTruncated } from "./output-truncation.js";
import { isRepoRelativePath, isSuggestionAcceptable, probeFileRefTarget } from "../findings-parser.js";
import type { osecDB } from "../storage/index.js";
import { searchParallel } from "./tools/web-search-parallel.js";
import { parseDuckDuckGoResults, readWebSearchResponse } from "./tools/web-search-response.js";
import { features as featureFlags } from "./features.js";
import { sanitizedEnv } from "./sanitized-env.js";
import { extractPocStepsFromProse } from "./poc-steps-from-prose.js";
import { computeFindingConfidence } from "./finding-confidence.js";
import { validateFindingDraft, type FindingDraft } from "./finding-validator.js";
import { findMatchingFindingCandidate } from "./tools-helpers.js";
import { resolvePacks } from "./toolset.js";
import { listSkillSummaries, getSkillById, matchTriggers, loadSkillRegistry } from "./skills/index.js";
import type { SkillDefinition } from "./skills/index.js";
import { loadSkillBundleFromManifest } from "./skills/markdown-bundle.js";
import { discoverAgentSkills, isAgentSkillAllowed, loadAgentSkill } from "./skills/agent-skills.js";
import { eventBus } from "../events/bus.js";
import { ToolHealthTracker } from "./tool-health.js";
import type { ToolHealthSummary } from "./tool-health.js";
import { AuditWorkerTree } from "./worker-tree.js";
import { MCP_TOOL_PREFIX } from "./mcp-adapt.js";
import { LIST_TOOLS_NAME, LOAD_TOOL_NAME, formatToolCatalog, formatLoadResult } from "./deferred-tools.js";
import { resolveFolderPath } from "./tools/folder-path.js";
import { TOOL_DEFINITIONS } from "./tools/index.js";
import { TOOL_DISPATCH } from "./tools/dispatch.js";
import { memoryArgsSchema, nonEmptyString, buildOperatorQuestionRequest, type ToolExecutorCheckpoint, inlineImpactAssessmentSchema } from "./tools/agent-args.js";
import { resolveBashWallclockCeilingMs, runBashWithWallclock, buildStrReplaceMeta } from "./tools/exec-helpers.js";
import { parseVerificationSpecArg, autoVerificationSpec, evaluateSourceVerification, parsePocStepsArg, parseEvidencePathsArg, buildValidationFailureResult } from "./tools/verification.js";
import { citedSourceHasKnownMarker } from "./tools/probe-helpers.js";
import { mcpHostOf, deferredToolsOf, packToolsOf } from "./tools/context-hosts.js";

// ── Tool registry (0#611) ──
// The per-tool ToolDefinition objects now live in per-domain modules under
// ./tools/ and are assembled — in canonical order — by the ./tools/index.ts
// barrel. They are re-exported here so every existing importer of
// `./tools.js` (agent/index.ts, native-loop, egats, racing, agentic-scanner,
// the test suites) keeps resolving them, and so getToolsForRole /
// ToolExecutor below see them as local bindings. Splitting the old 600-line
// literal lets parallel feature PRs touch disjoint domain files instead of
// serializing on one merge-conflict chokepoint.

export {
  TOOL_DEFINITIONS,
};

// Tool-name → handler-method-name routing table (0#614), assembled from
// per-domain `*Dispatch` maps. `ToolExecutor._dispatch` resolves the handler
// off the instance by this name, replacing the hand-written switch so adding a
// tool no longer edits a shared dispatch chokepoint.

export { sanitizedEnv } from "./sanitized-env.js";

// ── Public API moved to ./tools/*.ts (re-exported unchanged) ──
export { MIN_OPERATOR_QUESTIONS, MAX_OPERATOR_QUESTIONS, MIN_OPERATOR_OPTIONS, MAX_OPERATOR_OPTIONS, buildOperatorQuestionRequest, toolExecutorCheckpointSchema } from "./tools/agent-args.js";
export { parseVerificationSpecArg, autoVerificationSpec, parsePocStepsArg, parseEvidencePathsArg, buildValidationFailureResult } from "./tools/verification.js";
export type { OperatorQuestionBuildResult, ToolExecutorCheckpoint } from "./tools/agent-args.js";
export { sanitizeSubagentNote, buildSendMessageTool, buildSiblingMessagingBatch, buildSubagentProgress, buildSubagentMessage } from "./tools/subagents.js";


// ── Tool Executor ──

export class ToolExecutor {
  private db: osecDB | null;
  private ctx: ToolContext;
  private readonly _credentialTarget: string;
  private readonly _workerTree: AuditWorkerTree;
  private readonly _ownsWorkerTree: boolean;
  /**
   * Lazily loaded cloud audit-skill bundle from ZERO_AUDIT_SKILLS_MANIFEST.
   * null = env not set (no cloud skills); Map = already loaded and cached.
   * Populated on first loadSkill call that finds the env var.
   */
  private _cloudSkillBundle: Map<string, SkillDefinition> | null | undefined;

  private readonly _executionContext = new AsyncLocalStorage<{ correlationId?: string; signal?: AbortSignal; assertAuthority?: () => void }>();
  private get _correlationId(): string | null {
    return this._executionContext.getStore()?.correlationId ?? null;
  }

  /**
   * Id factory for tool-minted correlation ids (currently the `ask_operator`
   * request id). Injectable so tests get deterministic ids; defaults to
   * `randomUUID`. Mirrors the injectable-factory pattern the pure builders use.
   */
  private _idFactory: () => string;

  /**
   * Tool-health recorder (0#tool-reliability). Uses the shared tracker on
   * the ToolContext when the caller wired one (so the run summary sees the same
   * events), else a private per-executor tracker so recording is always safe.
   * Either way, new distinct events fan out on the event bus as `tool_health`.
   */
  private _toolHealth: ToolHealthTracker;

  /** Search policy changes require quiescent children so their inherited policy stays consistent. */
  configureWebSearch(enabled: boolean): void {
    if (this._workerTree.hasLiveWorkers()) throw new Error("Finish active agents before changing web search.");
    this.ctx.webSearchEnabled = enabled;
  }

  private checkedWorkerPolicy(policy: WorkerPolicy | undefined): WorkerPolicy | undefined {
    const snapshot = snapshotWorkerPolicy(policy);
    for (const name of snapshot?.allowedTools ?? []) {
      if (!Object.hasOwn(TOOL_DEFINITIONS, name)) {
        throw new Error(`Worker policy contains unknown tool "${name}"`);
      }
    }
    return snapshot;
  }

  /** Host configuration only: no model tool exposes this setter. */
  configureWorkerPolicy(policy: WorkerPolicy | undefined): void {
    if (this._workerTree.hasLiveWorkers()) throw new Error("Finish active agents before changing the worker policy.");
    this.ctx.workerPolicy = this.checkedWorkerPolicy(policy);
  }

  /** Called only after explicit operator folder approval while the engine is idle. */
  configureWorkspace(path: string): void {
    this.ctx.scopePath = path;
    this.ctx.workspaceRoot = path;
    this._workspaceIdentity = captureWorkspaceIdentity(path);
  }

  constructor(
    ctx: ToolContext,
    db: osecDB | null = null,
    idFactory: () => string = () => randomUUID(),
    childRuntimeFactory?: NativeRuntime["forkForSubagent"],
    initialCheckpoint?: ToolExecutorCheckpoint,
  ) {
    this.ctx = ctx;
    this.ctx.workerPolicy = this.checkedWorkerPolicy(ctx.workerPolicy);
    this._credentialTarget = initialCheckpoint?.credentialTarget ?? ctx.target;
    this._assignedAgentNames = new Set(initialCheckpoint?.assignedAgentNames ?? [PRIMARY_AGENT_NAME]);
    this._childRuntimeFactory = childRuntimeFactory;
    this._workspaceIdentity = ctx.workspaceIdentity ?? captureWorkspaceIdentity(ctx.scopePath);
    this.db = db;
    this._idFactory = idFactory;
    if (initialCheckpoint) {
      this._msgDrainTurn = initialCheckpoint.msgDrainTurn;
      this._msgDrainCount = initialCheckpoint.msgDrainCount;
    }
    this._workerTree = ctx.workerTree ?? new AuditWorkerTree(ctx.scanId);
    this._ownsWorkerTree = ctx.workerTree === undefined;
    this._workerFindings = ctx.workerTree ? (ctx.workerFindings ?? ctx.findings) : ctx.findings;
    this._toolHealth =
      ctx.toolHealth ??
      new ToolHealthTracker({
        seed: initialCheckpoint?.toolHealth,
        emit: (event) => {
          eventBus.emit("tool_health", {
            tool: event.tool,
            category: event.category,
            message: event.message,
            ...(event.remedy ? { remedy: event.remedy } : {}),
            count: event.count,
          });
        },
      });
  }

  // ── Checkpoint export (engine replacement boundary) ──────────────────

  /**
   * Produce a defensively-copied snapshot of this executor's memory state,
   * suitable for JSON-serialization and later restoration into a new executor
   * via the fifth constructor argument.
   *
   * **Explicitly excluded** (live resources drained by the caller / old engine):
   *   - `_workerTree` / `_ownsWorkerTree` / `_workerFindings` (worker subprocesses)
   *   - `_processManager` (ProcessManager — supervised monitor processes)
   *   - `_executionContext` (AsyncLocalStorage — per-execution, not per-session)
   *   - `db` / `ctx` (caller-provided, re-passed to the new constructor)
   *   - `_idFactory` / `_childRuntimeFactory` (caller-provided, re-passed)
   *
   * The returned data is a plain struct — Set/Map fields are flattened to
   * JSON-safe arrays. Callers should pass it through
   * `toolExecutorCheckpointSchema` for structural validation.
   */
  exportCheckpoint(): ToolExecutorCheckpoint {
    // Background agents/workers can mutate findings, authority memory, and
    // identifier state after the snapshot is taken but before the old engine
    // retires. Reject the checkpoint while owned workers are still live so
    // callers (turn-engine) wait for worker completion or operator intervention
    // before the handoff. Borrowed trees (owned by a parent executor) are not
    // checked — the parent is responsible for its own liveness gate.
    if (this._ownsWorkerTree && this._workerTree.hasLiveWorkers()) {
      throw new Error(
        "Cannot export checkpoint while owned background agents are still running. " +
        "Wait for workers to complete or stop them before the engine replacement.",
      );
    }
    return {
      credentialTarget: this._credentialTarget,
      assignedAgentNames: [...this._assignedAgentNames],
      msgDrainTurn: this._msgDrainTurn,
      msgDrainCount: this._msgDrainCount,
      toolHealth: this._toolHealth.list().map(event => ({ ...event })),
    };
  }

  /**
   * Concise roll-up of tool-health events recorded by this executor, for the
   * per-run "N tool issues" line and the CLI /doctor path.
   */
  toolHealthSummary(): ToolHealthSummary {
    return this._toolHealth.summary();
  }

  private usesTargetIdentity(url: string): boolean {
    try {
      return new URL(url, this._credentialTarget).origin === new URL(this._credentialTarget).origin;
    } catch {
      return false;
    }
  }

  /**
   * Build environment variables for auth credentials, making them available
   * to shell commands (curl, python3, etc.) via $AUTH_HEADER / $AUTH_VALUE.
   */
  private buildAuthEnvVars(): Record<string, string> {
    const auth = this.ctx.authConfig;
    if (!auth || !this.usesTargetIdentity(this.ctx.target)) return {};

    const headers = buildAuthHeaders(auth);
    const entries = Object.entries(headers);
    if (entries.length === 0) return {};

    const [headerName, headerValue] = entries[0];
    return {
      AUTH_HEADER: headerName,
      AUTH_VALUE: headerValue,
      // Convenience: full curl-style header flag
      AUTH_CURL_FLAG: `-H '${headerName}: ${headerValue}'`,
    };
  }

  /** Stop an owned subtree; completion means all worker cleanup has drained. */
  async stopPersistentAgent(agentId: string): Promise<boolean> {
    return this._workerTree.stop(agentId, this.ctx.scanId);
  }

  /** Stop owned workers while retaining the conversation and root executor. */
  async stopPersistentAgents(): Promise<void> {
    await this._workerTree.stopAll(this.ctx.scanId);
  }

  /** Clean up background workers and processes. Call when the agent loop ends. */
  async cleanup(): Promise<void> {
    if (this._ownsWorkerTree) await this._workerTree.close();
  }

  /**
   * Dispatch one tool call.
   *
   * `opts.correlationId` is the action-level join key minted by the agent loop
   * (see `agent/action-log.ts`); it is stamped onto any `tool_artifact` this
   * call persists. Restored (not just cleared) on exit so a nested dispatch
   * can't strand a stale id.
   */
  async execute(call: ToolCall, opts?: { correlationId?: string; signal?: AbortSignal; assertAuthority?: () => void }): Promise<ToolResult> {
    const inherited = this._executionContext.getStore();
    const signal = opts?.signal ?? inherited?.signal;
    const ownAuthority = opts?.assertAuthority;
    const inheritedAuthority = inherited?.assertAuthority;
    const assertAuthority = ownAuthority && inheritedAuthority && ownAuthority !== inheritedAuthority
      ? () => { inheritedAuthority(); ownAuthority(); }
      : ownAuthority ?? inheritedAuthority;
    return this._executionContext.run({ correlationId: opts?.correlationId, signal, assertAuthority }, async () => {
    try {
      signal?.throwIfAborted();
      assertAuthority?.();
      if (call.name === "web_search" && this.ctx.webSearchEnabled === false) return { success: false, output: null, error: "Web search is disabled for this chat." };
      if (!isWorkflowAgentToolAllowed(call.name)) return { success: false, output: null, error: `Tool "${call.name}" is not allowed in this workflow phase` };
      if (this.ctx.workerTree && this.ctx.delegationTools &&
          !this.ctx.delegationTools.some(tool => tool.name === call.name)) {
        return { success: false, output: null, error: `Tool "${call.name}" is not available to this delegated agent` };
      }
      signal?.throwIfAborted();
      assertAuthority?.();

      const gated = await this._beforeCommandGate(call);
      if (gated) return gated;

      if (call.name === "bash" || call.name === "str_replace") this._workerTree.recordLocalEffect(this.ctx.scanId, call.name);
      return await this._dispatch(call);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
    });
  }

  /**
   * The single `beforeCommand` decision point for the engine path. Every executing tool (see agent/command-hook.ts)
   * passes through here before its handler runs, including repository acquisition (a bash command) and tools that a
   * delegated agent calls. Only a deny matters here; an ask is answered by the console session before dispatch.
   */
  private async _beforeCommandGate(call: ToolCall): Promise<ToolResult | null> {
    const input = hookInputForTool(call.name, (call.arguments ?? {}) as Record<string, unknown>, {
      cwd: this.ctx.scopePath ?? this.ctx.workspaceRoot ?? process.cwd(),
      thread: {},
    });
    if (!input) return null;
    const outcome = await runBeforeCommand(input);
    if (outcome.decision !== "deny") return null;
    return { success: false, output: null, error: `${call.name} refused: ${outcome.reason}` };
  }

  private async _dispatch(call: ToolCall): Promise<ToolResult> {
    try {
      // Resolve the handler off this instance by name. TOOL_DISPATCH (assembled
      // from the per-domain `*Dispatch` maps in tools/) is the single seam where
      // a tool name meets its still-private handler method; the cast is
      // contained here and guarded by tools/dispatch.test.ts, which pins the
      // full routing and asserts every name resolves to a real method. An
      // unmapped (or, defensively, unresolvable) name returns the same
      // "Unknown tool" result the previous switch's default did.
      // Child-only routes (e.g. `report_status`) are resolved FIRST, off the
      // local map, because they are intentionally absent from the global
      // TOOL_DISPATCH barrel that tools/dispatch.test.ts pins against the
      // registry. They still resolve to a real private method below.
      const methodName = CHILD_LOCAL_DISPATCH[call.name] ?? TOOL_DISPATCH[call.name];
      const handler = methodName
        ? (this as unknown as Record<
            string,
            (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
          >)[methodName]
        : undefined;
      if (typeof handler !== "function") {
        // Not a built-in: it may be a deferred-tool control call (list_tools /
        // load_tool — progressive disclosure over a high-cardinality catalog).
        const deferred = this._dispatchDeferredControl(call);
        if (deferred) return deferred;
        // Or a tool from a connected MCP server. The `mcp__<server>__<tool>`
        // host connects and forwards the result without rewriting its content.
        if (call.name.startsWith(MCP_TOOL_PREFIX)) {
          const host = mcpHostOf(this.ctx);
          if (host) return await host.callTool(call.name, (call.arguments ?? {}) as Record<string, unknown>);
        }
        return { success: false, output: null, error: `Unknown tool: ${call.name}` };
      }
      return await handler.call(this, call.arguments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  private memoryTool(args: Record<string, unknown>): ToolResult {
    if (!this.ctx.memory) return { success: false, output: null, error: "Memory is unavailable in this session" };
    const parsed = memoryArgsSchema.safeParse(args);
    if (!parsed.success) return { success: false, output: null, error: parsed.error.issues[0]?.message ?? "Invalid memory request" };
    try { return { success: true, output: this.ctx.memory(parsed.data) }; }
    catch (error) { return { success: false, output: null, error: error instanceof Error ? error.message : String(error) }; }
  }

  /**
   * Resolve the two deferred-tool control calls (`list_tools` / `load_tool`)
   * against the session's {@link DeferredToolRegistry}. Returns null when this
   * is not a control call or no registry is wired (so the caller falls through
   * to extension/MCP dispatch or "Unknown tool"). `load_tool` mutates the loaded
   * set; the change is picked up by the next turn's tool-set refresh, so a loaded
   * tool becomes callable on the following turn — never mid-round.
   */
  private _dispatchDeferredControl(call: ToolCall): ToolResult | null {
    if (call.name !== LIST_TOOLS_NAME && call.name !== LOAD_TOOL_NAME) return null;
    const registry = deferredToolsOf(this.ctx);
    if (!registry) return null;
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    if (call.name === LIST_TOOLS_NAME) {
      const query = typeof args.query === "string" ? args.query : undefined;
      return { success: true, output: formatToolCatalog(registry.catalogEntries(query), query) };
    }
    // load_tool: names must be a string array (validate, then act).
    const raw = args.names;
    const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
    if (names.length === 0) {
      return {
        success: false,
        output: null,
        error: "load_tool requires a non-empty `names` array of exact tool names (see list_tools).",
      };
    }
    return { success: true, output: formatLoadResult(registry.load(names)) };
  }

  /** `finding`: no `id` saves a new finding; an `id` updates that finding's status. */
  private async findingTool(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.id === "string" && args.id.trim()) {
      return this.updateFinding({ finding_id: args.id.trim(), status: args.status });
    }
    if (typeof args.title !== "string" || !args.title.trim()) {
      return { success: false, output: null, error: "finding: to save a new finding provide at least title (and severity, category, evidence_request, evidence_response); to update one provide id and status" };
    }
    return this.saveFinding(args);
  }

  /**
   * Persist a tool call's request/response as a first-class run artifact via
   * the event pipeline.
   *
   * Stamps the in-flight `correlationId` (when the caller supplied one) so the
   * artifact joins exactly to its `tool_calls` entry — the artifact carries the
   * real URL / method / command, the entry carries the wall clock.
   */
  private persistToolArtifact(toolName: string, data: Record<string, unknown>): void {
    if (!this.db) return;
    try {
      this.db.logEvent({
        scanId: this.ctx.scanId,
        stage: "attack",
        eventType: "tool_artifact",
        payload: {
          tool: toolName,
          ...(this._correlationId ? { correlationId: this._correlationId } : {}),
          ...data,
        },
        timestamp: Date.now(),
      });
    } catch {
      // Non-critical — don't fail the tool call if artifact persistence fails
    }
  }

  private async shellExec(args: Record<string, unknown>): Promise<ToolResult> {
    let command = (args.command as string)?.trim();
    if (!command) {
      return { success: false, output: null, error: "Command is required" };
    }
    // Per-call requested timeout (caller arg) is clamped against the wallclock
    // ceiling. Even if the caller asks for a longer one, we never exceed the
    // ceiling — a runaway subprocess (e.g. python3 requests.post with no
    // timeout) must not be able to wedge the agent indefinitely.
    const ceilingMs = resolveBashWallclockCeilingMs();
    const requestedMs = Math.max(1, ((args.timeout as number) ?? 30) * 1000);
    const timeoutMs = Math.min(requestedMs, ceilingMs);

    // A script of an enabled, approved extension gets its declared and approved variables (a connector's stored token
    // included) and nothing else; the value never comes back (see runBashWithWallclock `redact`).
    const cwd = this.ctx.scopePath ?? this.ctx.workspaceRoot;
    const extensionRun = this.ctx.extensionRuns?.prepare(command, { cwd });
    if (extensionRun && !extensionRun.ok) return { success: false, output: null, error: `bash refused: ${extensionRun.error}` };
    const env = { ...sanitizedEnv(), TARGET: this.ctx.target, ...this.buildAuthEnvVars(), ...(extensionRun?.env ?? {}) };

    // The command the OPERATOR asked for (the value may have been rewritten by
    // auth-header injection above; the card shows the model's original intent).
    const displayCommand = (args.command as string).trim();
    const startedAt = Date.now();
    const outcome = await runBashWithWallclock(command, {
      timeoutMs, ceilingMs, env, cwd, signal: this._executionContext.getStore()?.signal,
      ...(extensionRun?.secrets.length ? { redact: extensionRun.secrets } : {}),
    });
    const durationMs = Date.now() - startedAt;

    if (outcome.kind === "timeout") {
      this.persistToolArtifact("bash", {
        command: command.slice(0, 500),
        output: outcome.partial.slice(0, 2_000),
        timedOut: true,
        timeoutMs,
      });
      const partial = formatTruncated(outcome.partial);
      return {
        success: false,
        output: null,
        error: `bash tool timed out after ${Math.round(timeoutMs / 1000)}s (ZERO_BASH_TIMEOUT_MS=${ceilingMs})`,
        // Display-only card sidecar (never seen by the model): the partial
        // output plus the wall clock, so a timed-out run still renders a card.
        meta: {
          kind: "command",
          command: displayCommand,
          exitCode: null,
          durationMs,
          timeoutMs,
          timedOut: true,
          stdout: partial,
        },
      };
    }

    if (outcome.kind === "error") {
      return {
        success: false,
        output: null,
        error: outcome.message.slice(0, 2_000),
        meta: {
          kind: "command",
          command: displayCommand,
          exitCode: null,
          durationMs,
          timeoutMs,
          timedOut: false,
          stdout: "",
        },
      };
    }

    // Middle-out under the shared tool-output policy. The old head-only
    // 10,000-CHAR slice dropped the tail of every long run — and for a scanner
    // the tail is the verdict (exit status, sanitizer summary, final error).
    const combined = formatTruncated(outcome.combined);

    // Many pentesting tools exit non-zero on findings — if we got output,
    // surface it as success regardless of exit code (preserves prior behaviour).
    const commandMeta = {
      kind: "command" as const,
      command: displayCommand,
      exitCode: outcome.exitCode,
      durationMs,
      timeoutMs,
      timedOut: false,
      stdout: combined,
    };
    if (outcome.exitCode === 0 || combined.length > 0) {
      this.persistToolArtifact("bash", {
        command: command.slice(0, 500),
        output: combined.slice(0, 2_000),
        ...(outcome.exitCode !== 0 ? { exitCode: outcome.exitCode } : {}),
      });
      return { success: true, output: combined, meta: commandMeta };
    }

    return {
      success: false,
      output: null,
      error: `bash exited with code ${outcome.exitCode}`,
      meta: commandMeta,
    };
  }

  private async saveFinding(args: Record<string, unknown>): Promise<ToolResult> {
    // 0#283 — refuse empty-PoC findings upstream. Disclose already
    // refuses empty PoCs at render time (`disclose/template.ts` EmptyPocError),
    // but accepting them here silently inflates mid-scan telemetry and burns
    // turns on findings that will be `_dropped/`'d at disclose time. Pull the
    // gate upstream so the agent sees its own bad finding rejected with a
    // specific hint — same retry-friendly shape as flag-validator at
    // `markDone`.
    const requestRaw = args.evidence_request;
    const responseRaw = args.evidence_response;
    const descriptionRaw = args.description;
    const requestEmpty =
      typeof requestRaw !== "string" || !requestRaw.trim();
    const responseEmpty =
      typeof responseRaw !== "string" || !responseRaw.trim();
    const pocStepsEmpty =
      !args.poc_steps ||
      (Array.isArray(args.poc_steps) && args.poc_steps.length === 0) ||
      (typeof args.poc_steps === "string" && !args.poc_steps.trim());
    const descriptionEmpty =
      typeof descriptionRaw !== "string" || !descriptionRaw.trim();
    if (requestEmpty && responseEmpty && pocStepsEmpty && descriptionEmpty) {
      return {
        success: false,
        output: null,
        error:
          "finding requires non-empty evidence_request, evidence_response, poc_steps, or description. " +
          "For static-analysis findings, provide a description with the code path and trigger conditions.",
      };
    }

    // 0#409 — structural validation at the report-creation boundary.
    // CVE/CWE/CVSS shape + evidence-path traversal/symlink-escape guards.
    // Failures return as a structured `validation_failed` tool result so the
    // agent can self-correct on the same turn (same UX as flag-validator at
    // `markDone`). We deliberately do NOT auto-uppercase or re-format
    // malformed values: the model has to learn the canonical shape.
    //
    // We skip when `scopePath` is unset (no workspace root → no path guard
    // possible). CVE/CWE/CVSS still get checked; evidence paths get a
    // permissive pass since we have no root to compare against. In every
    // production code path scopePath IS set (it's the scan workspace).
    const sourcePath =
      typeof args.source_path === "string" && args.source_path.trim()
        ? args.source_path.trim()
        : undefined;
    // Mirror the cloud schema's repo-relative path rule (leading `/`, drive
    // letters, backslashes, `..` segments) at the tool boundary. Anything
    // that passes here but fails cloud validation would 400 the ENTIRE
    // finding POST at the sink — see findings-parser.ts isRepoRelativePath.
    if (sourcePath && !isRepoRelativePath(sourcePath)) {
      return buildValidationFailureResult([
        {
          field: "source_path",
          reason:
            "source_path must be repository-relative: no leading '/', drive-letter prefixes, backslashes, or parent-directory ('..') segments",
        },
      ]);
    }
    if (sourcePath && !this.ctx.scopePath) {
      return buildValidationFailureResult([
        {
          field: "source_path",
          reason: "source annotations require a scan workspace",
        },
      ]);
    }
    const evidencePaths = parseEvidencePathsArg(args.evidence_paths);
    const draft: FindingDraft = {
      cve: typeof args.cve === "string" ? args.cve : undefined,
      cwe: typeof args.cwe === "string" ? args.cwe : undefined,
      cvss: typeof args.cvss === "string" ? args.cvss : undefined,
      cvssScore:
        typeof args.cvss_score === "number" ? args.cvss_score : undefined,
      evidence: sourcePath
        ? [...evidencePaths, { path: sourcePath }]
        : evidencePaths,
    };
    if (this.ctx.scopePath) {
      const validation = validateFindingDraft(draft, {
        scanWorkspaceRoot: this.ctx.scopePath,
      });
      if (!validation.ok) {
        return buildValidationFailureResult(validation.errors);
      }
    }

    const evidenceAnalysis = typeof args.evidence_analysis === "string" ? args.evidence_analysis : undefined;

    const finding: Finding = {
      id: randomUUID(),
      templateId: (args.template_id as string) ?? "manual",
      title: (args.title as string) ?? "Untitled finding",
      description: (args.description as string) ?? "",
      severity: (args.severity as Finding["severity"]) ?? "medium",
      category: (args.category as Finding["category"]) ?? "prompt-injection",
      status: "discovered",
      evidence: {
        request: (args.evidence_request as string) ?? "",
        response: (args.evidence_response as string) ?? "",
        analysis: evidenceAnalysis,
      },
      timestamp: Date.now(),
    };

    if (sourcePath) {
      const startLine = args.source_start_line;
      const endLine = args.source_end_line;
      if (
        !Number.isInteger(startLine) ||
        (startLine as number) < 1 ||
        (endLine !== undefined &&
          (!Number.isInteger(endLine) ||
            (endLine as number) < (startLine as number)))
      ) {
        return buildValidationFailureResult([
          {
            field: "source_start_line",
            reason:
              "source_path requires a positive integer start line and an optional end line >= start line",
          },
        ]);
      }
      // Existence + line-range probe — the SAME check the CLI findings
      // parser runs (findings-parser.ts validateFileRef via
      // probeFileRefTarget). Unlike the CLI-parsed path, which downgrades
      // and keeps the finding (severity info / status false-positive /
      // triageNote), the interactive tool call REJECTS with a structured
      // validation error so the model can self-correct and re-submit on the
      // same turn without evaluating a false-positive finding. The probe
      // never throws and yields no lineCount for
      // directories/oversized/unreadable files, in which case the line-range
      // check is skipped (conservative).
      // `this.ctx.scopePath` is guaranteed set by the workspace guard above.
      const sourceAbsolute = resolve(this.ctx.scopePath!, sourcePath);
      const probe = probeFileRefTarget(sourceAbsolute, this.ctx.scopePath!);
      const lastLine =
        endLine !== undefined ? (endLine as number) : (startLine as number);
      if (!probe.exists) {
        return buildValidationFailureResult([
          {
            field: "source_path",
            reason: `file not found: ${sourcePath}`,
          },
        ]);
      }
      if (
        probe.lineCount !== undefined &&
        lastLine > probe.lineCount
      ) {
        return buildValidationFailureResult([
          {
            field: "source_start_line",
            reason: `line ${lastLine} exceeds file length (${probe.lineCount} lines) in ${sourcePath}`,
          },
        ]);
      }
      // GitHub can only apply a replacement to right-side added lines. Check
      // the exact bound base/head diff here, before saving a suggestion, so a
      // mistaken citation returns a correction to the agent instead of silently
      // disappearing from the PR. Never shift an off-by-one line automatically:
      // the neighbouring line may contain a different security decision.
      if (typeof args.suggested_replacement === "string" &&
          args.suggested_replacement.length > 0 && this.ctx.reviewDiffBase) {
        const diff = spawnSync("git", [
          "diff", "--no-ext-diff", "--no-textconv", "--unified=0",
          `${this.ctx.reviewDiffBase}...HEAD`, "--", sourcePath,
        ], { cwd: this.ctx.scopePath, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
        const changed = new Set<number>();
        if (diff.status === 0 && !diff.error) {
          for (const line of diff.stdout.split("\n")) {
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!hunk) continue;
            const start = Number(hunk[1]), count = Number(hunk[2] ?? 1);
            if (count > 20_000) break;
            for (let offset = 0; offset < count; offset++) changed.add(start + offset);
          }
        }
        let allAdded = true;
        for (let line = startLine as number; line <= lastLine; line++) {
          if (!changed.has(line)) { allAdded = false; break; }
        }
        if (diff.status !== 0 || diff.error || !allAdded) {
          return buildValidationFailureResult([{
            field: "source_start_line",
            reason: `suggested_replacement must cite added lines in the bound diff; ${sourcePath} changed at ${[...changed].slice(0, 20).join(", ") || "no verifiable added lines"}. Read the numbered source and cite the exact changed line, or omit the replacement.`,
          }]);
        }
        const original = args.source_original;
        const currentText = statSync(sourceAbsolute).size > 2 * 1024 * 1024
          ? undefined
          : readFileSync(sourceAbsolute, "utf8").replace(/\r\n/g, "\n")
            .split("\n").slice((startLine as number) - 1, lastLine).join("\n");
        if (typeof original !== "string" || !original || currentText === undefined || currentText !== original) {
          // Quote the cited lines so the agent can correct a near miss (for example a range wider
          // than the text it copied) instead of dropping the suggestion. This is repository text
          // the agent can already read; the quote is bounded.
          const quote = currentText === undefined
            ? ""
            : ` Lines ${startLine}-${lastLine} currently read exactly:\n${currentText.slice(0, 2000)}`;
          return buildValidationFailureResult([{
            field: "source_original",
            reason: "suggested_replacement requires the exact current text of the cited changed lines, including indentation and without line-number prefixes. Re-read the source and correct the citation or omit the replacement." + quote,
          }]);
        }
      }
      // Oversized / fenced / unified-diff suggestions are dropped (never
      // truncated), keeping the location — same gate as the CLI parser and
      // the cloud sink (findings-parser.ts isSuggestionAcceptable).
      const suggestion = args.suggested_replacement;
      finding.reviewAnnotation = {
        path: sourcePath,
        startLine: startLine as number,
        ...(endLine !== undefined ? { endLine: endLine as number } : {}),
        ...(typeof suggestion === "string" &&
        suggestion.length > 0 &&
        isSuggestionAcceptable(suggestion)
          ? { suggestion }
          : {}),
        ...(citedSourceHasKnownMarker(
          sourceAbsolute,
          startLine as number,
          lastLine,
        )
          ? { knownMarker: true }
          : {}),
      };
    } else if (
      args.source_start_line !== undefined ||
      args.source_end_line !== undefined ||
      args.suggested_replacement !== undefined
    ) {
      return buildValidationFailureResult([
        {
          field: "source_path",
          reason: "source line and replacement fields require source_path",
        },
      ]);
    }

    // 0#170 — optional structured PoC step graph. The agent passes
    // `poc_steps` as a JSON-encoded string (LLM tool call wire format). We
    // tolerate already-parsed arrays too. Anything malformed is silently
    // dropped so a bad payload never blocks the finding from being saved.
    const pocSteps = parsePocStepsArg(args.poc_steps);
    if (pocSteps && pocSteps.length > 0) {
      finding.pocSteps = pocSteps;
    } else {
      // 0#179 — fall back to a prose-derived heuristic graph when the
      // agent didn't supply one explicitly. The heuristic is conservative:
      // it returns undefined whenever it can't extract ≥ 2 steps cleanly,
      // and we leave `pocSteps` undefined in that case (downstream consumers
      // gate on field presence).
      const inferred = extractPocStepsFromProse({
        request: finding.evidence.request,
        response: finding.evidence.response,
        analysis: finding.evidence.analysis,
      });
      if (inferred && inferred.length >= 2) finding.pocSteps = inferred;
    }

    // 0#193 — optional machine-executable verification spec. Same
    // wire-shape tolerance as poc_steps (object OR JSON string OR garbage).
    // When parseable, attach the contract for later replay and source-fix
    // workflows. A unique finding saved in a scoped source workspace also
    // receives a bounded code-only check below; behavior remains unexecuted.
    const verificationSpec = parseVerificationSpecArg(args.verification_spec);
    if (verificationSpec) {
      finding.verificationSpec = verificationSpec;
    }

    // 0#409 — propagate the validated CVE / CWE / CVSS values to the
    // Finding. The fields are already shape-checked above, so we attach as-is
    // (no auto-uppercase / canonicalisation — the agent submitted clean
    // values or we'd have returned validation_failed already). `Finding`
    // doesn't carry a top-level `cve` / `cwe` field today (the schema work
    // is tracked separately under 0#382), so we attach to the closest
    // existing slots: `cvssVector` / `cvssScore` for CVSS, and stash CVE /
    // CWE on the evidence.analysis prefix as a structured tag the disclose
    // renderer can pluck later. When the Finding schema grows first-class
    // fields, replace this stub.
    if (draft.cvss) finding.cvssVector = draft.cvss;
    if (typeof draft.cvssScore === "number") finding.cvssScore = draft.cvssScore;
    if (draft.cve || draft.cwe) {
      const tags: string[] = [];
      if (draft.cve) tags.push(`CVE: ${draft.cve}`);
      if (draft.cwe) tags.push(`CWE: ${draft.cwe}`);
      const prefix = tags.join(" | ");
      finding.evidence.analysis = finding.evidence.analysis
        ? `${prefix}\n\n${finding.evidence.analysis}`
        : prefix;
    }

    // 0#1103 — optional evidence-grounded business-impact assessment. The LLM
    // supplies this JSON-encoded string at finding time rather than via a
    // separate report-time LLM call. Parse, validate enums against the
    // vocabulary shared with impact-assessment.ts, and stamp on the Finding.
    // When absent (the common case) the finding carries no assessment —
    // consumers (CVSS, advisory templates) handle an undefined field gracefully.
    const impactRaw = args.impact_assessment;
    if (typeof impactRaw === "string" && impactRaw.trim().length > 0) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(impactRaw); } catch {
        return buildValidationFailureResult([
          { field: "impact_assessment", reason: "must be valid JSON" },
        ]);
      }
      if (typeof parsed !== "object" || parsed === null) {
        return buildValidationFailureResult([
          { field: "impact_assessment", reason: "must be a JSON object" },
        ]);
      }
      const assessment = inlineImpactAssessmentSchema.safeParse(parsed);
      if (!assessment.success) return buildValidationFailureResult(assessment.error.issues.map(issue => ({
        field: `impact_assessment.${issue.path.join(".")}`,
        reason: issue.message,
      })));
      finding.impactAssessment = { ...assessment.data, assessment_source: assessment.data.assessment_source ?? "provided" };
    }

    // Hybrid confidence (LLM self-report + PoC-status floor). Mutate call
    // arguments in place so the native-loop's finding_ingested event reads
    // the computed value rather than the raw LLM-reported value.
    // See finding-confidence.ts for the heuristic.
    const confidence = computeFindingConfidence(args.confidence, finding.pocSteps);
    if (confidence !== undefined) {
      finding.confidence = confidence;
      args.confidence = confidence;
    }

    // 0#281 — dedup against in-memory ctx.findings before append.
    // Surfaced by the 2026-05-07 control-flow audit (§H3 "prompt doing what
    // code should do"). The agent prompt already asks the model to query
    // existing findings before saving, but nothing enforces it; the same
    // SQLi gets persisted across attack and verify stages and disclose then
    // renders N advisories from one bug.
    //
    // Similarity key is (category, normalizedTitle, evidenceRequestPrefix).
    // Exact match on (category, normalizedTitle) merges. Fuzzy match
    // (Levenshtein ≤ FUZZY_TITLE_DISTANCE_THRESHOLD on the normalized title
    // PLUS identical evidenceRequestPrefix) also merges — same-prefix is the
    // anti-hallucination check that prevents legitimately-distinct
    // endpoints from collapsing on a near-name collision.
    //
    // First-write-wins: we deliberately do NOT update the existing finding's
    // evidence/severity/confidence on a merge. The first record stays
    // authoritative. Re-running with stronger evidence requires
    // `finding` (an explicit, separate code path).
    const existing = findMatchingFindingCandidate(this.ctx.findings, finding);
    // Cross-session dedupe (operator directive): sibling lane agents save into
    // their own scanIds, so the in-memory check above cannot see their
    // findings. Before persisting, fuzzy-match against what the engagement's
    // other agents already stored — the first saved copy wins and later
    // near-duplicates merge into it instead of doubling the triage pile.
    // Cheap: engagement findings are a few dozen rows.
    // Bounded cross-session deduplication: query up to 500 most recent records
    // in the same category via idx_findings_category to bound Levenshtein computation time.
    if (!existing && this.db && this.ctx.persistFindings !== false) {
      try {
        const persisted = this.db.listFindings({
          category: finding.category,
          limit: 500,
        }) as Array<{
          id: string;
          title: string;
          category: string;
          evidenceRequest: string;
        }>;
        const dbDupe = findMatchingFindingCandidate(persisted, finding);
        if (dbDupe) {
          return {
            success: true,
            output: {
              findingId: dbDupe.id,
              message: `merged with finding ${dbDupe.id} already saved by another agent in this engagement`,
            },
          };
        }
      } catch {
        /* cross-session dedupe is best-effort; the save proceeds on failure */
      }
    }
    if (existing) {
      return {
        success: true,
        output: {
          findingId: existing.id,
          message: `merged with existing finding ${existing.id}`,
        },
      };
    }
    // Evaluate only the finding that will be added. Duplicate submissions
    // keep the existing first-write-wins record and do not trigger a check.
    if (verificationSpec && this.ctx.scopePath) {
      finding.sourceVerification = await evaluateSourceVerification(
        verificationSpec,
        this.ctx.scopePath,
      );
    }

    // Harness re-verification (operator directive): every finding is
    // re-verified against the source before it surfaces — an agent-supplied
    // verificationSpec is honored, and when the agent supplied none the
    // harness builds conservative file-contains predicates from the finding's
    // own evidence (does the quoted code actually exist at the cited path?).
    // A finding whose evidence is absent from the source, or whose claims
    // could not be evaluated, is marked `needs_verify` instead of surfacing
    // as confirmed. Verification root: the scan scope when configured, else
    // the engagement target itself when that is a local directory (source
    // reviews bind the snapshot as the target).
    const verificationRoot = this.ctx.scopePath
      ?? (this.ctx.target.startsWith("/") ? this.ctx.target : undefined);
    if (!finding.sourceVerification && verificationRoot) {
      const autoSpec = autoVerificationSpec(finding);
      if (autoSpec) {
        finding.sourceVerification = await evaluateSourceVerification(
          autoSpec,
          verificationRoot,
        );
      }
    }
    if (verificationRoot && finding.sourceVerification?.status !== "matched" && !finding.publishability) {
      finding.publishability = "needs_verify";
    }

    // Impact remains the caller's validated assessment when supplied. Missing
    // assessments stay unassessed; saving evidence must not issue an extra,
    // unmetered model request or interfere with the planner's turn state.
    if (this.db && this.ctx.persistFindings !== false) {
      this.db.saveFinding(this.ctx.scanId, finding);
    } else if (this.ctx.persistFindings !== false && this.ctx.persistDelegatedFinding) {
      const delegatedResult = this.ctx.persistDelegatedFinding(finding);
      if (!delegatedResult || typeof delegatedResult !== "object" || !("status" in delegatedResult)) {
        return {
          success: false,
          output: null,
          error: "Delegated finding persistence failed: unconfirmed persistence result",
        };
      }
      if (delegatedResult.status === "duplicate") {
        return {
          success: true,
          output: {
            findingId: delegatedResult.findingId,
            message: `merged with finding ${delegatedResult.findingId} already saved by another agent in this engagement`,
          },
        };
      }
      if (delegatedResult.status === "rejected") {
        return {
          success: false,
          output: null,
          error: delegatedResult.reason,
        };
      }
      if (delegatedResult.status !== "created") {
        return {
          success: false,
          output: null,
          error: `Delegated finding persistence failed: unknown status ${(delegatedResult as any).status}`,
        };
      }
    }
    this.ctx.findings.push(finding);

    // 0#567 — harvest reusable footholds (credentials/tokens/cookies/…)
    // out of this finding's evidence into the loot ledger so the agent can
    // chain them into follow-up requests. No-op when the loot
    // feature is off (ctx.loot undefined). Best-effort: a harvest failure must
    // never block a finding from being saved.
    try {
      this.ctx.loot?.harvestFromFinding(finding);
    } catch {
      /* harvesting is best-effort and must not abort finding */
    }

    return { success: true, output: { findingId: finding.id, message: "Finding saved" } };
  }

  private updateFinding(args: Record<string, unknown>): ToolResult {
    const id = args.finding_id as string;
    const status = args.status as Finding["status"];
    if (!id || typeof id !== "string") {
      return { success: false, output: null, error: "finding_id is required" };
    }
    if (!status || typeof status !== "string") {
      return { success: false, output: null, error: "status is required" };
    }

    const finding = this.ctx.findings.find((f) => f.id === id);
    if (this.ctx.updateDelegatedFinding) {
      const res = this.ctx.updateDelegatedFinding(id, status);
      if (!res.success) {
        return { success: false, output: null, error: res.error };
      }
      if (finding) {
        finding.status = status;
      }
      return { success: true, output: { message: res.message } };
    }

    if (this.db && this.ctx.persistFindings !== false) {
      const dbFinding = this.db.getFinding(id);
      if (!dbFinding) {
        return { success: false, output: null, error: `Finding not found: ${id}` };
      }
      try {
        this.db.updateFindingStatus(id, status);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `Failed to update finding in database: ${msg}` };
      }
      if (finding) {
        finding.status = status;
      }
      return { success: true, output: { message: `Finding ${id} updated to ${status}` } };
    }

    if (finding) {
      finding.status = status;
      return { success: true, output: { message: `Finding ${id} updated to ${status}` } };
    }

    return { success: false, output: null, error: `Finding not found: ${id}` };
  }

  /**
   * str_replace — exact-string file edit (Claude text_editor `str_replace`
   * contract). More reliable than `apply_patch` for single edits: there are no
   * fragile context hunks to mismatch — matching preserves whitespace and
   * indentation, tolerates LF/CRLF for multiline blocks and, unless `replace_all` is
   * set, UNIQUELY. Refuses without a
   * `scopePath` and resolves the path through `resolveFolderPath` so the edit
   * can never escape the audit directory. Fail-soft — every error is a clear,
   * self-correctable message, never a thrown exception or a silent no-op.
   */
  private strReplace(args: Record<string, unknown>): ToolResult {
    if (!this.ctx.scopePath) {
      return { success: false, output: null, error: "str_replace requires a folder" };
    }

    const rawPath = args.path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      return {
        success: false,
        output: null,
        error: "str_replace: `path` argument must be a non-empty string",
      };
    }
    if (typeof args.old_string !== "string") {
      return {
        success: false,
        output: null,
        error: "str_replace: `old_string` argument must be a string",
      };
    }
    if (typeof args.new_string !== "string") {
      return {
        success: false,
        output: null,
        error: "str_replace: `new_string` argument must be a string",
      };
    }
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = args.replace_all === true;

    if (oldString.length === 0) {
      // An empty old_string creates a new file (or fills an empty one).
      let target: string;
      try {
        target = resolveFolderPath(this.ctx.scopePath, rawPath);
      } catch (err) {
        return { success: false, output: null, error: err instanceof Error ? err.message : String(err) };
      }
      if (existsSync(target) && readFileSync(target, "utf-8").length > 0) {
        return {
          success: false,
          output: null,
          error: `str_replace: ${rawPath} already exists and is not empty; give the exact old_string to replace, or use bash to overwrite it`,
        };
      }
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, newString, "utf-8");
        this._workerTree.observeDirectWrite(this.ctx.scanId);
      } catch (err) {
        return { success: false, output: null, error: `str_replace: could not write ${rawPath}: ${err instanceof Error ? err.message : String(err)}` };
      }
      const lines = newString.split("\n");
      return {
        success: true,
        output: { path: rawPath, created: true },
        meta: { kind: "edit", path: rawPath, added: lines.length, removed: 0, diff: lines.map((l) => `+${l}`).join("\n") },
      };
    }
    if (oldString === newString) {
      return {
        success: false,
        output: null,
        error: "str_replace: `old_string` and `new_string` are identical; nothing to change",
      };
    }

    let abs: string;
    try {
      abs = resolveFolderPath(this.ctx.scopePath, rawPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }

    if (!existsSync(abs)) {
      return {
        success: false,
        output: null,
        error: `str_replace: file does not exist: ${rawPath}`,
      };
    }

    let original: string;
    try {
      original = readFileSync(abs, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `str_replace: could not read ${rawPath}: ${msg}` };
    }

    // Find all non-overlapping occurrences. For single-line strings, exact
    // byte-for-byte matching is used. For multiline strings, line endings are
    // matched as LF or CRLF, including mixtures within a block. Unmatched
    // bytes are copied verbatim; replacement line endings follow the block.
    const matches: Array<{ start: number; end: number; replacement: string }> = [];

    if (!oldString.includes("\n")) {
      let pos = 0;
      while ((pos = original.indexOf(oldString, pos)) !== -1) {
        matches.push({ start: pos, end: pos + oldString.length, replacement: newString });
        pos += oldString.length;
      }
    } else {
      // Compare logical newlines, recording each removed CR at its logical
      // offset. Monotone cursors map matches back to untouched original bytes.
      const removedCrOffsets: number[] = [];
      const logicalOriginal = original.replace(/\r\n/g, (_ending, offset: number) => {
        removedCrOffsets.push(offset - removedCrOffsets.length);
        return "\n";
      });
      const logicalOld = oldString.replace(/\r\n/g, "\n");
      const crlfNew = newString.replace(/\r?\n/g, "\r\n");
      const lfNew = newString.replace(/\r?\n/g, "\n");
      const mixedExact = oldString.includes("\r\n") && oldString.replace(/\r\n/g, "").includes("\n");
      let removed = 0;
      let pos = 0;
      let hit: number;
      while ((hit = logicalOriginal.indexOf(logicalOld, pos)) !== -1) {
        while (removed < removedCrOffsets.length && removedCrOffsets[removed] < hit) removed++;
        const start = hit + removed;
        const logicalEnd = hit + logicalOld.length;
        while (removed < removedCrOffsets.length && removedCrOffsets[removed] < logicalEnd) removed++;
        const end = logicalEnd + removed;
        const matched = original.slice(start, end);
        // Preserve the prior literal replacement for an exact mixed-EOL block.
        // Otherwise the first matched newline sets the replacement's style.
        const replacement = mixedExact && matched === oldString
          ? newString
          : /\r?\n/.exec(matched)![0] === "\r\n" ? crlfNew : lfNew;
        matches.push({ start, end, replacement });
        pos = logicalEnd;
      }
    }

    const occurrences = matches.length;

    if (occurrences === 0) {
      return {
        success: false,
        output: null,
        error: `str_replace: old_string not found in ${rawPath}. It must match the file contents exactly, including whitespace and indentation.`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        output: null,
        error: `str_replace: old_string matches ${occurrences} locations in ${rawPath}; not unique. Add more surrounding context to make it unique, or set replace_all: true to replace every occurrence.`,
      };
    }

    // We only reach here when occurrences === 1, or replace_all is set. In both
    // cases replacing matches in a single forward pass avoids cascading substitutions
    // and preserves line endings outside the replaced regions.
    const replacements = replaceAll ? occurrences : 1;
    let updated: string;
    if (replaceAll) {
      updated = "";
      let lastIndex = 0;
      for (const m of matches) {
        updated += original.slice(lastIndex, m.start) + m.replacement;
        lastIndex = m.end;
      }
      updated += original.slice(lastIndex);
    } else {
      const m = matches[0];
      updated = original.slice(0, m.start) + m.replacement + original.slice(m.end);
    }

    try {
      writeFileSync(abs, updated, "utf-8");
      this._workerTree.observeDirectWrite(this.ctx.scanId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `str_replace: could not write ${rawPath}: ${msg}` };
    }

    const editMeta = buildStrReplaceMeta(rawPath, oldString, newString, replacements);
    return {
      success: true,
      output: { path: rawPath, replacements },
      meta: editMeta,
    };
  }

  // ── Web search (anti-cheat gated) ──

  private static WEB_SEARCH_BLOCKLIST = [
    "writeup",
    "walkthrough",
    "solution",
    "ctf write",
    "how to solve",
    "flag{",
    "exploit-db",
  ];

  private async webSearch(args: Record<string, unknown>): Promise<ToolResult> {
    if (!(this.ctx.webSearchEnabled ?? featureFlags.webSearch)) {
      return { success: false, output: null, error: "web_search is disabled. Set ZERO_FEATURE_WEB_SEARCH=1 to enable." };
    }

    const query = (args.query as string ?? "").trim();
    if (!query) {
      return { success: false, output: null, error: "query is required" };
    }

    // Anti-cheat: block queries that look for writeups/solutions
    const lowerQuery = query.toLowerCase();
    for (const blocked of ToolExecutor.WEB_SEARCH_BLOCKLIST) {
      if (lowerQuery.includes(blocked)) {
        return {
          success: false,
          output: null,
          error: `Blocked: search query contains disallowed term "${blocked}". Web search cannot be used to find writeups, solutions, or exploits.`,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const execution = this._executionContext.getStore();
    const signal = execution?.signal ? AbortSignal.any([controller.signal, execution.signal]) : controller.signal;

    try {
      let primary: Awaited<ReturnType<typeof searchParallel>>;
      try {
        primary = await searchParallel(query, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          fetchImpl: async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const endpoint = new URL(url);
            if (endpoint.protocol !== "https:" || endpoint.hostname !== "mcp.parallel.ai" || endpoint.username || endpoint.password) throw new Error("Invalid search provider endpoint.");
            const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
            execution?.assertAuthority?.();
            const response = await fetchScoped(url, { ...init, signal: requestSignal, redirect: "error" }, {
              baseUrl: "https://mcp.parallel.ai", timeoutMs: 10_000,
              validateUrl: () => execution?.assertAuthority?.(),
            });
            return response;
          },
        });
      } catch {
        // A primary-provider deadline may leave time for the fallback, while
        // parent cancellation and the overall deadline must never retry.
        signal.throwIfAborted();
        primary = { ok: false, error: "Parallel search timed out or was unavailable." };
      }
      signal.throwIfAborted();
      let provider = "Parallel";
      let results: Array<{ title: string; url: string; snippet: string }>;
      if (primary.ok) {
        results = primary.results;
      } else {
        provider = "DuckDuckGo";
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        execution?.assertAuthority?.();
        const res = await fetchScoped(url, {
          headers: { "User-Agent": "0/1.0" }, signal, redirect: "follow",
        }, {
          baseUrl: "https://html.duckduckgo.com", timeoutMs: 15_000,
          validateUrl: () => execution?.assertAuthority?.(),
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          return { success: false, output: null, error: `Web search unavailable. Parallel: ${primary.error} DuckDuckGo: HTTP ${res.status}.` };
        }
        const parsed = parseDuckDuckGoResults(await readWebSearchResponse(res, signal));
        if (!parsed.ok) return { success: false, output: null, error: `Web search unavailable. Parallel: ${primary.error} DuckDuckGo: ${parsed.error}` };
        results = parsed.results;
      }

      // Display-only sidecar (never reaches the model — the loop serializers
      // read only `output`/`error`) so the TUI can draw a rich web-search card.
      // Only verified result fields are exposed; no synthesized answer or age.
      const webMeta: ToolResultMeta = {
        kind: "web",
        provider,
        query,
        sources: results.map((r) => ({
          ...(r.title ? { title: r.title } : {}),
          url: r.url,
        })),
      };

      if (results.length === 0) {
        return { success: true, output: { provider, message: "No results found.", results: [] }, meta: webMeta };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return { success: true, output: { provider, message: `Top ${results.length} results:`, formatted, results }, meta: webMeta };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `Web search failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private ensureCloudSkillBundle(): Map<string, SkillDefinition> | null {
    // undefined = not yet checked; null = env unset; Map = loaded
    if (this._cloudSkillBundle !== undefined) return this._cloudSkillBundle;
    const manifestPath = process.env["ZERO_AUDIT_SKILLS_MANIFEST"];
    if (!manifestPath) {
      this._cloudSkillBundle = null;
      return null;
    }
    this._cloudSkillBundle = loadSkillBundleFromManifest(manifestPath);
    return this._cloudSkillBundle;
  }

  /** Per-run allow-list (Sentinels). Absent means unrestricted. */
  private skillAllowed(id: string): boolean {
    return isAgentSkillAllowed(typeof this.ctx.skillDiscoveryOptions === "function" ? this.ctx.skillDiscoveryOptions() : this.ctx.skillDiscoveryOptions, id);
  }

  private listSkills(args: Record<string, unknown>): ToolResult {
    const tag = typeof args.tag === "string" ? args.tag : undefined;
    const summaries = listSkillSummaries({ tag, role: this.ctx.role }).filter((summary) => this.skillAllowed(summary.id));
    const discovered = discoverAgentSkills({
      projectRoot: this.ctx.workspaceRoot ?? this.ctx.scopePath,
      ...(typeof this.ctx.skillDiscoveryOptions === "function" ? this.ctx.skillDiscoveryOptions() : this.ctx.skillDiscoveryOptions),
    });
    const folderSummaries = discovered.skills.filter((skill) => !tag || skill.tags.includes(tag)).map((skill) => ({
      id: skill.id, name: skill.name, description: skill.description, tags: skill.tags,
      estimated_tokens: skill.estimated_tokens, suggested: false, source: skill.extension ?? skill.source,
    }));

    // Merge cloud audit skills from env manifest if configured
    const cloudBundle = this.ensureCloudSkillBundle();
    const cloudSummaries = cloudBundle
      ? [...cloudBundle.values()].filter((s) => this.skillAllowed(s.id)).map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.tags,
          estimated_tokens: s.estimated_tokens,
          suggested: false,
          source: "cloud" as const,
        }))
      : [];
    const mergedSummaries = tag
      ? summaries.filter((s) => s.tags.includes(tag)).concat(
          cloudSummaries.filter((s) => s.tags.includes(tag)),
        )
      : summaries.concat(cloudSummaries);
    mergedSummaries.push(...folderSummaries);

    // Compute suggested flags from recent tool output context
    const registry = loadSkillRegistry();
    const allSkills = [...registry.values(), ...(cloudBundle ? [...cloudBundle.values()] : [])];
    const suggestedIds = matchTriggers(
      this.ctx.recentToolResultTexts ?? [],
      allSkills,
    );

    const enriched = mergedSummaries.map((s) => ({
      ...s,
      suggested: suggestedIds.has(s.id),
    }));

    const total = enriched.length;
    const suggested_count = enriched.filter((s) => s.suggested).length;

    // Bus event: skill_listed — tracks JIT skill browse patterns for A/B
    // testing (#458).
    eventBus.emit("skill_listed", {
      total,
      suggested_count,
      tag,
      role: this.ctx.role,
    });

    return {
      success: true,
      output: {
        skills: enriched,
        total,
        suggested_count,
        diagnostics: discovered.diagnostics,
      },
    };
  }

  private loadSkill(args: Record<string, unknown>): ToolResult {
    const skillId = args.skill_id as string;
    if (!skillId) {
      // `list_skills` is merged into `load_skill`: no id lists what can be loaded.
      return this.listSkills(args);
    }
    if (!this.skillAllowed(skillId)) {
      return { success: false, output: null, error: `Skill "${skillId}" is not on this run's skill allow-list. Call load_skill with no skill_id to see permitted skills.` };
    }

    // Check for double-load
    if (this.ctx.loadedSkills?.has(skillId)) {
      return {
        success: true,
        output: { kind: "already_loaded", skill_id: skillId, message: "Skill already loaded" },
      };
    }

    let skill = getSkillById(skillId);
    let isFolderSkill = false;
    if (!skill) {
      const discovered = discoverAgentSkills({
        projectRoot: this.ctx.workspaceRoot ?? this.ctx.scopePath,
        ...(typeof this.ctx.skillDiscoveryOptions === "function" ? this.ctx.skillDiscoveryOptions() : this.ctx.skillDiscoveryOptions),
      });
      const metadata = discovered.skills.find((candidate) => candidate.id === skillId);
      if (metadata) {
        skill = loadAgentSkill(metadata);
        isFolderSkill = true;
      }
    }

    // Fall through to cloud audit skills bundle if not found in built-in registry
    if (!skill) {
      const cloudBundle = this.ensureCloudSkillBundle();
      if (cloudBundle?.has(skillId)) {
        skill = cloudBundle.get(skillId)!;
      }
    }

    if (!skill) {
      return {
        success: false,
        output: null,
        error: `Unknown skill ID: "${skillId}". Call load_skill with no skill_id to see available skills.`,
      };
    }

    // Enforce role applicability
    if (!isFolderSkill && !skill.applicable_roles.includes(this.ctx.role as any)) {
      return {
        success: false,
        output: null,
        error: `Skill "${skillId}" is not applicable to the "${this.ctx.role}" role.`,
      };
    }

    // Track the loaded skill
    if (!this.ctx.loadedSkills) {
      this.ctx.loadedSkills = new Set();
    }
    this.ctx.loadedSkills.add(skillId);

    // Bus event: skill_loaded — tracks JIT skill usage for A/B testing (#458).
    eventBus.emit("skill_loaded", {
      skill_id: skill.id,
      name: skill.name,
      estimated_tokens: skill.estimated_tokens,
      role: this.ctx.role,
    });

    // Tool packs: only built-in skills (trusted source) may declare them. Packs
    // only advertise tools the run's role/scope/flag gates already allow; every
    // call still passes the dispatch gates.
    let packNote: { tools_available_next_turn: string[]; unavailable?: string[] } | undefined;
    const registry = !isFolderSkill ? (packToolsOf(this.ctx) ?? deferredToolsOf(this.ctx)) : undefined;
    if (registry && skill.tools?.length) {
      const wanted = resolvePacks(skill.tools).tools;
      const result = registry.load(wanted);
      packNote = { tools_available_next_turn: result.loaded, ...(result.unknown.length ? { unavailable: result.unknown } : {}) };
    }

    return {
      success: true,
      output: {
        kind: "skill_loaded",
        skill_id: skill.id,
        name: skill.name,
        estimated_tokens: skill.estimated_tokens,
        ...(packNote ?? {}),
        content: skill.content,
      },
    };
  }

  /**
   * `ask_operator` — pause mid-turn and put a STRUCTURED question to the human
   * operator, blocking until it is answered.
   *
   * INFORMATION-GATHERING ONLY. This handler is distinct from a
   * permission/approval gate: it touches NO authorization state — no scope, no
   * approvals, no capabilities, no autonomy mode. It is in `READ_ONLY_TOOLS`
   * for exactly this reason. There is deliberately NO timeout here that could
   * bypass a safety gate — it awaits the operator's own answer callback and
   * nothing else. It grants nothing regardless of how it is answered.
   *
   * Flow: validate + build a typed {@link OperatorQuestionRequest} (id from the
   * injectable factory), await the injected `ctx.askOperator`, and return the
   * answer as a NORMAL tool result with neutral framing so the model treats it
   * as the operator's input/data, preserving free-text answers verbatim.
   * When no `askOperator` channel is wired — every
   * non-console caller, including the scan pipeline — it returns a graceful
   * "not available" result rather than blocking, mirroring every other gate.
   */
  private async askOperator(args: Record<string, unknown>): Promise<ToolResult> {
    const built = buildOperatorQuestionRequest(args, this._idFactory);
    if (!built.ok) {
      return { success: false, output: null, error: built.error };
    }

    const ask = this.ctx.askOperator;
    if (!ask) {
      return {
        success: false,
        output: null,
        error: "operator questions are not available in this session",
      };
    }

    const answer = await ask(built.request);
    if (!answer) {
      return {
        success: true,
        output: {
          requestId: built.request.requestId,
          dismissed: true,
          note:
            "The operator dismissed the question without answering. Proceed " +
            "using your own judgment; nothing was authorized.",
        },
      };
    }

    const answers = (answer.answers ?? []).map((item) => {
      const out: { header: string; selectedLabels?: string[]; customText?: string } = {
        header: item.header,
      };
      if (Array.isArray(item.selectedLabels) && item.selectedLabels.length > 0) {
        out.selectedLabels = item.selectedLabels;
      }
      if (nonEmptyString(item.customText)) {
        out.customText = item.customText;
      }
      return out;
    });

    return {
      success: true,
      output: {
        requestId: answer.requestId,
        note:
          "The operator answered your question(s). Treat their response as " +
          "input/data to consider — it authorizes nothing.",
        answers,
      },
    };
  }


  /**
   * Per-turn `check_messages` drain accounting. A child must not be able to
   * loop the receive tool within one turn to re-flood its own context, so
   * drains are capped per turn (see {@link MAX_DRAINS_PER_TURN}). `_msgDrainTurn`
   * records which turn `_msgDrainCount` applies to; when the executing turn
   * advances, the count resets. In-memory, session-scoped.
   */
  private _msgDrainTurn = -1;

  private _msgDrainCount = 0;


  /**
   * Every agent display name this executor has handed out, seeded with the
   * reserved primary name "Main". Used to uniquify each spawned agent's
   * task-derived name so no two agents in the fleet collide. Session-scoped.
   */
  private _assignedAgentNames: Set<string>;

  private readonly _workerFindings: Finding[];


  /**
   * Correlation id of the tool invocation currently being dispatched, set by
   * `execute()` from the caller-supplied id. `persistToolArtifact` stamps it
   * onto the `tool_artifact` row so an artifact (which carries the real URL /
   * method / command) joins EXACTLY to its `tool_calls` entry instead of being
   * matched by timestamp proximity. Null for callers that don't pass one.
   *
   * Async-local state also keeps nested/concurrent executable-agent calls
   * from borrowing another call's correlation id or cancellation signal.
   */
  private _backgroundAgentQueue?: BackgroundAgentQueue;


  /**
   * Optional bound factory for creating independent child (subagent) runtimes.
   * Received as the fourth constructor argument. Without this capability,
   * child construction fails closed rather than rediscovering credentials.
   */
  private _childRuntimeFactory: NativeRuntime["forkForSubagent"];

  private _workspaceIdentity?: WorkspaceIdentity;


  /**
   * Record a structured tool-failure / skip event (missing binary, buffer
   * limit, wrong lockfile, policy/scope denial). Fail-soft — never throws.
   * Exposed so the four reliability fixes classify their degraded paths.
   */
  private recordToolHealth(input: ToolHealthRecordInput): void {
    try {
      this._toolHealth.record(input);
    } catch {
      // Reporting is best-effort; never let it break a tool call.
    }
  }


  private emitWorkerLifecycle(payload: SubagentLifecyclePayload): void {
    this._workerTree.observeLifecycle(payload);
    eventBus.emit("subagent_lifecycle", payload);
  }


  /**
   * Build the shared lifecycle payload base for one subagent: a globally
   * unique `agent_id` (so concurrent children never collide) plus the parent
   * scan id, task, turn budget, and — when the parent is scoped — the inherited
   * scope rules. Split out so both `spawnAgent` and `spawnAgents` mint bases the
   * same way.
   */
  private buildSubagentLifecycleBase(
    task: string,
    maxTurns: number | undefined,
    requestedName?: string,
  ): SubagentLifecycleBase {
    const agent_id = `${subagentSiblingPrefix(this.ctx.scanId)}${randomUUID()}`;
    // Task labels are readable; uniqueness is independent of opaque agent ids.
    const name = assignAgentName(requestedName ?? task, this._assignedAgentNames);
    this._assignedAgentNames.add(name);
    return {
      agent_id,
      name,
      parent_scan_id: this.ctx.scanId,
      task,
      ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}),
    };
  }


  /**
   * Run ONE subagent to completion and RETURN its outcome rather than throwing
   * or mutating parent state. This is the shared core of both the single-child
   * `spawn_agent` and the concurrent `spawn_agents`; keeping it pure of
   * side-effects on `this.ctx.findings` is what lets the concurrent path merge
   * findings AFTER the pool joins (single-threaded, index-ordered) instead of
   * racing in-child pushes.
   *
   * Lifecycle: the CALLER emits `queued` (so `spawn_agents` can show the whole
   * fan-out as queued up front, before the concurrency cap lets only some
   * start running); this method emits `running` immediately before the loop and
   * exactly one terminal event (`completed` on any normal return — including a
   * cost-ceiling / max-turns partial — or `failed` on a thrown error or missing
   * API key). Net per-child sequence stays queued → running → terminal-once.
   */
  /**
   * Resolve the subagent's lazily-imported dependencies once. Callers pass the
   * result into `runOneSubagent` so a concurrent `spawn_agents` batch shares a
   * single resolution instead of each child racing its own first-time
   * `import()`. In production these modules are already cached (the parent runs
   * inside `runNativeAgentLoop`), so this is effectively free.
   */
  private async loadSubagentDeps(): Promise<SubagentDeps> {
    // Dynamic import to avoid the tools ↔ native-loop circular dependency.
    const { runNativeAgentLoop } = await import("./native-loop.js");
    return { runNativeAgentLoop };
  }


  private acquireWorker(base: SubagentLifecycleBase, trackPublication = false): ReturnType<AuditWorkerTree["acquire"]> {
    return this._workerTree.acquire(base.agent_id, this.ctx.scanId, { ...base, ...(trackPublication ? { publication: true } : {}) });
  }


  private subagentTools(messaging: MessagingRuntime | undefined, childId?: string): ToolDefinition[] {
    const inherited = this.ctx.delegationTools ?? getToolsForRole({ webSearchEnabled: this.ctx.webSearchEnabled });
    return filterWorkflowAgentTools(inherited.filter(tool =>
      Object.hasOwn(TOOL_DEFINITIONS, tool.name) &&
      (this.ctx.webSearchEnabled !== false || tool.name !== "web_search") &&
      (tool.name !== "spawn_agent" || childId === undefined || this._workerTree.canDelegate(childId)),
    ).concat(REPORT_STATUS_TOOL, buildSendMessageTool(messaging), CHECK_MESSAGES_TOOL));
  }


  /**
   * Validate before allocating workers. A requested list can only narrow the available tools, bash is always kept,
   * and an admission that would leave a child with no tools is an error, never a silent empty set.
   */
  private admittedSubagentTools(requested: readonly string[] | undefined): string[] | undefined {
    const host = this.ctx.workerPolicy?.allowedTools;
    if (requested === undefined && host === undefined && getWorkflowAuditExecutionPolicy()?.allowedAgentTools === undefined) return undefined;
    const available = new Set(this.subagentTools(undefined).map(tool => tool.name));
    if (requested?.length === 0) throw new Error("allowed_tools would leave this agent with no tools; omit it to give the agent every tool");
    if (requested !== undefined) for (const name of requested) {
      if (!available.has(name)) throw new Error(`allowed_tools contains unavailable tool "${name}"`);
    }
    // Capture effective host + inherited ceilings before any parked revival.
    const effective = requested === undefined ? [...available] : [...new Set([...requested, ...(available.has("bash") ? ["bash"] : [])])];
    const admitted = [...new Set(host === undefined ? effective : effective.filter(tool => host.includes(tool)))];
    if (admitted.length === 0) throw new Error("allowed_tools would leave this agent with no tools; omit it to give the agent every tool");
    return admitted;
  }


  private admittedSubagentHttpMethods(requested: readonly WorkflowHttpMethod[] | undefined): WorkflowHttpMethod[] | undefined {
    const inherited = getWorkflowAuditExecutionPolicy()?.allowedHttpMethods;
    const host = this.ctx.workerPolicy?.allowedHttpMethods;
    if (requested === undefined && inherited === undefined && host === undefined) return undefined;
    const candidate = requested ?? inherited ?? host!;
    return [...new Set(candidate.filter(method => (inherited === undefined || inherited.includes(method)) && (host === undefined || host.includes(method))))];
  }


  private admittedSubagentMaxTurns(requested: number | undefined): number | undefined {
    const ceiling = this.ctx.workerPolicy?.maxTurns;
    return ceiling === undefined ? requested : Math.min(requested ?? ceiling, ceiling);
  }


  private subagentCompletionInstructions(tools: readonly ToolDefinition[]): string {
    const names = new Set(tools.map(tool => tool.name));
    return [
      names.has("bash") ? "You have a shell: use bash to read files, run commands and inspect the folder." : "Use only your provided tools.",
      names.has("spawn_agent") ? "Delegate independent subtasks when useful." : "",
      names.has("finding") ? "Save evidence-backed findings with finding." : "",
      "Reply in prose with your result when you are finished.",
    ].filter(Boolean).join(" ");
  }


  /** Children publish through the root writer, bound to its selected scan/store. */
  private delegatedFindingPersistence(signal?: AbortSignal): ToolContext["persistDelegatedFinding"] {
    if (this.ctx.persistFindings === false) return undefined;
    const inherited = this.ctx.persistDelegatedFinding;
    const db = this.db;
    if (!inherited && (!this.ctx.consoleSession || !db)) return undefined;
    return (finding: Finding): DelegatedFindingPersistenceResult => {
      // Every ancestor's closure fences publication after its subtree is stopped.
      signal?.throwIfAborted();
      if (inherited) {
        const res = inherited(finding);
        if (!res || typeof res !== "object" || !("status" in res)) {
          return {
            status: "rejected",
            reason: "Delegated finding persistence failed: unconfirmed persistence result",
          };
        }
        if (res.status === "created" && !this.ctx.findings.some(f => f.id === finding.id)) {
          this.ctx.findings.push(finding);
        }
        return res;
      }
      if (!db) {
        return { status: "rejected", reason: "Persistent database is unavailable" };
      }

      // Check ID match first (e.g. idempotent re-publication or same-session retry)
      const existingById = this.ctx.findings.find(f => f.id === finding.id) ?? db.getFinding(finding.id);
      if (existingById) {
        return { status: "duplicate", findingId: existingById.id };
      }

      // Check in-memory similarity match
      const memDupe = findMatchingFindingCandidate(this.ctx.findings, finding);
      if (memDupe) {
        return { status: "duplicate", findingId: memDupe.id };
      }

      // Check persistent DB similarity match.
      // Bounded search: query up to 500 most recent records matching the incoming
      // category via idx_findings_category. The similarity invariant strictly requires
      // category equality, so querying by category avoids full-table scans.
      // 500 records per category is an intentional architectural ceiling to bound event-loop
      // latency during fuzzy title Levenshtein distance calculations.
      try {
        const persisted = db.listFindings({
          category: finding.category,
          limit: 500,
        }) as Array<{
          id: string;
          title: string;
          category: string;
          evidenceRequest: string;
        }>;
        const dbDupe = findMatchingFindingCandidate(persisted, finding);
        if (dbDupe) {
          return { status: "duplicate", findingId: dbDupe.id };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "rejected",
          reason: `Failed to inspect existing findings for deduplication: ${msg}`,
        };
      }

      // New finding: persist to DB and track in parent memory
      db.saveFinding(this.ctx.scanId, finding);
      if (!this.ctx.findings.some(f => f.id === finding.id)) {
        this.ctx.findings.push(finding);
      }
      return { status: "created", findingId: finding.id };
    };
  }


  /** Children route finding status mutations through the root updater, bound to its selected scan/store. */
  private delegatedFindingStatusUpdate(signal?: AbortSignal): ToolContext["updateDelegatedFinding"] {
    if (this.ctx.persistFindings === false) return undefined;
    const inherited = this.ctx.updateDelegatedFinding;
    const db = this.db;
    if (!inherited && (!this.ctx.consoleSession || !db)) return undefined;
    return (findingId: string, status: Finding["status"]): DelegatedFindingUpdateResult => {
      signal?.throwIfAborted();
      if (inherited) {
        const res = inherited(findingId, status);
        if (res.success) {
          const local = this.ctx.findings.find((f) => f.id === findingId);
          if (local) local.status = status;
        }
        return res;
      }

      if (this.ctx.persistFindings === false || !db) {
        // Local-only update when persistence is intentionally disabled or unavailable
        const finding = this.ctx.findings.find((f) => f.id === findingId);
        if (!finding) {
          return { success: false, error: `Finding not found: ${findingId}` };
        }
        finding.status = status;
        return { success: true, message: `Finding ${findingId} updated to ${status}` };
      }

      const dbFinding = db.getFinding(findingId);
      if (!dbFinding) {
        return { success: false, error: `Finding not found: ${findingId}` };
      }

      try {
        db.updateFindingStatus(findingId, status);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to update finding status in database: ${msg}` };
      }

      // Memory updated only after database write succeeds
      const finding = this.ctx.findings.find((f) => f.id === findingId);
      if (finding) {
        finding.status = status;
      }

      return { success: true, message: `Finding ${findingId} updated to ${status}` };
    };
  }


  private mergeSubagentFindings(findings: readonly Finding[], sink = this.ctx.findings): void {
    for (const finding of findings) {
      if (sink.some(existing => existing.id === finding.id)) continue;
      if (findMatchingFindingCandidate(sink, finding)) continue;
      sink.push(finding);
    }
  }


  private async runOneSubagent(
    task: string,
    maxTurns: number | undefined,
    base: SubagentLifecycleBase,
    deps?: SubagentDeps,
    messagingOverride?: MessagingRuntime,
    selection?: SubagentModelSelection,
    admittedLease?: ReturnType<AuditWorkerTree["acquire"]>,
    sharedContext?: string,
    expectedWorkspace?: ExpectedWorkspace,
    allowedTools?: readonly string[],
    allowedHttpMethods?: readonly WorkflowHttpMethod[],
  ): Promise<SubagentOutcome> {
    const startedAt = Date.now();
    const workerPolicy = snapshotWorkerPolicy(this.ctx.workerPolicy);
    let lease = admittedLease;
    let childSignal: AbortSignal | undefined;
    try {
      lease ??= this.acquireWorker(base);
      const callerSignal = this._executionContext.getStore()?.signal;
      const signal = callerSignal ? AbortSignal.any([callerSignal, lease.signal]) : lease.signal;
      childSignal = signal;
      signal.throwIfAborted();
      if (expectedWorkspace) assertExpectedWorkspace(expectedWorkspace, this.ctx.scopePath);
      if (!this._childRuntimeFactory) throw new Error("Parent runtime does not support subagent inference");
      // Single-child path resolves deps here (inside the try, so an import
      // failure still emits `failed`); the concurrent batch pre-resolves once
      // and passes them in to stay off the per-child first-import path.
      const { runNativeAgentLoop } = deps ?? (await this.loadSubagentDeps());
      signal.throwIfAborted();

      const rt = await this._childRuntimeFactory(SUBAGENT_MODEL_TIMEOUT_MS, selection);
      signal.throwIfAborted();
      if (!(await rt.isAvailable())) {
        this.emitWorkerLifecycle({ ...base,
        status: "failed" as const,
        error: "No API key available for sub-agent", });
        return { ok: false, agent_id: base.agent_id, error: "No API key available for sub-agent" };
      }
      signal.throwIfAborted();

      // Descendants share audit admission, role and capabilities. Messaging
      // remains scoped to explicit parent/operator and enabled sibling peers.
      // Thread the child's messaging identity + policy onto its context. The
      // child's stable peer id is its lifecycle `agent_id` (unique per child);
      // its parent is always addressable; siblings share a bounded namespace
      // prefix and the operator is a single explicit id — both of those channels
      // are operator settings, mirrored from the parent's runtime rather than
      // decided here. If this parent has no messaging runtime (messaging not
      // wired for this session), children inherit none and the tools degrade
      // gracefully.
      //
      // `operatorId` is COPIED, never derived: a child has no way to compute the
      // human's console peer id, which is exactly why the operator channel
      // cannot be reached by guessing (see `agent-messaging.ts`). A parent whose
      // own runtime carries no `operatorId` hands its children none, and the
      // channel stays closed however the setting is set.
      // `spawn_agents` pre-builds a batch-scoped runtime per child (seeded with
      // its siblings' ids as `knownPeerIds`) and passes it in as
      // `messagingOverride`, so concurrent siblings can address each other even
      // when the top-level parent runtime is absent (console, no TUI wiring).
      // The single-child `spawn_agent` path passes none and derives the runtime
      // from the parent's, as before (a lone child has no siblings anyway).
      const parentMessaging = messagingRuntimeOf(this.ctx);
      const childMessaging: MessagingRuntime | undefined =
        messagingOverride ??
        (parentMessaging
          ? {
              selfId: base.agent_id,
              selfRole: "child",
              parentId: parentMessaging.selfId,
              operatorId: parentMessaging.operatorId,
              siblingPrefix: subagentSiblingPrefix(this.ctx.scanId),
              siblingChannelEnabled: parentMessaging.siblingChannelEnabled,
              operatorChannelEnabled: parentMessaging.operatorChannelEnabled,
              projectPath: parentMessaging.projectPath,
              homeDir: parentMessaging.homeDir,
            }
          : undefined);

      const subTools = this.subagentTools(childMessaging, base.agent_id).filter(tool => allowedTools === undefined || allowedTools.includes(tool.name));

      // running — immediately before the agent loop starts
      this.emitWorkerLifecycle({ ...base,
      status: "running" as const, });

      // Cost ledger: pass the parent's shared ledger + ceiling + model so the
      // child charges the SAME scan-wide ledger and trips the SAME ceiling.
      // Without this, subagent spend was off-ledger and each child got the full
      // ceiling to itself. Children never receive the auth `session` object —
      // concurrent children sharing one stateful session would race its cookie
      // state — so header building stays stateless per child (matching the
      // single-child path). `db: null` keeps children out of the SQLite writer
      // (no concurrent writers); validated findings publish through the
      // root-owned persistence callback.
      // The batch's shared context (`spawn_agents` `# Goal / # Constraints /
      // # Contract`) is prepended to THIS child's job so the promise made in the
      // tool description — that it applies to every agent — is actually honoured
      // in child-visible input, not merely echoed onto the display card.
      const jobText = sharedContext ? `${sharedContext}\n\n${task}` : task;
      const delegationSystemPrompt = this.ctx.delegationSystemPrompt ?? `You are a focused ${this.ctx.role ?? "attack"} agent.`;
      this._workspaceIdentity ??= captureWorkspaceIdentity(this.ctx.scopePath);
      if (this._workspaceIdentity) assertWorkspaceIdentity(this._workspaceIdentity, this.ctx.scopePath);
      if (expectedWorkspace) assertExpectedWorkspace(expectedWorkspace, this.ctx.scopePath);
      const state = await withWorkflowAuditExecutionPolicy(allowedTools === undefined && allowedHttpMethods === undefined ? undefined : { instructions: "", ...(allowedTools !== undefined ? { allowedAgentTools: allowedTools } : {}), ...(allowedHttpMethods !== undefined ? { allowedHttpMethods } : {}) }, () => runNativeAgentLoop({
        config: {
          role: this.ctx.role ?? "attack",
          systemPrompt: `${delegationSystemPrompt}\n\nYour delegated task:\n\n${jobText}\n\n${this.subagentCompletionInstructions(subTools)}${renderSubagentMessagingPrompt(childMessaging)}`,
          delegationSystemPrompt,
          tools: subTools,
          maxTurns,
          target: this.ctx.target,
          scanId: base.agent_id,
          workerTree: this._workerTree,
          workerFindings: this._workerFindings,
          persistDelegatedFinding: this.delegatedFindingPersistence(signal),
          updateDelegatedFinding: this.delegatedFindingStatusUpdate(signal),
          authConfig: this.usesTargetIdentity(this.ctx.target) ? this.ctx.authConfig : undefined,
          costLedger: this.ctx.costLedger,
          requirePricedUsage: this.ctx.requirePricedUsage,
          costCeilingUsd: this.ctx.costCeilingUsd,
          costModel: rt.resolvedModel?.() ?? this.ctx.costModel,
          scopePath: this._workspaceIdentity?.scopePath ?? this.ctx.scopePath,
          workspaceIdentity: this._workspaceIdentity,
          approvals: this.ctx.approvals,
          consoleSession: this.ctx.consoleSession,
          workerPolicy,
          webSearchEnabled: this.ctx.webSearchEnabled,
          codebaseLearning: false,
          workspaceRoot: this.ctx.workspaceRoot,
          skillDiscoveryOptions: this.ctx.skillDiscoveryOptions,
          skillAuthoring: this.ctx.skillAuthoring,
          // `native-loop.ts` copies this straight onto the child's ToolContext,
          // which is where the child messaging tools read it from. Declared
          // there as `unknown`, hence the cast on the config literal below.
          ...(childMessaging ? { agentMessaging: childMessaging } : {}),
        } as Parameters<typeof runNativeAgentLoop>[0]["config"],
        runtime: rt,
        db: null,
        signal,
        getPendingUserMessages: childMessaging
          ? () => renderInboundBatch(drainInbox(childMessaging.projectPath, base.agent_id, childMessaging.homeDir)).rendered.map((message) => message.text)
          : undefined,
        onToolUpdate: (turn, toolCalls, toolResults, assistantText, telemetry) => {
          if (signal.aborted) return;
          eventBus.emit("subagent_message", buildSubagentMessage(base, turn, assistantText, toolCalls, toolResults, Date.now(), {
            ...telemetry, partial: true, durationMs: Date.now() - startedAt, model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(),
          }));
        },
        // Per-turn child progress (Task 1 + Task 2). Fires ONCE per completed
        // child turn — the right granularity for a "what is this child doing"
        // indicator, and deliberately NOT per token/delta (that channel is
        // high-volume and the parent UI does not need it). This closure is the
        // ONLY place that knows both the child's unique `agent_id` (from `base`)
        // and its per-turn tool calls, which is why the emission lives here and
        // not in the child's own tool handlers. `buildSubagentProgress` reads
        // only tool NAMES + the report_status line — never args or output.
        onTurn: (turn, toolCalls, toolResults, assistantText, telemetry) => {
          if (signal.aborted) return;
          eventBus.emit(
            "subagent_progress",
            buildSubagentProgress(base, turn, maxTurns, toolCalls),
          );
          // The full per-turn transcript (assistant prose + tools) so the TUI
          // can render a focused child identically to the main agent. Sibling
          // of the coarse progress ping above; both are bounded.
          eventBus.emit(
            "subagent_message",
            buildSubagentMessage(base, turn, assistantText, toolCalls, toolResults, Date.now(), {
              ...telemetry, durationMs: Date.now() - startedAt, model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(),
            }),
          );
        },
      }));

      signal.throwIfAborted();

      // A finished invocation is not necessarily a fulfilled task.
      this.emitWorkerLifecycle({ ...base,
      status: state.errorExit ? "failed" as const : "completed" as const,
      turns: state.turnCount,
      findings: state.findings.length,
      summary: state.summary,
      done: state.done,
      completion_reason: state.errorExit ? "error" : state.costCeilingExceeded ? "cost_limit" : state.outputCapExit ? "output_limit" : state.earlyStopNoProgress ? "early_stop" : state.done ? "done" : "turn_limit",
      ...(state.errorExit ? { error: state.errorExit.error } : {}),
      ...(state.totalUsage && (state.totalUsage.inputTokens > 0 || state.totalUsage.outputTokens > 0) ? { usage: state.totalUsage } : {}),
      durationMs: Date.now() - startedAt,
      model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(), });
      if (state.errorExit) {
        return { ok: false, agent_id: base.agent_id, error: state.errorExit.error, findings: state.findings, turns: state.turnCount };
      }

      return {
        ok: true,
        agent_id: base.agent_id,
        findings: state.findings,
        turns: state.turnCount,
        summary: state.summary,
        done: state.done,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const truncated = msg.slice(0, 500);
      this.emitWorkerLifecycle({ ...base,
        ...(childSignal?.aborted
          ? { status: "stopped" as const, summary: "Stopped" }
          : { status: "failed" as const, error: truncated }),
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, agent_id: base.agent_id, error: truncated };
    } finally {
      if (!admittedLease) lease?.release();
    }
  }



  /**
   * Run ONE task/revive of a persistent agent through the native loop — the
   * `runLoop` injected into `runPersistentAgent`. Mirrors `runOneSubagent`'s loop
   * call (same child tool set, scope/auth/cost inheritance, per-turn progress +
   * transcript events) but WITHOUT the lifecycle emits — `runPersistentAgent`
   * owns running/parked/completed/failed. A revive folds the delivered messages
   * into the prompt through `renderInboundBatch`, the same sanitize+fence+
   * attribute chokepoint `check_messages` uses, so a peer message can't inject.
   * Findings merge straight into the shared context (single-threaded pushes).
   */
  private async runPersistentLoopOnce(
    base: SubagentLifecycleBase,
    maxTurns: number | undefined,
    childMessaging: MessagingRuntime | undefined,
    task?: string,
    messages?: readonly HubMessage[],
    turnOffset = 0,
    selection?: SubagentModelSelection,
    signal?: AbortSignal,
    expectedWorkspace?: ExpectedWorkspace,
    batchContext?: string,
    previousSummary?: string,
    allowedTools?: readonly string[],
    allowedHttpMethods?: readonly WorkflowHttpMethod[],
    workerPolicy?: WorkerPolicy,
  ): Promise<SubagentRunReport> {
    const startedAt = Date.now();
    signal?.throwIfAborted();
    if (expectedWorkspace) assertExpectedWorkspace(expectedWorkspace, this.ctx.scopePath);
    if (!this._childRuntimeFactory) throw new Error("Parent runtime does not support subagent inference");
    const { runNativeAgentLoop } = await this.loadSubagentDeps();
    signal?.throwIfAborted();
    const rt = await this._childRuntimeFactory(SUBAGENT_MODEL_TIMEOUT_MS, selection);
    signal?.throwIfAborted();
    if (!(await rt.isAvailable())) throw new Error("No API key available for persistent agent");
    signal?.throwIfAborted();

    const subTools = this.subagentTools(childMessaging, base.agent_id).filter(tool => allowedTools === undefined || allowedTools.includes(tool.name));
    const delegationSystemPrompt = this.ctx.delegationSystemPrompt ?? `You are a focused ${this.ctx.role ?? "attack"} agent.`;

    const preamble =
      messages && messages.length > 0
        ? `You are ${base.name}, continuing the same assignment: ${base.task}\n\n${previousSummary ? renderInboundBatch([{ id: "previous-report", from: base.agent_id, to: base.agent_id, body: clampOutboundBody(previousSummary).body, ts: 0 }]).rendered.map(item => item.text).join("\n\n") : ""}\n\nNew messages:\n\n${renderInboundBatch(messages)
            .rendered.map((r) => r.text)
            .join("\n\n")}\n\nAct on them using only provided tools. ${subTools.some(tool => tool.name === "send_message") ? "Reply with send_message." : ""} ${this.subagentCompletionInstructions(subTools)} You will PARK again afterwards.`
        : `You are ${base.name}, a persistent agent. Your task:\n\n${task ?? base.task}\n\n${this.subagentCompletionInstructions(subTools)} You will then PARK and can be revived by a message.`;

    this._workspaceIdentity ??= captureWorkspaceIdentity(this.ctx.scopePath);
    if (this._workspaceIdentity) assertWorkspaceIdentity(this._workspaceIdentity, this.ctx.scopePath);
    if (expectedWorkspace) assertExpectedWorkspace(expectedWorkspace, this.ctx.scopePath);
    const state = await withWorkflowAuditExecutionPolicy(allowedTools === undefined && allowedHttpMethods === undefined ? undefined : { instructions: "", ...(allowedTools !== undefined ? { allowedAgentTools: allowedTools } : {}), ...(allowedHttpMethods !== undefined ? { allowedHttpMethods } : {}) }, () => runNativeAgentLoop({
      config: {
        role: this.ctx.role ?? "attack",
        systemPrompt: `${delegationSystemPrompt}\n\n${batchContext ? `Shared context:\n${batchContext}\n\n` : ""}${preamble}${renderSubagentMessagingPrompt(childMessaging)}`,
        delegationSystemPrompt,
        tools: subTools,
        maxTurns,
        target: this.ctx.target,
        scanId: base.agent_id,
        workerTree: this._workerTree,
        workerFindings: this._workerFindings,
        persistDelegatedFinding: this.delegatedFindingPersistence(signal),
        updateDelegatedFinding: this.delegatedFindingStatusUpdate(signal),
        authConfig: this.usesTargetIdentity(this.ctx.target) ? this.ctx.authConfig : undefined,
        costLedger: this.ctx.costLedger,
        requirePricedUsage: this.ctx.requirePricedUsage,
        costCeilingUsd: this.ctx.costCeilingUsd,
        costModel: rt.resolvedModel?.() ?? this.ctx.costModel,
        scopePath: this._workspaceIdentity?.scopePath ?? this.ctx.scopePath,
        workspaceIdentity: this._workspaceIdentity,
        approvals: this.ctx.approvals,
        consoleSession: this.ctx.consoleSession,
        workerPolicy,
        webSearchEnabled: this.ctx.webSearchEnabled,
        codebaseLearning: false,
        workspaceRoot: this.ctx.workspaceRoot,
        skillDiscoveryOptions: this.ctx.skillDiscoveryOptions,
        skillAuthoring: this.ctx.skillAuthoring,
        ...(childMessaging ? { agentMessaging: childMessaging } : {}),
      } as Parameters<typeof runNativeAgentLoop>[0]["config"],
      runtime: rt,
      db: null,
      signal,
      getPendingUserMessages: childMessaging
        ? () => renderInboundBatch(drainInbox(childMessaging.projectPath, base.agent_id, childMessaging.homeDir)).rendered.map((message) => message.text)
        : undefined,
      onToolUpdate: (turn, toolCalls, toolResults, assistantText, telemetry) => {
        if (signal?.aborted) return;
        eventBus.emit("subagent_message", buildSubagentMessage(base, turnOffset + turn, assistantText, toolCalls, toolResults, Date.now(), {
          ...telemetry, partial: true, durationMs: Date.now() - startedAt, model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(),
        }));
      },
      onTurn: (turn, toolCalls, toolResults, assistantText, telemetry) => {
        if (signal?.aborted) return;
        eventBus.emit("subagent_progress", buildSubagentProgress(base, turnOffset + turn, maxTurns, toolCalls));
        eventBus.emit(
          "subagent_message",
          buildSubagentMessage(base, turnOffset + turn, assistantText, toolCalls, toolResults, Date.now(), {
            ...telemetry, durationMs: Date.now() - startedAt, model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(),
          }),
        );
      },
    }));

    signal?.throwIfAborted();
    this.mergeSubagentFindings(state.findings ?? [], this._workerFindings);
    if (state.errorExit) throw new Error(state.errorExit.error);
    return {
      turns: turnOffset + state.turnCount, summary: state.summary, done: state.done,
      ...(state.totalUsage && (state.totalUsage.inputTokens > 0 || state.totalUsage.outputTokens > 0) ? { usage: state.totalUsage } : {}),
      durationMs: Date.now() - startedAt, model: rt.resolvedModel?.(), provider: rt.resolvedProvider?.(),
      completion_reason: state.costCeilingExceeded ? "cost_limit" : state.outputCapExit ? "output_limit" : state.earlyStopNoProgress ? "early_stop" : state.done ? "done" : "turn_limit",
    };
  }


  /**
   * Session-owned worker lifecycle used by canonical background delegation
   * and the retained compatibility alias. Runs, parks, and revives on messages.
   * See `hub/supervisor.ts`. Returns
   * immediately with the agent's id + name. Its lifetime belongs to the audit,
   * not a transient spawning invocation. Stops drain its owned subtree.
   * Descendants inherit this invocation's role and bounded tool capabilities.
   */
  private async spawnPersistentAgent(args: Record<string, unknown>, prepared?: {
    base: SubagentLifecycleBase;
    lease: ReturnType<AuditWorkerTree["acquire"]>;
    messaging?: MessagingRuntime;
    expectedWorkspace?: ExpectedWorkspace;
    context?: string;
  }): Promise<ToolResult> {
    const parsed = validateSpawnPersistentAgentArgs(args, this.ctx.consoleSession ? null : 40);
    if (!parsed.ok) {
      this.recordToolHealth({
        tool: "spawn_persistent_agent",
        category: "error",
        message: parsed.error,
      });
      return { success: false, output: null, error: parsed.error };
    }
    let allowedTools: string[] | undefined;
    try { allowedTools = this.admittedSubagentTools(parsed.args.allowedTools); }
    catch (error) { return { success: false, output: null, error: (error as Error).message }; }
    const allowedHttpMethods = this.admittedSubagentHttpMethods(parsed.args.allowedHttpMethods);
    const workerPolicy = snapshotWorkerPolicy(this.ctx.workerPolicy);
    const { task, name, role, model } = parsed.args;
    const maxTurns = this.admittedSubagentMaxTurns(parsed.args.maxTurns);
    const selection: SubagentModelSelection = { role, model };

    const base = prepared?.base ?? this.buildSubagentLifecycleBase(task, maxTurns, name);
    const displayName = base.name;

    const parentMessaging = messagingRuntimeOf(this.ctx);
    const childMessaging: MessagingRuntime | undefined = prepared?.messaging ?? (parentMessaging
      ? {
          selfId: base.agent_id,
          selfRole: "child",
          parentId: parentMessaging.selfId,
          operatorId: parentMessaging.operatorId,
          siblingPrefix: subagentSiblingPrefix(this.ctx.scanId),
          siblingChannelEnabled: parentMessaging.siblingChannelEnabled,
          operatorChannelEnabled: parentMessaging.operatorChannelEnabled,
          projectPath: parentMessaging.projectPath,
          homeDir: parentMessaging.homeDir,
        }
      : undefined);

    const lifetime = prepared?.lease ?? this.acquireWorker(base);
    this._backgroundAgentQueue ??= new BackgroundAgentQueue(subagentConcurrency());
    const queue = this._backgroundAgentQueue;
    let currentStatus: SubagentLifecyclePayload["status"] = "queued";
    this.emitWorkerLifecycle({ ...base, status: "queued" });
    let lastRun: SubagentRunReport = {};

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      if (lifetime.signal.aborted) { resolve(); return; }
      const finish = () => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      lifetime.signal.addEventListener("abort", finish, { once: true });
    });
    const run = runPersistentAgent(task, {
      now: () => Date.now(),
      sleep,
      aborted: () => lifetime.signal.aborted,
      hasPendingWork: () => this._workerTree.peers(base.agent_id).length > 0,
      park: { pollMs: PERSIST_POLL_MS, idleTtlMs: PERSIST_IDLE_TTL_MS, maxRevives: PERSIST_MAX_REVIVES },
      drain: () =>
        childMessaging ? drainInbox(childMessaging.projectPath, base.agent_id, childMessaging.homeDir) : [],
      emit: (status) => {
        // A run waiting for an execution slot remains queued, not running.
        if (status === "running") {
          if (currentStatus !== "queued" && currentStatus !== "running") {
            currentStatus = "queued";
            this.emitWorkerLifecycle({ ...base, ...lastRun,
              status: lifetime.signal.aborted ? "stopped" : "queued" });
          }
          return;
        }
        currentStatus = lifetime.signal.aborted ? "stopped" : status;
        this.emitWorkerLifecycle({ ...base, ...lastRun,
          status: currentStatus });
      },
      runLoop: async ({ task: t, messages }) => {
        try {
          lastRun = await queue.run(lifetime.signal, async () => {
            currentStatus = "running";
            this.emitWorkerLifecycle({ ...base, status: "running" });
            return this.runPersistentLoopOnce(base, maxTurns, childMessaging, t, messages,
              lastRun.turns ?? 0, selection, lifetime.signal, prepared?.expectedWorkspace, prepared?.context, lastRun.summary, allowedTools, allowedHttpMethods, workerPolicy);
          });
        } catch (error) {
          lastRun = { ...lastRun, done: false, completion_reason: "error", summary: error instanceof Error ? error.message : String(error) };
          throw error;
        } finally {
          if (!lifetime.signal.aborted && childMessaging?.parentId && lastRun.summary) {
            const ts = Date.now();
            const { body } = clampOutboundBody(`${displayName} ${lastRun.done ? "finished" : "stopped"}. Full transcript: ${base.agent_id}\n${lastRun.summary}`);
            const message: HubMessage = { id: newMessageId(ts), from: base.agent_id, to: childMessaging.parentId, body, ts };
            let delivered = sendMessage(childMessaging.projectPath, message, childMessaging.homeDir, { overflow: "reject" });
            // Completion delivery must not evict another child's unread result.
            // Wait outside the inference slot so a large fan-out keeps making
            // progress while its coordinator consumes earlier notifications.
            while (!delivered.ok && delivered.reason === "inbox-full" && !lifetime.signal.aborted) {
              await sleep(PERSIST_POLL_MS);
              if (!lifetime.signal.aborted) delivered = sendMessage(childMessaging.projectPath, message, childMessaging.homeDir, { overflow: "reject" });
            }
            if (!lifetime.signal.aborted) {
              if (delivered.ok) eventBus.emit("peer_message", { ...message, kind: "peer" });
              else lastRun = { ...lastRun, summary: `${lastRun.summary}\nParent notification could not be delivered (${delivered.reason}).` };
            }
          }
        }
      },
    });
    void run.then(lifetime.release, lifetime.release);

    return {
      success: true,
      output: {
        spawned: true,
        agent_id: base.agent_id,
        name: displayName,
        task,
        note: childMessaging
          ? `Agent "${displayName}" is running in the background. Results are sent to the parent; you may continue working. The agent stays available for follow-ups through enabled messaging routes or operator agent controls.`
          : `Agent "${displayName}" is running without a parent messaging route. Inspect its retained lifecycle and transcript through the host's agent controls.`,
      },
    };
  }


  /** One delegation surface; live console sessions default to session-owned jobs. */
  private async spawnAgent(args: Record<string, unknown>): Promise<ToolResult> {
    const fail = (error: string): ToolResult => ({ success: false, output: null, error });
    const op = args.op ?? "spawn";
    if (!["spawn", "list", "get", "stop", "stop_all"].includes(op as string)) return fail("Unsupported agent operation");
    if (op !== "spawn") {
      if (Object.keys(args).some(key => !["op", "agent_id"].includes(key))) return fail("Agent management accepts only op and agent_id");
      if ((op === "get" || op === "stop") && (typeof args.agent_id !== "string" || !args.agent_id.trim())) return fail("agent_id is required");
      if ((op === "list" || op === "stop_all") && args.agent_id !== undefined) return fail("agent_id is not accepted for this operation");
      const before = this._workerTree.snapshot(this.ctx.scanId);
      const worker = before.workers.find(worker => worker.id === args.agent_id);
      if ((op === "get" || op === "stop") && !worker) return fail("Worker is not owned by this coordinator or its retained record is unavailable");
      if (op === "get") return { success: true, output: { worker } };
      const drained = op === "stop" && worker!.subtreeLive ? await this._workerTree.stop(worker!.id, this.ctx.scanId) : false;
      if (op === "stop_all") await this._workerTree.stopAll(this.ctx.scanId);
      const snapshot = this._workerTree.snapshot(this.ctx.scanId);
      if (op === "stop") return { success: true, output: { worker: snapshot.workers.find(entry => entry.id === worker!.id) ?? null, cleanupDrained: drained || !worker!.subtreeLive, alreadyTerminal: !worker!.subtreeLive } };
      const counts = Object.fromEntries(["queued", "running", "parked", "stopping", "completed", "failed", "stopped", "unknown"].map(status => [status, snapshot.workers.filter(entry => entry.status === status).length]));
      return { success: true, output: { ...snapshot, counts, live: snapshot.workers.filter(entry => entry.live).length,
        retainedTerminal: snapshot.workers.filter(entry => !entry.subtreeLive).length, pendingAncestors: snapshot.workers.filter(entry => !entry.live && entry.subtreeLive).length, effects: "unknown" } };
    }
    const batch = args.tasks !== undefined;
    if ((args.task !== undefined) === batch) return fail("Provide exactly one of task or tasks");
    if (args.wait !== undefined && typeof args.wait !== "boolean") return fail("wait must be a boolean");
    if (args.context !== undefined && typeof args.context !== "string") return fail("context must be a string");
    const entries = batch ? args.tasks : [args];
    if (!Array.isArray(entries) || !entries.length) return fail("tasks must be a non-empty array");
    if (entries.length > subagentBatchLimit()) return fail(`Too many subagents: maximum ${subagentBatchLimit()}`);
    if (batch && ["name", "model", "role", "max_turns", "expected_workspace", "allowed_tools", "allowed_http_methods"].some(key => args[key] !== undefined)) {
      return fail("Put name, model, role, max_turns, expected_workspace, allowed_tools and allowed_http_methods inside each tasks entry");
    }
    const specs: Array<{ args: Record<string, unknown>; task: string; name?: string; maxTurns: number | undefined; expectedWorkspace?: ExpectedWorkspace }> = [];
    for (let i = 0; i < entries.length; i++) {
      const parsed = validateSpawnPersistentAgentArgs(entries[i], this.ctx.consoleSession ? null : 40);
      if (!parsed.ok) return fail(`tasks[${i}]: ${parsed.error}`);
      if (!parsed.args.task.trim()) return fail(`tasks[${i}].task must not be blank`);
      try { this.admittedSubagentTools(parsed.args.allowedTools); }
      catch (error) { return fail(`tasks[${i}]: ${(error as Error).message}`); }
      const workspace = subagentWorkspaceSchema.safeParse(entries[i]);
      if (!workspace.success) return fail(`tasks[${i}]: Invalid expected workspace`);
      try { if (workspace.data.expected_workspace) assertExpectedWorkspace(workspace.data.expected_workspace, this.ctx.scopePath); }
      catch (error) { return fail(`tasks[${i}]: ${(error as Error).message}`); }
      specs.push({ args: entries[i] as Record<string, unknown>, ...parsed.args, maxTurns: this.admittedSubagentMaxTurns(parsed.args.maxTurns), expectedWorkspace: workspace.data.expected_workspace });
    }
    const parentMessaging = messagingRuntimeOf(this.ctx);
    if (args.agent_id !== undefined) {
      if (batch || typeof args.agent_id !== "string" || !args.agent_id.trim()) return fail("agent_id requires one task follow-up");
      if (args.wait === true || ["context", "name", "model", "role", "max_turns", "expected_workspace", "allowed_tools", "allowed_http_methods"].some(key => args[key] !== undefined)) {
        return fail("A follow-up keeps its worker's existing scope and model; provide only agent_id, task and optional wait:false");
      }
      if (!parentMessaging || !this._workerTree.peers(this.ctx.scanId).includes(args.agent_id)) {
        return fail("The agent is not an available directly owned worker in this session");
      }
      const ts = Date.now();
      const message: HubMessage = { id: newMessageId(ts), from: parentMessaging.selfId,
        to: args.agent_id, body: clampOutboundBody(specs[0].task).body, ts };
      const delivery = sendMessage(parentMessaging.projectPath, message, parentMessaging.homeDir, { overflow: "reject" });
      if (!delivery.ok) return fail(`Follow-up could not be delivered (${delivery.reason})`);
      eventBus.emit("peer_message", { ...message, kind: "peer" });
      return { success: true, output: { agent_id: args.agent_id, continued: true, background: true } };
    }
    const wait = args.wait ?? !(this.ctx.consoleSession && parentMessaging);
    if (wait) return batch ? this.spawnAgents(args) : this.spawnAgentBlocking(args);
    if (!parentMessaging) return fail("Background delegation requires a parent result-delivery route; use wait: true in this host");
    subagentConcurrency(); // Reject bad configuration before any worker is registered.
    const leases: Array<{ base: SubagentLifecycleBase; lease: ReturnType<AuditWorkerTree["acquire"]> }> = [];
    try {
      // Reserve the entire batch before starting any child. Failure admits none.
      for (const spec of specs) {
        const base = this.buildSubagentLifecycleBase(spec.task, spec.maxTurns, spec.name);
        leases.push({ base, lease: this.acquireWorker(base) });
      }
    } catch (error) {
      for (const item of leases) item.lease.release();
      return fail((error as Error).message);
    }
    const messaging = buildSiblingMessagingBatch({
      agentIds: leases.map(item => item.base.agent_id),
      livePeers: () => this._workerTree.peers(this.ctx.scanId),
      scanId: this.ctx.scanId,
      siblingChannelEnabled: parentMessaging.siblingChannelEnabled,
      projectPath: parentMessaging.projectPath,
      homeDir: parentMessaging.homeDir,
      parentId: parentMessaging.selfId,
      operatorId: parentMessaging.operatorId,
      operatorChannelEnabled: parentMessaging.operatorChannelEnabled,
    });
    const launched: unknown[] = [];
    try {
      for (let i = 0; i < specs.length; i++) {
        const result = await this.spawnPersistentAgent(specs[i].args, {
          ...leases[i], messaging: messaging[i], expectedWorkspace: specs[i].expectedWorkspace,
          context: typeof args.context === "string" ? args.context : undefined,
        });
        if (!result.success) throw new Error(result.error ?? "Agent dispatch failed");
        launched.push(result.output);
      }
    } catch (error) {
      // Unstarted reservations have no runner to release them during stop.
      for (const item of leases.slice(launched.length)) item.lease.release();
      await Promise.all(leases.slice(0, launched.length).map(item => this._workerTree.stop(item.base.agent_id, this.ctx.scanId)));
      return fail((error as Error).message);
    }
    return batch ? { success: true, output: { spawned: launched.length, background: true, agents: launched } }
      : { success: true, output: { ...(launched[0] as object), background: true } };
  }


  private async spawnAgentBlocking(args: Record<string, unknown>): Promise<ToolResult> {
    const task = args.task as string;
    if (!task) return { success: false, output: null, error: "Task description is required" };
    const selection = subagentModelSelectionSchema.safeParse(args);
    if (!selection.success) return { success: false, output: null, error: selection.error.issues[0]?.message ?? "Invalid model selection" };
    const workspace = subagentWorkspaceSchema.safeParse(args);
    if (!workspace.success) return { success: false, output: null, error: workspace.error.issues[0]?.message ?? "Invalid expected workspace" };
    try { if (workspace.data.expected_workspace) assertExpectedWorkspace(workspace.data.expected_workspace, this.ctx.scopePath); }
    catch (error) { return { success: false, output: null, error: (error as Error).message }; }


    const parsed = validateSpawnPersistentAgentArgs(args, this.ctx.consoleSession ? null : 40);
    if (!parsed.ok) return { success: false, output: null, error: parsed.error };
    let allowedTools: string[] | undefined;
    try { allowedTools = this.admittedSubagentTools(parsed.args.allowedTools); }
    catch (error) { return { success: false, output: null, error: (error as Error).message }; }

    const maxTurns = this.admittedSubagentMaxTurns((args.max_turns as number | undefined) ?? (this.ctx.consoleSession ? undefined : 40));
    const base = this.buildSubagentLifecycleBase(task, maxTurns, typeof args.name === "string" ? args.name : undefined);

    const lease = this.acquireWorker(base, true);
    try {
    // queued — before any async setup
    this.emitWorkerLifecycle({ ...base, status: "queued" as const });

    const outcome = await this.runOneSubagent(task, maxTurns, base, undefined, undefined, selection.data, lease, typeof args.context === "string" ? args.context : undefined, workspace.data.expected_workspace, allowedTools, this.admittedSubagentHttpMethods(parsed.args.allowedHttpMethods));
    // Preserve accepted findings even if a later model request failed.
    const isCancelled = this._workerTree.isPublicationCancelled(outcome.agent_id);
    if (!isCancelled) {
      this.mergeSubagentFindings(outcome.findings ?? []);
      this._workerTree.settlePublication(outcome.agent_id, true);
    } else {
      this._workerTree.settlePublication(outcome.agent_id, false);
    }
    if (!outcome.ok || isCancelled) {
      return { success: false, output: null, error: !outcome.ok ? outcome.error : "Worker stopped by operator" };
    }


    return {
      success: true,
      output: {
        agent_id: outcome.agent_id,
        turns: outcome.turns,
        findings: outcome.findings.length,
        summary: outcome.summary,
        done: outcome.done,
      },
    };
    } finally {
      this._workerTree.settlePublication(base.agent_id, false);
      lease.release();
    }
  }


  /**
   * Fan out into N subagents that run CONCURRENTLY (bounded), instead of the
   * one-at-a-time `spawn_agent`. Each child is isolated: one failing does NOT
   * kill the batch (`runOneSubagent` never throws), and findings merge back
   * post-join in input order — never mid-flight — so there are no concurrent
   * writers to `this.ctx.findings`. The shared cost ledger + ceiling threaded
   * into each child means the ceiling binds the whole batch collectively: every
   * concurrent child adds only its own turn's usage and reads the shared total,
   * so the batch trips within one in-flight turn per active child of the
   * collective spend crossing the ceiling (same overshoot bound as the verify
   * wave).
   */
  private async spawnAgents(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.allowed_tools !== undefined || args.allowed_http_methods !== undefined) {
      return { success: false, output: null, error: "Put allowed_tools and allowed_http_methods inside each tasks entry" };
    }
    const rawTasks = args.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return {
        success: false,
        output: null,
        error: "tasks must be a non-empty array of { task, max_turns? }",
      };
    }
    const batchLimit = subagentBatchLimit();
    // Reject bad engine configuration before publishing any queued workers.
    const concurrency = subagentConcurrency();
    if (rawTasks.length > batchLimit) {
      return {
        success: false,
        output: null,
        error: `Too many subagents: ${rawTasks.length} requested, max ${batchLimit} per spawn_agents call`,
      };
    }

    // Batch shared-context Markdown (`# Goal / # Constraints / # Contract`),
    // mirrored onto the display-only Task card. Never touches execution.
    const batchContext = typeof args.context === "string" && args.context.trim() ? args.context : undefined;

    // Normalize + validate each task entry before any side effect.
    const specs: Array<{ task: string; maxTurns: number | undefined; base: SubagentLifecycleBase; selection: SubagentModelSelection; allowedTools?: string[]; allowedHttpMethods?: WorkflowHttpMethod[]; expectedWorkspace?: ExpectedWorkspace; lease?: ReturnType<AuditWorkerTree["acquire"]> }> = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const entry = rawTasks[i] as Record<string, unknown> | undefined;
      const task = entry?.task;
      if (typeof task !== "string" || !task.trim()) {
        return {
          success: false,
          output: null,
          error: `tasks[${i}].task is required and must be a non-empty string`,
        };
      }
      const selection = subagentModelSelectionSchema.safeParse(entry);
      if (!selection.success) return { success: false, output: null, error: `tasks[${i}]: ${selection.error.issues[0]?.message ?? "Invalid model selection"}` };
      const workspace = subagentWorkspaceSchema.safeParse(entry);
      if (!workspace.success) return { success: false, output: null, error: `tasks[${i}]: ${workspace.error.issues[0]?.message ?? "Invalid expected workspace"}` };
      try { if (workspace.data.expected_workspace) assertExpectedWorkspace(workspace.data.expected_workspace, this.ctx.scopePath); }
      catch (error) { return { success: false, output: null, error: `tasks[${i}]: ${(error as Error).message}` }; }
      const limits = validateSpawnPersistentAgentArgs(entry, this.ctx.consoleSession ? null : 40);
      if (!limits.ok) return { success: false, output: null, error: `tasks[${i}]: ${limits.error}` };
      let allowedTools: string[] | undefined;
      try { allowedTools = this.admittedSubagentTools(limits.args.allowedTools); }
      catch (error) { return { success: false, output: null, error: `tasks[${i}]: ${(error as Error).message}` }; }
      const maxTurns = this.admittedSubagentMaxTurns(limits.args.maxTurns);
      specs.push({ task, maxTurns, allowedTools, allowedHttpMethods: this.admittedSubagentHttpMethods(limits.args.allowedHttpMethods), base: this.buildSubagentLifecycleBase(task, maxTurns), selection: selection.data, expectedWorkspace: workspace.data.expected_workspace });
    }

    // Reserve queued work too, so stop-all cannot miss later concurrency waves.
    const publicationGate = this._workerTree.registerPublicationGate(this.ctx.scanId);
    try {
      for (const spec of specs) {
        spec.lease = this.acquireWorker(spec.base, true);
      }

    // Resolve the shared deps ONCE before fanning out, so no child sits on the
    // concurrent first-`import()` path.
    const deps = await this.loadSubagentDeps();

    // Seed sibling (child↔child) messaging for the WHOLE batch BEFORE fan-out,
    // so each concurrent child knows (and may address) its siblings by default —
    // self-contained, no TUI wiring required. See `buildSiblingMessagingBatch`
    // for the security model (gated + batch-scoped + inert prose only).
    //
    // The sibling channel is default-ON, gated by the operator setting: when the
    // parent has a messaging runtime (TUI-wired), mirror its
    // `siblingChannelEnabled`; otherwise (console — no parent runtime) read an
    // optional `allowSubagentPeerMessaging` off the context if present, default
    // TRUE. Setting it `false` disables child↔child entirely. The mailbox is the
    // SAME shared spool (keyed by projectPath+homeDir) the child derivation
    // already copies — reused here from the parent runtime, or `process.cwd()`
    // (the same key the parent TUI uses) when there is no parent runtime.
    const parentMessaging = messagingRuntimeOf(this.ctx);
    const siblingChannelEnabled =
      parentMessaging?.siblingChannelEnabled ??
      ((this.ctx as { allowSubagentPeerMessaging?: boolean }).allowSubagentPeerMessaging ?? true);
    const batchMessaging = buildSiblingMessagingBatch({
      agentIds: specs.map((s) => s.base.agent_id),
      livePeers: () => this._workerTree.peers(this.ctx.scanId),
      scanId: this.ctx.scanId,
      siblingChannelEnabled,
      projectPath: parentMessaging?.projectPath ?? process.cwd(),
      homeDir: parentMessaging?.homeDir,
      parentId: parentMessaging?.selfId,
      operatorId: parentMessaging?.operatorId,
      operatorChannelEnabled: parentMessaging?.operatorChannelEnabled ?? false,
    });
    const messagingById = new Map(batchMessaging.map((m) => [m.selfId, m]));

    // queued — emit for ALL children up front so the whole fan-out is visible
    // immediately, before the concurrency cap lets only some start running.
    for (const spec of specs) {
      this.emitWorkerLifecycle({ ...spec.base, status: "queued" as const });
    }

    const callerSignal = this._executionContext.getStore()?.signal;

    // Run bounded-concurrently. `runOneSubagent` encodes failure in its return
    // value (never throws), so one child failing leaves the pool — and its
    // siblings — untouched; `mapWithConcurrency` preserves input order.
    const rawOutcomes = await mapWithConcurrency(
      specs,
      concurrency,
      async (spec) => {
        try {
          return await this.runOneSubagent(
            spec.task,
            spec.maxTurns,
            spec.base,
            deps,
            messagingById.get(spec.base.agent_id),
            spec.selection,
            spec.lease,
            batchContext,
            spec.expectedWorkspace,
            spec.allowedTools,
            spec.allowedHttpMethods,
          );
        } finally {
          spec.lease?.release();
          spec.lease = undefined;
        }
      },
      callerSignal,
    );

    const outcomes: SubagentOutcome[] = new Array(specs.length);
    for (let i = 0; i < specs.length; i++) {
      const outcome = rawOutcomes[i];
      if (outcome) {
        outcomes[i] = outcome;
      } else {
        const spec = specs[i];
        this.emitWorkerLifecycle({
          ...spec.base,
          status: "stopped" as const,
          summary: "Stopped",
          durationMs: 0,
        });
        spec.lease?.release();
        spec.lease = undefined;
        this._workerTree.settlePublication(spec.base.agent_id, false);
        outcomes[i] = {
          ok: false,
          agent_id: spec.base.agent_id,
          error: "Stopped before dispatch",
        };
      }
    }

    // Merge findings AFTER the pool has fully joined — single-threaded, in
    // index order — so concurrent children never race on `this.ctx.findings`.
    // Keep admission leases until publication ends: a resolved stop must not
    // be followed by a late merge from an already completed concurrency wave.
    const perChild = outcomes.map((outcome, index) => {
      const spec = specs[index];
      const isCancelled = this._workerTree.isPublicationCancelled(outcome.agent_id);
      if (isCancelled) {
        if (outcome.ok) {
          this.emitWorkerLifecycle({
            ...spec.base,
            status: "stopped" as const,
            summary: "Stopped by operator",
            durationMs: 0,
          });
        }
        this._workerTree.settlePublication(outcome.agent_id, false);
        return {
          index,
          agent_id: outcome.agent_id,
          ok: false as const,
          error: !outcome.ok ? outcome.error : "Worker stopped by operator",
        };
      }
      this.mergeSubagentFindings(outcome.findings ?? []);
      this._workerTree.settlePublication(outcome.agent_id, true);
      if (outcome.ok) {
        return {
          index,
          agent_id: outcome.agent_id,
          ok: true as const,
          findings: outcome.findings.length,
          turns: outcome.turns,
          summary: outcome.summary,
          done: outcome.done,
        };
      }
      return { index, agent_id: outcome.agent_id, ok: false as const, error: outcome.error };
    });

    const succeeded = perChild.filter((c) => c.ok).length;
    // Display-only Task card sidecar (never serialized to the model — see
    // ToolResult.meta). Sub-report bullets come from the dispatched specs; the
    // TODO tree reuses the live plan snapshot verbatim so the CLI can feed it
    // straight into `buildTodoTreeRows`.
    const meta: ToolResultMeta = {
      kind: "task",
      taskLabel: `${specs.length} ${specs.length === 1 ? "agent" : "agents"}`,
      ...(batchContext !== undefined ? { taskContext: batchContext } : {}),
      subReports: specs.map((s) => {
        const brief = agentTaskLabel(s.task);
        return {
          name: s.base.name,
          ...(s.selection.role ? { agent: s.selection.role } : {}),
          ...(brief ? { brief } : {}),
        };
      }),
    };
    return {
      success: true,
      output: {
        spawned: specs.length,
        succeeded,
        failed: specs.length - succeeded,
        agents: perChild,
      },
      meta,
    };
    } finally {
      publicationGate();
      for (const spec of specs) {
        this._workerTree.settlePublication(spec.base.agent_id, false);
        spec.lease?.release();
        spec.lease = undefined;
      }
    }
  }


  /**
   * Child-only status channel (Task 2). Strictly NON-PRIVILEGED: it records
   * nothing durable and touches no filesystem, network, or subprocess. The
   * sanitized line is echoed back so the child sees confirmation and keeps a
   * clean context; the actual `subagent_progress` emission happens in the
   * parent's `onTurn` hook (the only place that knows this child's `agent_id`),
   * so this handler must NOT emit. Reachable only by sub-agents — it is injected
   * into the sub-agent tool set and routed via CHILD_LOCAL_DISPATCH; it is not
   * in the global TOOL_DEFINITIONS / TOOL_DISPATCH tables, so normal scans and
   * the parent never see it.
   */
  private reportStatus(args: Record<string, unknown>): ToolResult {
    const note = sanitizeSubagentNote(args.status);
    if (!note) {
      return {
        success: false,
        output: null,
        error: "report_status requires a non-empty 'status' string",
      };
    }
    return { success: true, output: { recorded: true, status: note } };
  }


  /**
   * Child-only: send a short message to the parent, an enabled sibling, or the
   * operator.
   *
   * Grants NO authority. The addressing POLICY is the pure
   * {@link decideAddressing}; this handler only enforces the verdict, clamps the
   * body ({@link clampOutboundBody}), and hands inert prose to the mailbox. A
   * denial returns {@link AddressDecision}'s generic reason, which never names
   * another peer, so the roster cannot be probed. Reachable only by subagents
   * (injected into the sub-agent tool set, routed via CHILD_LOCAL_DISPATCH).
   */
  private sendPeerMessage(args: Record<string, unknown>): ToolResult {
    const rt = messagingRuntimeOf(this.ctx);
    if (!rt) {
      return { success: false, output: null, error: "Agent messaging is not available in this session." };
    }

    const to = args.to;
    if (typeof args.body !== "string" || args.body.trim().length === 0) {
      return { success: false, output: null, error: "send_message requires a non-empty 'body' string." };
    }

    const decision = decideAddressing(rt, to);
    if (!decision.allowed) {
      // The reason is deliberately generic — it never names a peer, so a child
      // cannot enumerate the roster by watching which addresses are refused.
      return { success: false, output: null, error: decision.reason };
    }

    const { body, truncated } = clampOutboundBody(args.body);
    // Date.now() is fine here (a tool handler, not pure logic); the mailbox and
    // the pure policy never read a clock.
    const ts = Date.now();
    const msg: HubMessage = {
      id: newMessageId(ts),
      from: rt.selfId,
      to: to as string,
      body,
      ts,
    };
    if (typeof args.reply_to === "string" && args.reply_to.length > 0) {
      msg.replyTo = args.reply_to;
    }

    const result = sendMessage(rt.projectPath, msg, rt.homeDir);
    if (!result.ok) {
      return { success: false, output: null, error: `Message could not be delivered (${result.reason ?? "io-error"}).` };
    }
    // Surface the send so an IRC-style chat view can render inter-agent traffic
    // live. Observability only — delivery already happened via the mailbox and
    // decideAddressing already authorized it; this event grants nothing.
    eventBus.emit("peer_message", {
      from: msg.from,
      to: msg.to,
      body: msg.body,
      ts: msg.ts,
      kind: msg.to === "all" ? "broadcast" : "peer",
      id: msg.id,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    });
    return {
      success: true,
      output: {
        delivered: true,
        to: to as string,
        truncated: truncated || result.truncated === true,
        dropped: result.dropped,
      },
    };
  }


  /**
   * Child-only: read and CONSUME messages addressed to this agent.
   *
   * Delivered bodies retain sender attribution and their original content.
   * The handler touches no authorization state. Drains are bounded per turn
   * and per drain so a chatty peer cannot flood this agent's context.
   */
  private checkPeerMessages(args: Record<string, unknown>): ToolResult {
    const rt = messagingRuntimeOf(this.ctx);
    if (!rt) {
      return { success: false, output: null, error: "Agent messaging is not available in this session." };
    }

    const offset = args.peer_offset ?? 0;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
      return { success: false, output: null, error: "peer_offset must be a non-negative safe integer" };
    }
    if (args.peers_only !== undefined && typeof args.peers_only !== "boolean") {
      return { success: false, output: null, error: "peers_only must be a boolean" };
    }
    const livePeers = rt.siblingChannelEnabled ? (rt.knownPeerIds ?? []) : [];
    const peers = livePeers.slice(offset as number, (offset as number) + SUBAGENT_PEER_PAGE_SIZE);
    const roster = {
      peers,
      peerCount: livePeers.length,
      ...((offset as number) + peers.length < livePeers.length
        ? { nextPeerOffset: (offset as number) + peers.length } : {}),
    };
    if (args.peers_only) return { success: true, output: roster };

    // Per-turn drain cap. Reset the counter when the executing turn advances.
    const turn = this.ctx.currentTurn ?? 0;
    if (turn !== this._msgDrainTurn) {
      this._msgDrainTurn = turn;
      this._msgDrainCount = 0;
    }
    if (this._msgDrainCount >= MAX_DRAINS_PER_TURN) {
      return {
        success: true,
        output: {
          messages: [],
          note: `check_messages is limited to ${MAX_DRAINS_PER_TURN} calls per turn; try again next turn.`,
        },
      };
    }
    this._msgDrainCount += 1;

    const inbound = drainInbox(rt.projectPath, rt.selfId, rt.homeDir);
    if (inbound.length === 0) {
      return { success: true, output: { messages: [], ...roster, note: "No new messages." } };
    }

    const { rendered, omitted } = renderInboundBatch(inbound);

    const messages = rendered.map((r) => r.text);
    return {
      success: true,
      output: {
        messages,
        ...roster,
        count: messages.length,
        ...(omitted > 0
          ? { note: `${omitted} older message(s) omitted this drain (per-drain cap).` }
          : {}),
      },
    };
  }
}

// ── Helper: get tools for a specific agent role ──

/** The one tool list every thread, child run and sentinel turn gets: all registered tools except `memory`, which the session adds when Memory is on. */
export function getToolsForRole(opts?: { webSearchEnabled?: boolean }): ToolDefinition[] {
  const webSearch = opts?.webSearchEnabled ?? featureFlags.webSearch;
  return filterWorkflowAgentTools(Object.keys(TOOL_DEFINITIONS)
    .filter((name) => name !== "memory" && (webSearch || name !== "web_search"))
    .map((name) => TOOL_DEFINITIONS[name]));
}
