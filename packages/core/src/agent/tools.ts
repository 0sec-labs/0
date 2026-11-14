import { confirmedStateProof, latestStateProof, observedState, stateContract, stateDigest } from "./access-milestone-proof.js";
import { subagentBatchLimit, subagentConcurrency } from "./subagent-limits.js";
import { parseRequest, type OracleResult } from "../triage/oracles.js";
import { assertExpectedWorkspace, assertWorkspaceIdentity, captureWorkspaceIdentity, type ExpectedWorkspace, type WorkspaceIdentity } from "./workspace-identity.js";
import { filterWorkflowAgentTools, isWorkflowAgentToolAllowed, withWorkflowAuditExecutionPolicy, getWorkflowAuditExecutionPolicy, isWorkflowHttpMethodAllowed, WORKFLOW_HTTP_METHODS, type WorkflowHttpMethod, type WorkerPolicy, snapshotWorkerPolicy } from "../workflow-execution-policy.js";
import { retainBrowserScreenshot } from "../browser-evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";
import type { Finding, AccessControlFixture, TargetInfo, NamedIdentity } from "@0/shared";
import { resolveIdentities, DEFAULT_AUTONOMY_MODE, createJevEvaluator, jevConfigFromEnvironment, type JevEvaluator } from "@0/shared";
import type { ToolDefinition, ToolCall, ToolResult, ToolResultMeta, ToolContext } from "./types.js";
import type { OperatorQuestionRequest } from "./types.js";
import type { NativeRuntime, SubagentModelSelection } from "../runtime/types.js";
import type { LootKind } from "./loot.js";
import { applyPlanAction, validatePlanArgs } from "./task-ledger.js";
import type { OastHandle } from "../oast/types.js";
import { confirmOast, categoryToOastClass, deriveProbe, type OastClass, type OastVerdict } from "../oast/index.js";
import type { ScopePolicy } from "../scope/scope.js";
import { extractUrls } from "../scope/scope.js";
import { classifyResponse, runEvasionCampaign, type HttpRequestParts, type WafResponseLike } from "../scope/waf-detect.js";
import { detectScannerBinary } from "../scope/scanner-binaries.js";
import { describeScopeGuards, scopeRequiredRefusal } from "../scope/scope-guard.js";
import { getScopeEnforcementState, isScopeEnforcementEnabled, withScopeEnforcement } from "../scope/activation.js";
import { isWafEvasionLadderEnabled } from "../scope/engagement-profile.js";
import { applyAttribution, formatUserAgent } from "../scope/attribution.js";
import { sendPrompt, extractResponseText, fetchScoped } from "../http.js";
import { buildAuthHeaders } from "./prompts.js";
import { authSecretValues, redactAuthHeaders, redactAuthValues, sensitiveHeaderValues } from "./auth-redaction.js";
import { formatTruncated } from "./output-truncation.js";
import { runStructuralSqliProbeAsync, type ProbeObservation } from "./structural-sqli.js";
import { runAuthBoundaryProbe, type FetchLike as AuthBoundaryFetchLike, type ProbeEndpoint as AuthBoundaryEndpoint } from "./auth-boundary-prober.js";
import { runRecon } from "../recon/recon.js";
import { runJsRecon } from "../recon/js-recon.js";
import { isRepoRelativePath, isSuggestionAcceptable, probeFileRefTarget } from "../findings-parser.js";
import { probeS3Bucket, classifyTakeover, validateAwsCredentials, bucketInScope } from "./cloud-surface.js";
import { classifyPromptLayerImpact, type PromptLayerAsset } from "./playbooks.js";
import type { osecDB } from "@0/db";
import { searchParallel } from "./tools/web-search-parallel.js";
import { parseDuckDuckGoResults, readWebSearchResponse } from "./tools/web-search-response.js";
import { features as featureFlags } from "./features.js";
import { PtySessionManager } from "./pty-session.js";
import { sanitizedEnv } from "./sanitized-env.js";
import { PythonKernelManager } from "./python-kernel.js";
import { runWpFingerprint, summarizeWpFingerprint, type FetchLike } from "./wp-fingerprint.js";
import { runScannerProcess, buildSqlmapArgv, buildNmapArgv, buildFfufArgv, buildNucleiArgv, parseSqlmapOutput, parseNmapOutput, parseFfufOutput, parseNucleiOutput, suggestedFindingsFor, summarizeScannerResult, type ScannerParsedResult, type ScannerRunStats } from "./scanner-tools.js";
import { scannerEngagementGate } from "./scanner-profile.js";
import { validateFlagShape } from "./flag-validator.js";
import { extractPocStepsFromProse } from "./poc-steps-from-prose.js";
import { computeFindingConfidence } from "./finding-confidence.js";
import { parseRepositoryAcquisition, repositoryAcquisitionAllowed, repositoryIdentityMatchesTarget, runRepositoryAcquisition } from "./repository-acquisition.js";
import { validateFindingDraft, type FindingDraft } from "./finding-validator.js";
import { forgeObjectId, forgeObjectIdSequence, parseObjectId } from "./objectid-forge.js";
import { JSFUCK_ALERT_PAYLOAD, JSFUCK_XSS_PAYLOAD } from "./payloads.js";
import { parsePatch, applyPatchOps } from "./apply-patch.js";
import { listScopedFiles, readScopedFile, searchScopedFiles } from "./tools/scoped-source.js";
import { normalizeFindingTitle, levenshtein, evidenceRequestPrefix, FUZZY_TITLE_DISTANCE_THRESHOLD } from "./tools-helpers.js";
import { listSkillSummaries, getSkillById, matchTriggers, loadSkillRegistry } from "./skills/index.js";
import type { SkillDefinition } from "./skills/index.js";
import { loadSkillBundleFromManifest } from "./skills/markdown-bundle.js";
import { discoverAgentSkills, loadAgentSkill } from "./skills/agent-skills.js";
import { executeSkillAuthoring } from "./skills/skill-authoring.js";
import { eventBus } from "../events/bus.js";
import type { SubagentLifecyclePayload } from "../events/bus.js";
import { ToolHealthTracker } from "./tool-health.js";
import type { ToolHealthRecordInput, ToolHealthSummary } from "./tool-health.js";
import { TodoTracker, validateUpdateTodosArgs, buildTodosPayload } from "./todos.js";
import type { TodoSnapshot } from "./todos.js";
import { drainInbox, newMessageId, sendMessage, type HubMessage } from "../hub/mailbox.js";
import { PRIMARY_AGENT_NAME, agentTaskLabel, assignAgentName } from "../hub/name-generator.js";
import { runPersistentAgent } from "../hub/supervisor.js";
import { AuditWorkerTree } from "./worker-tree.js";
import { BackgroundAgentQueue } from "./background-agent-queue.js";
import { ProcessManager, probePort, type ReadyGate } from "./process-manager.js";
import { MCP_TOOL_PREFIX } from "./mcp-adapt.js";
import { DeferredToolRegistry, LIST_TOOLS_NAME, LOAD_TOOL_NAME, formatToolCatalog, formatLoadResult } from "./deferred-tools.js";
import { MAX_DRAINS_PER_TURN, clampOutboundBody, decideAddressing, renderInboundBatch, type MessagingRuntime } from "./agent-messaging.js";
import { mapWithConcurrency } from "../concurrency.js";
import { executeIntel } from "./tools/intel.js";
import { executeAdAttackPaths, executeEntraAttackPaths, executeEntraPosture, executeAssembleAdvisory, executeCveLookup } from "./tools/security-engines.js";
import { executeVariantHunt, executeAssumptionHunt, executeGenerateFix, executeVerifyFinding, executeProtocolConformance, executeSpecDrift, executeSafetyEval, executeMemsafetyFuzz, executeNpmDynamicDiscovery, executeWeaponizeKernel, executeCveAdapt } from "./tools/offensive-engines.js";
import { executeBrowser, type BrowserDriverHost } from "./tools/browser.js";
import { resolveScopedPath } from "./tools/scope-path.js";
import { getLocalSourceBoundary, withLocalSourceBoundary } from "../scope/local-source-boundary.js";
import { windowFileContent } from "./tools/read-file-window.js";
import { buildEvalCommand, parseEvalArgs, type EvalLanguage } from "./tools/eval.js";
import { executeOverseScan, validateOverseArgs } from "./tools/0verse.js";
import { executeJevPrepass } from "./tools/jev-prepass.js";
import { TOOL_DEFINITIONS, SCANNER_TOOL_NAMES, CLOUD_TOOL_NAMES, OAST_TOOL_NAMES, BINARY_TOOL_NAMES, OFFENSIVE_SCOPED_TOOL_NAMES, MEMSAFETY_TOOL_NAMES, NPM_DISCOVERY_TOOL_NAMES, KERNEL_WEAPONIZE_TOOL_NAMES, CVE_ADAPT_TOOL_NAMES, LEGACY_DELEGATION_TOOL_NAMES } from "./tools/index.js";
import { executeProxy, type ProxyHost } from "./tools/proxy.js";
import { TOOL_DISPATCH } from "./tools/dispatch.js";
import { z } from "zod";
import type { GuardContext } from "../plugins/guards.js";
import { rememberCodebaseArgsSchema, validateSelfExtendArgs, selfExtensionRegistryOf, nonEmptyString, buildOperatorQuestionRequest, toolExecutorCheckpointSchema, type ToolExecutorCheckpoint, inlineImpactAssessmentSchema } from "./tools/agent-args.js";
import { SUBAGENT_MODEL_TIMEOUT_MS, resolveBashWallclockCeilingMs, runBashWithWallclock, SCANNER_INSTALL_HINTS, executePipeline, buildEditCardMeta, buildStrReplaceMeta } from "./tools/exec-helpers.js";
import { SCOPED_SOURCE_AUDIT_TOOLS, isCheckoutReadOnlyTool, containsUnquotedShellChars, splitOnTopLevelPipes, detectHttpEgressSegments, injectAuthIntoBashCommand, tokenizeCommand, resolveDependencyAuditCommand } from "./tools/shell-commands.js";
import { validateScopedCommand, validateTargetUrl } from "./tools/target-validation.js";
import { parseVerificationSpecArg, autoVerificationSpec, evaluateSourceVerification, parsePocStepsArg, parseEvidencePathsArg, buildValidationFailureResult, SOURCE_FILE_RE, evaluateDoneCoverageGate } from "./tools/verification.js";
import { type ProbePrincipal, type ProbeResponse, is2xx, diffAccessResponses, probeEvidence, citedSourceHasKnownMarker, capText, tracebackTail } from "./tools/probe-helpers.js";
import { SUBAGENT_PEER_PAGE_SIZE, sanitizeSubagentNote, REPORT_STATUS_TOOL, CHILD_LOCAL_DISPATCH, messagingRuntimeOf, mcpHostOf, deferredToolsOf, buildSendMessageTool, subagentSiblingPrefix, buildSiblingMessagingBatch, CHECK_MESSAGES_TOOL, renderSubagentMessagingPrompt, PERSIST_POLL_MS, PERSIST_IDLE_TTL_MS, PERSIST_MAX_REVIVES, subagentWorkspaceSchema, subagentModelSelectionSchema, validateSpawnPersistentAgentArgs, MONITOR_READY_TIMEOUT_DEFAULT_S, MONITOR_TIMEOUT_MAX_S, MONITOR_POLL_MS, validateMonitorArgs, type SubagentOutcome, type SubagentRunReport, type SubagentLifecycleBase, buildSubagentProgress, buildSubagentMessage, type SubagentDeps } from "./tools/subagents.js";

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
  SCANNER_TOOL_NAMES,
  CLOUD_TOOL_NAMES,
  OAST_TOOL_NAMES,
  BINARY_TOOL_NAMES,
  OFFENSIVE_SCOPED_TOOL_NAMES,
  MEMSAFETY_TOOL_NAMES,
  NPM_DISCOVERY_TOOL_NAMES,
  KERNEL_WEAPONIZE_TOOL_NAMES,
  CVE_ADAPT_TOOL_NAMES,
  LEGACY_DELEGATION_TOOL_NAMES,
};

// Tool-name → handler-method-name routing table (0#614), assembled from
// per-domain `*Dispatch` maps. `ToolExecutor._dispatch` resolves the handler
// off the instance by this name, replacing the hand-written switch so adding a
// tool no longer edits a shared dispatch chokepoint.

// Model self-extension (session-scoped, additive-only registry). The registry
// itself lives in ../plugins/self-extension.ts (validation + policy + limits);
// `self_extend` is a thin, Zod-validated front door to its `register`, and the
// dispatcher routes calls to model-registered tools through the same registry so
// they are guard-evaluated under their DECLARED capability gate flags.

export { sanitizedEnv } from "./sanitized-env.js";

// ── Public API moved to ./tools/*.ts (re-exported unchanged) ──
export { validateSelfExtendArgs, selfExtensionRegistryOf, MIN_OPERATOR_QUESTIONS, MAX_OPERATOR_QUESTIONS, MIN_OPERATOR_OPTIONS, MAX_OPERATOR_OPTIONS, buildOperatorQuestionRequest, toolExecutorCheckpointSchema } from "./tools/agent-args.js";
export { containsUnquotedShellChars, splitOnTopLevelPipes, detectHttpEgressSegments, injectAuthIntoBashCommand, detectPackageManager, resolveDependencyAuditCommand } from "./tools/shell-commands.js";
export { parseVerificationSpecArg, autoVerificationSpec, parsePocStepsArg, parseEvidencePathsArg, buildValidationFailureResult, evaluateDoneCoverageGate } from "./tools/verification.js";
export { bodySimilarity, diffAccessResponses } from "./tools/probe-helpers.js";
export { sanitizeSubagentNote, SELF_EXTENSION_RESERVED_TOOL_NAMES, buildSendMessageTool, buildSiblingMessagingBatch, validateSpawnPersistentAgentArgs, validateMonitorArgs, buildSubagentProgress, buildSubagentMessage } from "./tools/subagents.js";
export type { SelfExtendArgs, OperatorQuestionBuildResult, ToolExecutorCheckpoint } from "./tools/agent-args.js";
export type { AuthInjectResult, DetectedPackageManager, DependencyAuditResolution } from "./tools/shell-commands.js";
export type { CoverageGateInput, CoverageGateDecision } from "./tools/verification.js";
export type { ProbeResponse, AccessDiffResult } from "./tools/probe-helpers.js";
export type { MonitorArgs } from "./tools/subagents.js";


// ── Tool Executor ──

const OAST_CLASS_BY_NAME: Record<string, OastClass> = {
  "blind-ssrf": "blind-ssrf",
  "blind-xss": "blind-xss",
  "oob-rce": "oob-rce",
  "oob-sqli": "oob-sqli",
  "xxe-oob": "xxe-oob",
  jndi: "jndi",
};


export class ToolExecutor {
  private db: osecDB | null;
  private ctx: ToolContext;
  private readonly _credentialTarget: string;
  /**
   * Cross-call holder for the next-gen browser driver (tools/browser.ts). The
   * multi-tab driver is created lazily on the first `browser` call and cached
   * here so tabs live across turns; disposed in {@link cleanup}. Replaces the
   * old single-page `_browser`/`_browserPage`/`_browserActionContext` fields.
   */
  private _browserHost: BrowserDriverHost = {};
  private _browserJev: JevEvaluator | null | undefined;
  private _browserReadOnlyUrls: ReadonlySet<string> = new Set();
  private _playwrightAvailable: boolean | null = null;
  private _ptyManager: PtySessionManager | null = null;
  private _pyKernel: PythonKernelManager | null = null;
  private readonly _workerTree: AuditWorkerTree;
  private readonly _ownsWorkerTree: boolean;
  private readonly _workerFindings: Finding[];
  /**
   * Supervises this session's background processes (the `monitor` tool). Lazily
   * created; every live process is killed in cleanup() so none outlives the
   * session. See `process-manager.ts`.
   */
  private _processManager: ProcessManager | null = null;
  /**
   * Per-session intercepting-proxy state (burp-network-20260913). Holds the
   * running ProxyDriver, the in-memory HTTP-history store, the bound port, and
   * installed match/replace rules across turns. The driver's listener is torn
   * down in cleanup() so no proxy outlives the session. See `tools/proxy.ts`.
   */
  private _proxyHost: ProxyHost = {};
  /**
   * Set of proposed flag strings that the `done` tool rejected once as
   * likely decoys. A second `done` call with the same flag passes through
   * — the anti-honeypot heuristic is a speed bump, not a hard wall.
   * See GitHub issue #82.
   */
  private _rejectedDecoyFlags: Set<string>;

  /**
   * Lazily loaded cloud audit-skill bundle from ZERO_AUDIT_SKILLS_MANIFEST.
   * null = env not set (no cloud skills); Map = already loaded and cached.
   * Populated on first listSkills/loadSkill call that finds the env var.
   */
  private _cloudSkillBundle: Map<string, SkillDefinition> | null | undefined;

  /**
   * Per-session memory for the scoped-source-audit escalation gate
   * (see `_evaluateScopedAuditGate`). Keyed by tool NAME. `_scopedAuditGrants`
   * holds tools the operator approved this session — approved once, never
   * re-prompted. `_scopedAuditDenials` holds tools the operator declined —
   * denied outright on retry without re-prompting. Both mirror the
   * denied-host / denied-path memory pattern in `console/turn-engine.ts`.
   * In-memory only; the executor is constructed once per console session and
   * discarded with it, so these are session-scoped and never persisted.
   */
  private _scopedAuditGrants: Set<string>;
  private _scopedAuditDenials: Set<string>;

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

  /**
   * OAST interaction handles minted this scan, plus verified callback verdicts
   * keyed by the opaque handle id. `save_finding` consumes only this trusted
   * cache, so an agent cannot turn a made-up callback string into verification.
   */
  private _oastHandles: Map<string, OastHandle> = new Map();
  private _oastCandidates: Map<string, string> = new Map();
  private _oastVerified: Map<string, { oastClass: OastClass; verdict: OastVerdict }> =
    new Map();

  // ── Coverage-gate tracking (#audit-laziness) ──
  // Populated incrementally inside `execute()` so `markDone` can refuse
  // calls from audit / review sub-agents that haven't inspected any
  // source. See `evaluateDoneCoverageGate` above.
  private _startedAt: number;
  private _sourceFilesRead: Set<string>;
  private _totalNonDoneToolCalls: number = 0;
  private _doneRejections: number = 0;

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
   * Optional bound factory for creating independent child (subagent) runtimes.
   * Received as the fourth constructor argument. Without this capability,
   * child construction fails closed rather than rediscovering credentials.
   */
  private _childRuntimeFactory: NativeRuntime["forkForSubagent"];

  /**
   * Tool-health recorder (0#tool-reliability). Uses the shared tracker on
   * the ToolContext when the caller wired one (so the run summary sees the same
   * events), else a private per-executor tracker so recording is always safe.
   * Either way, new distinct events fan out on the event bus as `tool_health`.
   */
  private _toolHealth: ToolHealthTracker;

  /**
   * Structured full-state plan tracker for `update_todos` / `write_todos`.
   * Uses the shared tracker on the ToolContext when the caller wired one (so
   * the run-level snapshot sees the same plan), else a private per-executor
   * tracker so the tool always works. Either way, a plan CHANGE fans out on the
   * event bus as `todos`.
   */
  private _todos: TodoTracker;
  private _workspaceIdentity?: WorkspaceIdentity;
  private readonly _localSourceBoundary = getLocalSourceBoundary();

  /** Search policy changes require quiescent children so their inherited policy stays consistent. */
  configureWebSearch(enabled: boolean): void {
    if (this._workerTree.hasLiveWorkers()) throw new Error("Finish active agents before changing web search.");
    this.ctx.webSearchEnabled = enabled;
  }

  private checkedWorkerPolicy(policy: WorkerPolicy | undefined): WorkerPolicy | undefined {
    const snapshot = snapshotWorkerPolicy(policy);
    for (const name of snapshot?.allowedTools ?? []) {
      if (!Object.hasOwn(TOOL_DEFINITIONS, name) && !Object.hasOwn(CHILD_LOCAL_DISPATCH, name)) {
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
    this._scopedAuditGrants.clear();
    this._sourceFilesRead.clear();
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
    this._workspaceIdentity = ctx.workspaceIdentity ?? captureWorkspaceIdentity(ctx.scopePath);
    this._credentialTarget = initialCheckpoint?.credentialTarget ?? ctx.target;
    this._rejectedDecoyFlags = new Set(initialCheckpoint?.rejectedDecoyFlags);
    this._scopedAuditGrants = new Set(initialCheckpoint?.scopedAuditGrants);
    this._scopedAuditDenials = new Set(initialCheckpoint?.scopedAuditDenials);
    this._assignedAgentNames = new Set(initialCheckpoint?.assignedAgentNames ?? [PRIMARY_AGENT_NAME]);
    this._sourceFilesRead = new Set(initialCheckpoint?.sourceFilesRead);
    this._startedAt = initialCheckpoint?.startedAt ?? Date.now();
    this.db = db;
    this._idFactory = idFactory;
    this._childRuntimeFactory = childRuntimeFactory;
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
    this._todos =
      ctx.todos ??
      new TodoTracker({
        seed: initialCheckpoint?.todos,
        emit: (snap) => {
          eventBus.emit("todos", { ...buildTodosPayload(snap), scan_id: this.ctx.scanId });
        },
      });

    if (initialCheckpoint) {
      for (const { id, handle } of initialCheckpoint.oastHandles) this._oastHandles.set(id, structuredClone(handle));
      for (const { id, candidate } of initialCheckpoint.oastCandidates) this._oastCandidates.set(id, candidate);
      for (const { id, oastClass, verdict } of initialCheckpoint.oastVerified) {
        this._oastVerified.set(id, { oastClass, verdict: structuredClone(verdict) });
      }
      this._totalNonDoneToolCalls = initialCheckpoint.totalNonDoneToolCalls;
      this._doneRejections = initialCheckpoint.doneRejections;
      this._msgDrainTurn = initialCheckpoint.msgDrainTurn;
      this._msgDrainCount = initialCheckpoint.msgDrainCount;
    }
  }

  // ── Checkpoint export (engine replacement boundary) ──────────────────

  /**
   * Produce a defensively-copied snapshot of this executor's memory state,
   * suitable for JSON-serialization and later restoration into a new executor
   * via the fifth constructor argument.
   *
   * **Explicitly excluded** (live resources drained by the caller / old engine):
   *   - `_browserHost` (BrowserDriverHost — live browser tabs)
   *   - `_playwrightAvailable` (lazily recomputed on the new instance)
   *   - `_ptyManager` / `_pyKernel` (live PTY / Python kernel sessions)
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
      rejectedDecoyFlags: [...this._rejectedDecoyFlags],
      scopedAuditGrants: [...this._scopedAuditGrants],
      scopedAuditDenials: [...this._scopedAuditDenials],
      assignedAgentNames: [...this._assignedAgentNames],
      oastHandles: [...this._oastHandles.entries()].map(([id, handle]) => ({ id, handle: structuredClone(handle) })),
      oastCandidates: [...this._oastCandidates.entries()].map(([id, candidate]) => ({ id, candidate })),
      oastVerified: [...this._oastVerified.entries()].map(([id, value]) => ({ id, oastClass: value.oastClass, verdict: structuredClone(value.verdict) })),
      startedAt: this._startedAt,
      sourceFilesRead: [...this._sourceFilesRead],
      totalNonDoneToolCalls: this._totalNonDoneToolCalls,
      doneRejections: this._doneRejections,
      msgDrainTurn: this._msgDrainTurn,
      msgDrainCount: this._msgDrainCount,
      todos: {
        items: this._todos.list(),
        revision: this._todos.revision,
      },
      toolHealth: this._toolHealth.list().map(event => ({ ...event })),
    };
  }

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

  /**
   * Concise roll-up of tool-health events recorded by this executor, for the
   * per-run "N tool issues" line and the CLI /doctor path.
   */
  toolHealthSummary(): ToolHealthSummary {
    return this._toolHealth.summary();
  }

  /**
   * `update_todos` / `write_todos` — REPLACE the entire task plan (TodoWrite
   * shape). The raw payload is validated against `updateTodosArgsSchema` and a
   * rejection is fed straight back as an `is_error` tool result so the model
   * self-corrects (agent/CLAUDE.md §1). Only after validation does the tracker
   * change; a change fans out on the bus as `todos`. It authorizes nothing and
   * grants no capability — it records only the declared plan.
   */
  private updateTodos(args: Record<string, unknown>): ToolResult {
    const validated = validateUpdateTodosArgs(args);
    if (!validated.ok) {
      return { success: false, output: null, error: validated.error };
    }
    const snap = this._todos.set(validated.todos);
    return {
      success: true,
      output: {
        message: `plan: ${snap.progress.total} tasks, ${snap.progress.done} done`,
        // Echo the full plan back so the model's next decision sees the whole
        // state it just declared, not just a confirmation.
        todos: snap.todos,
        groups: snap.groups.map((g) => ({
          group: g.group,
          done: g.done,
          total: g.total,
        })),
        done: snap.progress.done,
        total: snap.progress.total,
        line: snap.summaryLine,
      },
    };
  }

  /** Current full-state plan snapshot recorded by this executor (for run end). */
  todosSnapshot(): TodoSnapshot {
    return this._todos.snapshot();
  }

  /** Check if playwright is installed (cached). */
  async isPlaywrightAvailable(): Promise<boolean> {
    if (this._playwrightAvailable !== null) return this._playwrightAvailable;
    try {
      // @ts-ignore — playwright is an optional dependency
      await import("playwright");
      this._playwrightAvailable = true;
    } catch {
      this._playwrightAvailable = false;
    }
    return this._playwrightAvailable;
  }

  private usesTargetIdentity(url: string): boolean {
    try {
      return new URL(url, this._credentialTarget).origin === new URL(this._credentialTarget).origin;
    } catch {
      return false;
    }
  }

  /**
   * Outbound auth headers for the CURRENTLY ACTIVE identity (0#564).
   *
   * When a stateful `SessionEngine` is wired into the context, this returns the
   * active identity's static credential merged with any cookies its jar has
   * captured this scan. With no session it falls back to the legacy stateless
   * `buildAuthHeaders(authConfig)` path. Credentials and cookie jars remain
   * bound to the executor's original target origin, even after a target or
   * autonomy-mode change; scope grants never authorize credential forwarding.
   */
  private activeAuthHeaders(url = this.ctx.target): Record<string, string> {
    if (!this.usesTargetIdentity(url)) return {};
    const session = this.ctx.session;
    if (session) {
      return session.headersFor(session.activeLabel, this._credentialTarget);
    }
    return buildAuthHeaders(this.ctx.authConfig);
  }

  /**
   * Capture `Set-Cookie` from a response into the active identity's jar and
   * run the 401/403 re-auth handler (0#564). No-op without a session.
   */
  private captureActiveCookies(res: Response, url = this.ctx.target): void {
    if (!this.usesTargetIdentity(url)) return;
    const session = this.ctx.session;
    if (!session) return;
    const identityTarget = this._credentialTarget;
    session.capture(session.activeLabel, res.headers, identityTarget);
    session.handleAuthStatus(session.activeLabel, res.status, identityTarget);
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

  private emitWorkerLifecycle(payload: SubagentLifecyclePayload): void {
    this._workerTree.observeLifecycle(payload);
    eventBus.emit("subagent_lifecycle", payload);
  }

  /** Stop an owned subtree; completion means all worker cleanup has drained. */
  async stopPersistentAgent(agentId: string): Promise<boolean> {
    return this._workerTree.stop(agentId, this.ctx.scanId);
  }

  /** Stop owned workers while retaining the conversation and root executor. */
  async stopPersistentAgents(): Promise<void> {
    await this._workerTree.stopAll(this.ctx.scanId);
  }

  /** Clean up browser and PTY resources. Call when the agent loop ends. */
  async cleanup(): Promise<void> {
    if (this._ownsWorkerTree) await this._workerTree.close();
    try {
      if (this._browserHost.driver) {
        await this._browserHost.driver.dispose().catch(() => {});
        this._browserHost.driver = null;
      }
      if (this._ptyManager) {
        this._ptyManager.cleanup();
        this._ptyManager = null;
      }
      if (this._pyKernel) {
        this._pyKernel.cleanup();
        this._pyKernel = null;
      }
      if (this._processManager) {
        // Kill every background process the monitor tool started.
        this._processManager.killAll();
        this._processManager = null;
      }
      if (this._proxyHost.driver) {
        // Tear down the intercepting proxy listener so no port outlives the
        // session (captured history is discarded with the executor).
        await this._proxyHost.driver.stop().catch(() => {});
        this._proxyHost.driver = null;
      }
    } catch {
      // Best-effort cleanup
    }
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
    const scopeEnforcement = getScopeEnforcementState();
    this.ctx.scopeEnforcement = scopeEnforcement;
    return withLocalSourceBoundary(this._localSourceBoundary ?? getLocalSourceBoundary(), () => withScopeEnforcement(scopeEnforcement, () => this._executionContext.run({ correlationId: opts?.correlationId, signal, assertAuthority }, async () => {
    try {
      signal?.throwIfAborted();
      assertAuthority?.();
      if (call.name === "web_search" && this.ctx.webSearchEnabled === false) return { success: false, output: null, error: "Web search is disabled for this chat." };
      if (call.name === "http_request" && !isWorkflowHttpMethodAllowed(call.arguments.method ?? "POST")) return { success: false, output: null, error: `HTTP method "${String(call.arguments.method ?? "POST")}" is not allowed in this workflow phase` };
      if (!isWorkflowAgentToolAllowed(call.name)) return { success: false, output: null, error: `Tool "${call.name}" is not allowed in this workflow phase` };
      if (this.ctx.workerTree && this.ctx.delegationTools &&
          !this.ctx.delegationTools.some(tool => tool.name === call.name) &&
          !this.ctx.selfExtension?.tools().some(tool => tool.name === call.name)) {
        return { success: false, output: null, error: `Tool "${call.name}" is not available to this delegated agent` };
      }
      const safeLocal = isCheckoutReadOnlyTool(call.name);
      if (this.isReadOnlyWorker() && !safeLocal) return { success: false, output: null, error: "Tool is unavailable in inherited read-only delegation" };
      const scopedAuditVerdict = await this._evaluateScopedAuditGate(call);
      if (scopedAuditVerdict) return scopedAuditVerdict;
      signal?.throwIfAborted();
      assertAuthority?.();

      // Coverage-gate accounting (#audit-laziness). Counted BEFORE dispatch
      // so a tool that throws still contributes to the "total tool calls"
      // denominator — that matches the laziness-detection intent (the agent
      // tried to do something, even if it failed). `done` is excluded so
      // its own emission doesn't satisfy the gate.
      if (call.name !== "done") {
        this._totalNonDoneToolCalls += 1;
      }

      const releaseMutation = !safeLocal ? this._workerTree.beginLocalMutation(this.ctx.scanId, this.checkoutKeys(), call.name) : undefined;
      let result: ToolResult;
      try { result = await this._dispatch(call); } finally { releaseMutation?.(); }

      // Source-file tracking — only count successful read_file calls whose
      // resolved path looks like a source file. Reading package.json,
      // README.md, LICENSE doesn't count — those are exactly the files the
      // lazy-agent bug stops on.
      if (call.name === "read_file" && result.success) {
        const path = typeof call.arguments?.path === "string" ? call.arguments.path : "";
        if (path && SOURCE_FILE_RE.test(path)) {
          this._sourceFilesRead.add(path);
        }
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
    })));
  }

  /**
   * Scoped-source-audit allow-list gate — autonomy-aware and escalatable.
   *
   * Returns `null` when `call` may proceed to dispatch, or a "denied"
   * `ToolResult` to block it. Re-evaluated on EVERY `execute()` (it reads
   * `this.ctx.autonomyMode` and the grant/denial sets fresh each time), so
   * switching autonomy mid-session takes effect immediately with no executor
   * rebuild.
   *
   * A scoped source audit (role audit/review with a genuinely configured,
   * non-empty `scopePath`) processes attacker-controlled package contents, so
   * by default only the `SCOPED_SOURCE_AUDIT_TOOLS` allow-list may run.
   *
   * IMPORTANT — this gate ONLY lifts that allow-list; it is NOT a master key.
   * The console turn-engine's network scope-on-demand gate, local-filesystem
   * scope gate, and co-pilot per-tool approval gate all run BEFORE
   * `execute()` is reached, and each tool handler's own `scopePath`/`target`
   * guards still apply AFTER dispatch. A YOLO grant or an escalation approval
   * here changes none of those.
   */
  private async _evaluateScopedAuditGate(call: ToolCall): Promise<ToolResult | null> {
    // The gate applies only inside a scoped source audit: role audit/review
    // AND a genuinely configured (non-empty) local scope. Absent either, there
    // is no allow-list restriction to evaluate — proceed. This nonempty-scope
    // requirement is also what stops YOLO from ever granting execution rights
    // when no scope exists.
    const inScopedSourceAudit =
      !!getLocalSourceBoundary() ||
      (
      (this.ctx.role === "audit" || this.ctx.role === "review") &&
      typeof this.ctx.scopePath === "string" &&
      this.ctx.scopePath.length > 0);
    if (!inScopedSourceAudit) return null;

    // Allow-listed tools always run — they are never a candidate for
    // escalation and never consume the escalation callback.
    if (Object.hasOwn(SCOPED_SOURCE_AUDIT_TOOLS, call.name)) return null;

    const denied: ToolResult = {
      success: false,
      output: null,
      error: `Tool "${call.name}" is not available in a scoped source audit`,
    };
    // Neither autonomy nor a later escalation can widen an explicit folder's
    // read-only investigation into shell execution or repair outside the phase.
    if (getLocalSourceBoundary()) return denied;

    // YOLO or CO-PILOT with a configured scope: the allow-list no longer
    // restricts execution. Neither mode has per-action prompts under the
    // current model, so both auto-lift the scoped-audit allow-list inside the
    // configured scope (the expansion is still surfaced via the console's
    // scope/local-scope notify path and the per-tool gates listed above still
    // run). It does not touch the OTHER gates listed above.
    if (this.ctx.autonomyMode === "yolo" || this.ctx.autonomyMode === "copilot") return null;

    // Standard / recon: honour a decision already made this session before
    // prompting again (mirrors the denied-host / denied-path memory pattern in
    // console/turn-engine.ts). Recon keeps prompting here exactly like standard
    // — the console refuses effectful recon tools upstream, so anything that
    // reaches this gate in recon is a genuine allow-list escalation decision.
    if (this._scopedAuditGrants.has(call.name)) return null;
    if (this._scopedAuditDenials.has(call.name)) return denied;

    // No escalation callback wired (every existing non-console caller,
    // including the scan pipeline): behave BYTE-IDENTICALLY to the pre-autonomy
    // hard denial. This is the default-must-not-weaken path.
    const escalate = this.ctx.escalateScopedAudit;
    if (!escalate) return denied;

    const approved = await escalate({
      call,
      reason: `Tool "${call.name}" is outside the scoped source-audit allow-list`,
    });
    if (approved) {
      // Grant is per-tool-name, in-memory, session-scoped — never re-prompted.
      this._scopedAuditGrants.add(call.name);
      return null;
    }
    // Remember the denial so a retry of the same tool does not re-prompt.
    this._scopedAuditDenials.add(call.name);
    return denied;
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
        // Or a tool the model registered THIS session via `self_extend`. Route
        // it through the registry so it is guard-evaluated under its DECLARED
        // capability gate flags (a self-authored tool can never reach capability
        // its declared+approved guards deny).
        const ext = await this._dispatchExtensionTool(call);
        if (ext) return ext;
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

  private rememberCodebase(args: Record<string, unknown>): ToolResult {
    if (!this.ctx.rememberCodebase) {
      return { success: false, output: null, error: "Codebase learning is unavailable in this session" };
    }
    const parsed = rememberCodebaseArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, output: null, error: parsed.error.issues[0]?.message ?? "Invalid codebase note" };
    }
    return { success: true, output: this.ctx.rememberCodebase(parsed.data) };
  }

  /** Validate model input before passing source to the isolated plugin lifecycle. */
  private async selfExtend(args: Record<string, unknown>): Promise<ToolResult> {
    const registry = selfExtensionRegistryOf(this.ctx);
    if (!registry?.isEnabled()) {
      return { success: false, output: null, error: "Model self-extension is disabled for this session." };
    }
    const parsed = validateSelfExtendArgs(args);
    if (!parsed.ok) return { success: false, output: null, error: parsed.error };
    const request = parsed.args;
    if (request.action === "harness_submit" || request.action === "harness_list" ||
      request.action === "harness_rollback" || request.action === "harness_disable") {
      const harness = this.ctx.liveHarness;
      if (!harness) return { success: false, output: null, error: "Live harness services are unavailable in this session." };
      try {
        const snapshot = await harness.control(
          request.action === "harness_submit" ? { action: "submit", generation: request.generation } :
          request.action === "harness_rollback" ? { action: "rollback", generationId: request.generation_id } :
          request.action === "harness_disable" ? { action: "disable" } : { action: "list" },
        );
        return { success: true, output: snapshot };
      } catch (error) {
        return { success: false, output: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const manager = this.ctx.executablePlugins;
    if (!manager) {
      return {
        success: false, output: null,
        error: "Executable plugins require a configured Docker or smolvm backend; source is never run on the host.",
      };
    }
    await manager.ready;
    const context = this._executableContext("self_extend");
    if (request.action === "list") {
      return { success: true, output: { plugins: manager.list(), evolutionProfiles: Object.keys(this.ctx.executableEvolutionProfiles ?? {}) } };
    }
    if (request.action === "rollback") {
      return manager.rollback(request.plugin_id, request.version_id, context);
    }
    if (request.action === "evolve") {
      if (!this.ctx.evolveExecutablePlugin) {
        return { success: false, output: null, error: "No controller-owned evolution profiles are configured." };
      }
      return this.ctx.evolveExecutablePlugin(request.plugin_id, request.profile, context.signal);
    }
    return manager.submit(request, context);
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

  private _executableContext(toolName: string) {
    const bound = this.ctx.pluginExecutionContext?.() ?? {};
    const execution = this._executionContext.getStore();
    return {
      ...bound,
      signal: execution?.signal ?? bound.signal,
      ...(bound.invokeTool ? { invokeTool: (...args: Parameters<NonNullable<typeof bound.invokeTool>>) =>
        this._executionContext.run(execution ?? {}, () => bound.invokeTool!(...args)),
      } : {}),
      onEvent: (event: unknown) => {
        this._executionContext.run(execution ?? {}, () => {
          this.persistToolArtifact(toolName, { executable: event });
        });
        bound.onEvent?.(event);
      },
    };
  }

  private async _dispatchExtensionTool(call: ToolCall): Promise<ToolResult | null> {
    const registry = selfExtensionRegistryOf(this.ctx);
    if (!registry || !registry.isEnabled()) return null;
    const tool = registry.tool(call.name);
    if (!tool) return null;

    const gate = tool.gateFlags;
    const guardCtx: GuardContext = {
      toolName: tool.name,
      networkCapable: gate.networkCapable,
      localScope: gate.localScope,
      readOnly: gate.readOnly,
      autonomyMode: this.ctx.autonomyMode ?? DEFAULT_AUTONOMY_MODE,
      hasScope:
        !!this.ctx.scope ||
        (typeof this.ctx.scopePath === "string" && this.ctx.scopePath.length > 0),
      approvalAvailable:
        typeof this.ctx.escalateScopedAudit === "function" ||
        typeof this.ctx.askOperator === "function",
      // Resolved from a validated manifest — a known source, not danger-by-omission.
      capabilitiesResolved: true,
    };

    const verdict = registry.evaluate(guardCtx);
    if (!verdict.allowed) {
      return {
        success: false,
        output: null,
        error: `Tool "${call.name}" was denied by the guard floor: ${verdict.reasons.join("; ")}`,
      };
    }

    const manager = this.ctx.executablePlugins;
    if (!manager) {
      return { success: false, output: null, error: `Executable backend is unavailable for "${call.name}".` };
    }
    return manager.execute(call.name, call.arguments ?? {}, this._executableContext(call.name));
  }

  /** Exact fixture matching keeps model-supplied ownership claims out of verification. */
  async verifyAccessControlFinding(finding: Finding, target: string): Promise<OracleResult | undefined> {
    const request = parseRequest(finding.evidence?.request ?? "", target);
    if (request.method !== "GET") return undefined;
    const fixture = this.ctx.accessControlFixtures?.find(f => new URL(f.url).href === new URL(request.url).href);
    if (!fixture) return undefined;
    const result = await this.accessControlProbe({
      url: fixture.url, baseline_identity: fixture.ownerIdentity,
      compare_identities: fixture.comparisonIdentities,
      ownership_marker: fixture.ownershipMarker, expect_denied: true,
    });
    if (!result.success) return { verified: false, inconclusive: true, confidence: 0, evidence: "", reason: "ownership replay failed: " + result.error };
    const output = result.output as { broken_count: number; verdict: string };
    return {
      verified: output.broken_count > 0,
      inconclusive: output.verdict === "inconclusive",
      confidence: output.broken_count > 0 ? 1 : 0,
      evidence: JSON.stringify(result.output),
      reason: output.broken_count > 0 ? "" : output.verdict === "inconclusive" ? "ownership replay unavailable or inconclusive" : "restricted owner marker was not exposed to comparison identities",
    };
  }

  /** Category validators use the same transport and session as HTTP tools. */
  async fetchOracleRequest(rawUrl: string, init: RequestInit): Promise<Response> {
    const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
    // Recorded auth is stale/untrusted; restore it from the opaque identity context.
    const headers = new Headers(init.headers);
    const authNames = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token"]);
    for (const identity of this.resolveProbeIdentities()) {
      for (const name of Object.keys(identity.headers())) authNames.add(name.toLowerCase());
    }
    for (const name of authNames) headers.delete(name);
    for (const [name, value] of Object.entries(this.activeAuthHeaders(url))) headers.set(name, value);
    const request = applyAttribution(url, { ...init, headers, redirect: "manual" }, this.ctx.attribution, this.ctx.scope)!;
    if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
    const res = await this.fetchTarget(url, request);
    if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
    this.captureActiveCookies(res, url);
    return res;
  }

  private fetchTarget(
    url: string,
    init: RequestInit,
    beforeRequest?: (url: string) => void | Promise<void>,
  ): Promise<Response> {
    const execution = this._executionContext.getStore();
    const signal = execution?.signal && init.signal
      ? AbortSignal.any([execution.signal, init.signal])
      : execution?.signal ?? init.signal;
    return withScopeEnforcement(this.ctx.scopeEnforcement ?? getScopeEnforcementState(), () => fetchScoped(url, { ...init, signal }, {
      baseUrl: this.ctx.target,
      scope: this.ctx.publicNetwork ? this.ctx.publicNetwork.scope : this.ctx.scope,
      allowPublicNetwork: this.ctx.publicNetwork !== undefined,
      deniedHosts: this.ctx.publicNetwork?.deniedHosts,
      beforeRequest,
      validateUrl: candidate => {
        execution?.assertAuthority?.();
        validateTargetUrl(this.ctx.target, candidate, this.ctx.scope, undefined, this.ctx.publicNetwork);
        if (!this.usesTargetIdentity(candidate)) {
          const secrets = [
            ...authSecretValues(this.ctx.authConfig),
            ...this.resolveProbeIdentities().flatMap(identity => sensitiveHeaderValues(identity.headers())),
          ];
          for (const value of new Headers(init.headers).values()) {
            if (secrets.some(secret => secret.length > 0 && value.includes(secret))) {
              throw new Error("Saved target credentials cannot be forwarded to another origin.");
            }
          }
        }
        const path = this.ctx.enforcement?.pathPolicy.enforce(candidate);
        if (path && !path.allowed) {
          this.ctx.enforcement?.noteOutOfScopeBlocked();
          throw new Error(`Scope violation blocked: ${path.reason}`);
        }
      },
    }));
  }

  private async httpRequest(args: Record<string, unknown>): Promise<ToolResult> {
    const url = validateTargetUrl(this.ctx.target, args.url as string, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
    const method = (args.method as string) ?? "POST";
    const body = args.body as string | undefined;
    const authHeaders = this.activeAuthHeaders(url);
    const headers = { ...authHeaders, ...(args.headers as Record<string, string>) ?? {} };

    // One in-scope HTTP round-trip for a given (possibly evasion-mutated)
    // request shape. Rate-limit (#214), attribution (#216), and 429-honoring
    // all live here so the baseline call AND every adaptive-evasion variant
    // (#568) pace identically and stay in-scope. Returns the response, the
    // body text, and the headers actually sent.
    const sendHttp = async (
      parts: HttpRequestParts,
    ): Promise<{ res: Response; body: string; sentHeaders: Record<string, string> }> => {
      // Re-validate the (possibly evasion-mutated) URL immediately before the
      // fetch — same-origin + scope + private-network allowlist, identical to
      // the pre-flight `validateTargetUrl` at the top. Evasion transforms only
      // rewrite query values / body / header casing, never the host or path,
      // so this always passes for legitimate variants; it is defense-in-depth
      // guaranteeing a mutated payload can never escape the validated in-scope
      // origin (and feeds an allowlisted URL into `fetch`, not a raw param).
      // `enforcement` is omitted so this re-check does NOT double-count the
      // request — the baseline was already tallied by the pre-flight call.
      const safeUrl = validateTargetUrl(this.ctx.target, parts.url, this.ctx.scope, undefined, this.ctx.publicNetwork);
      // Acquire token BEFORE the network call; park the host bucket on 429
      // via `noteResponse` AFTER the response.
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(safeUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const fetchInit = applyAttribution(
          safeUrl,
          {
            method: parts.method,
            headers: { "Content-Type": "application/json", ...parts.headers },
            body: parts.body ?? undefined,
            signal: this._executionContext.getStore()?.signal
              ? AbortSignal.any([controller.signal, this._executionContext.getStore()!.signal!])
              : controller.signal,
            redirect: "manual",
          },
          this.usesTargetIdentity(safeUrl) ? this.ctx.attribution : undefined,
          this.ctx.scope,
        )!;
        // js/no-ssrf FP: `safeUrl` is the return of validateTargetUrl() just
        // above (same-origin + scope + private-IP/localhost block + http_audit
        // path allowlist), re-validated for the baseline AND every evasion
        // variant before egress. Fetching the in-scope authorized target is
        // intended 0 behaviour.
        // foxguard:ignore
        const res = await this.fetchTarget(safeUrl, fetchInit);
        if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(safeUrl, res);
        // Persist session state (0#564): capture Set-Cookie for the active
        // identity. No-op when no SessionEngine is wired. Runs for the baseline
        // AND every evasion variant so session cookies stay current.
        this.captureActiveCookies(res, safeUrl);
        const text = await res.text();
        return { res, body: text, sentHeaders: fetchInit.headers as Record<string, string> };
      } finally {
        clearTimeout(timer);
      }
    };

    const baseParts: HttpRequestParts = { url, method, headers, body };
    const first = await sendHttp(baseParts);
    let chosen = first;

    // ── WAF detection + adaptive evasion (0#568) ──
    // Passive fingerprinting is cheap and ALWAYS runs, so a WAF block is
    // reported as such instead of being mistaken for "not vulnerable" (the
    // silent-false-negative gap). When a block is detected AND a WafDetector
    // is wired (authorized engagement — scope/enforcement configured), we walk
    // the evasion ladder through the SAME rate-limited / in-scope `sendHttp`
    // path, recording every attempt as evidence.
    //
    // The ladder is opt-out: an engagement hardening profile (or the standalone
    // `--no-waf-evasion` / `ZERO_WAF_EVASION=0`) turns it off, because
    // auto-escalating a WAF block into encoded/mutated retries is what turns a
    // routine block into a SOC incident. Detection still runs — we report the
    // block, we just don't try to beat it. See `scope/engagement-profile.ts`.
    let wafInfo: Record<string, unknown> | undefined;
    const verdict = classifyResponse({ status: first.res.status, headers: first.res.headers, body: first.body });
    if (verdict.blocked) {
      const evasionLadderEnabled = isWafEvasionLadderEnabled(this.ctx.engagement);
      this.ctx.wafDetector?.recordBlock(url, verdict);
      wafInfo = {
        detected: true,
        blocked: true,
        vendor: verdict.fingerprint?.vendor ?? "generic",
        label: verdict.fingerprint?.label ?? "unfingerprinted WAF",
        confidence: verdict.fingerprint?.confidence ?? null,
        reason: verdict.reason,
        authorized_engagement: true,
        ...(evasionLadderEnabled
          ? {}
          : { evasion: { enabled: false, reason: "evasion ladder disabled by engagement posture" } }),
      };

      if (this.ctx.wafDetector && evasionLadderEnabled) {
        // Capture the underlying send for the variant that ultimately runs, so
        // a bypassing response (with its real sent-headers) becomes the result.
        let lastSend: { res: Response; body: string; sentHeaders: Record<string, string> } | null = null;
        const campaign = await runEvasionCampaign(
          baseParts,
          async (parts): Promise<WafResponseLike> => {
            const r = await sendHttp(parts);
            lastSend = r;
            return { status: r.res.status, headers: r.res.headers, body: r.body };
          },
          { jitterBaseMs: 250 },
        );
        this.ctx.wafDetector.recordEvasion(url, verdict, campaign);
        wafInfo.evasion = {
          attempts: campaign.attempts,
          bypassed: campaign.bypassed,
          bypass_strategy: campaign.bypassStrategy,
        };
        // Persist the evasion audit trail as a first-class artifact so the
        // operator's report shows exactly what variants were sent.
        this.persistToolArtifact("waf_evasion", {
          url,
          vendor: verdict.fingerprint?.vendor ?? "generic",
          reason: verdict.reason,
          authorized_engagement: true,
          attempts: campaign.attempts,
          bypassed: campaign.bypassed,
          bypass_strategy: campaign.bypassStrategy,
        });
        if (campaign.bypassed && lastSend) {
          chosen = lastSend;
        }
      }
    } else if (verdict.fingerprint) {
      // WAF present but this response looks legitimate — note it so the agent
      // knows it is operating behind an edge filter.
      wafInfo = {
        detected: true,
        blocked: false,
        vendor: verdict.fingerprint.vendor,
        label: verdict.fingerprint.label,
        confidence: verdict.fingerprint.confidence,
        reason: verdict.reason,
        authorized_engagement: true,
      };
    }

    const sensitiveValues = [
      ...authSecretValues(this.ctx.authConfig),
      ...Object.values(authHeaders),
      ...sensitiveHeaderValues(chosen.sentHeaders),
    ];
    const responseHeaders = Object.fromEntries(chosen.res.headers.entries()) as Record<string, string>;
    const safeResponseBody = redactAuthValues(chosen.body, sensitiveValues);
    const safeRequestBody = body ? redactAuthValues(body, sensitiveValues) : undefined;
    const safeSentHeaders = redactAuthHeaders(chosen.sentHeaders, sensitiveValues);
    const output: Record<string, unknown> = {
      status: chosen.res.status,
      headers: redactAuthHeaders(responseHeaders, sensitiveValues),
      body: safeResponseBody.slice(0, 10_000), // cap response size
    };
    if (wafInfo) output.waf = wafInfo;

    // Persist only redacted target authentication material. The model receives
    // the same safe response above, so a target cannot reflect an operator's
    // credentials into provider context or durable artifacts.
    this.persistToolArtifact("http_request", {
      request: {
        url,
        method,
        headers: safeSentHeaders,
        body: safeRequestBody?.slice(0, 2_000),
      },
      response: { status: chosen.res.status, body: safeResponseBody.slice(0, 5_000) },
      ...(wafInfo ? { waf: wafInfo } : {}),
    });

    return { success: true, output };
  }

  private async sendPromptTool(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = args.prompt as string;

    try {
      const res = await sendPrompt(this.ctx.target, prompt, {
        timeout: 30_000,
        baseUrl: this.ctx.target,
        scope: this.ctx.scope,
        signal: this._executionContext.getStore()?.signal,
      });
      const text = extractResponseText(res.body);

      // Persist as run artifact
      this.persistToolArtifact("send_prompt", {
        request: { prompt: prompt.slice(0, 2_000), target: this.ctx.target },
        response: { text: text.slice(0, 5_000), raw: JSON.stringify(res.body).slice(0, 5_000) },
      });

      return { success: true, output: { response: text, raw: res.body } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
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


  // ── Crawl helpers ──

  private parseHtml(html: string, baseUrl: string): {
    links: string[];
    forms: Array<{ action: string; method: string; inputs: Array<{ name: string; type: string }> }>;
    scripts: string[];
  } {
    const base = new URL(baseUrl);
    const links: string[] = [];
    const scripts: string[] = [];
    const forms: Array<{ action: string; method: string; inputs: Array<{ name: string; type: string }> }> = [];

    // Extract links
    const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null) {
      try {
        const resolved = new URL(m[1], baseUrl);
        if (resolved.hostname === base.hostname) {
          links.push(resolved.toString());
        }
      } catch { /* skip malformed URLs */ }
    }

    // Extract script sources
    const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((m = scriptRe.exec(html)) !== null) {
      try {
        scripts.push(new URL(m[1], baseUrl).toString());
      } catch { /* skip */ }
    }

    // Extract forms with their inputs
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    while ((m = formRe.exec(html)) !== null) {
      const attrs = m[1];
      const body = m[2];

      const actionMatch = /action\s*=\s*["']([^"']*)["']/i.exec(attrs);
      const methodMatch = /method\s*=\s*["']([^"']*)["']/i.exec(attrs);

      let action = baseUrl;
      if (actionMatch) {
        try { action = new URL(actionMatch[1], baseUrl).toString(); } catch { /* keep default */ }
      }
      const method = (methodMatch?.[1] ?? "GET").toUpperCase();

      const inputs: Array<{ name: string; type: string }> = [];
      const inputRe = /<(?:input|textarea|select)\b([^>]*)>/gi;
      let im: RegExpExecArray | null;
      while ((im = inputRe.exec(body)) !== null) {
        const iattrs = im[1];
        const nameMatch = /name\s*=\s*["']([^"']*)["']/i.exec(iattrs);
        const typeMatch = /type\s*=\s*["']([^"']*)["']/i.exec(iattrs);
        if (nameMatch) {
          inputs.push({ name: nameMatch[1], type: typeMatch?.[1] ?? "text" });
        }
      }

      forms.push({ action, method, inputs });
    }

    return { links: [...new Set(links)], forms, scripts: [...new Set(scripts)] };
  }

  private parseCookies(headers: Headers): string[] {
    const cookies: string[] = [];
    headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        const name = value.split("=", 1)[0]?.trim();
        cookies.push(name ? `${name}=<REDACTED-AUTH>` : "<REDACTED-SET-COOKIE>");
      }
    });
    return cookies;
  }

  private async crawl(args: Record<string, unknown>): Promise<ToolResult> {
    const startUrl = args.url as string;
    const maxDepth = Math.min(Math.max((args.depth as number) ?? 1, 1), 3);

    // Validate the URL scheme and resolve against target origin for relative URLs
    let resolved: URL;
    try {
      resolved = new URL(validateTargetUrl(this.ctx.target, startUrl, this.ctx.scope, undefined, this.ctx.publicNetwork));
    } catch {
      return { success: false, output: null, error: `Invalid URL: ${startUrl}` };
    }

    if (!["http:", "https:"].includes(resolved.protocol)) {
      return { success: false, output: null, error: `Unsupported protocol: ${resolved.protocol}` };
    }

    const crawlScope = this.ctx.publicNetwork ? this.ctx.publicNetwork.scope : this.ctx.scope;
    if (crawlScope) {
      const verdict = crawlScope.enforce(resolved.toString())
      if (!verdict.allowed) {
        this.ctx.enforcement?.noteOutOfScopeBlocked();
        return { success: false, output: null, error: `crawl refused: ${verdict.reason}` };
      }
    }
    // http_audit path allowlist on the crawl seed URL (FROZEN CONTRACT).
    if (this.ctx.enforcement) {
      const pathVerdict = this.ctx.enforcement.pathPolicy.enforce(resolved.toString());
      if (!pathVerdict.allowed) {
        this.ctx.enforcement.noteOutOfScopeBlocked();
        return { success: false, output: null, error: `crawl refused: ${pathVerdict.reason}` };
      }
    }

    const originHost = resolved.hostname;
    const visited = new Set<string>();
    const results: Array<{
      url: string;
      status: number;
      links: string[];
      forms: Array<{ action: string; method: string; inputs: Array<{ name: string; type: string }> }>;
      scripts: string[];
      cookies: string[];
      textContent?: string;
    }> = [];

    const queue: Array<{ url: string; depth: number }> = [{ url: resolved.toString(), depth: 1 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      const normalizedUrl = item.url.split("#")[0]; // strip fragment
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      // Same-origin check
      let parsed: URL;
      try {
        parsed = new URL(normalizedUrl);
      } catch { continue; }
      if (parsed.hostname !== originHost) continue;

      // Scope enforcement (0#215). Same-origin already restricts the
      // crawl to one host, but if that host is out of scope we still must
      // refuse — operators sometimes scan dev.example.com against a scope
      // that only allows prod.example.com.
      if (crawlScope) {
        const verdict = crawlScope.enforce(normalizedUrl)
        if (!verdict.allowed) {
          this.ctx.enforcement?.noteOutOfScopeBlocked();
          continue;
        }
      }
      // http_audit path allowlist per crawled page (FROZEN CONTRACT). Each
      // page about to be fetched counts as one in-scope or out-of-scope
      // request for the enforcement_summary.
      if (this.ctx.enforcement) {
        const pathVerdict = this.ctx.enforcement.pathPolicy.enforce(normalizedUrl);
        if (!pathVerdict.allowed) {
          this.ctx.enforcement.noteOutOfScopeBlocked();
          continue;
        }
        this.ctx.enforcement.noteInScope();
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        const crawlAuthHeaders = this.activeAuthHeaders(normalizedUrl);
        // Attribution-header injection (0#216). Crawler hits every
        // discovered link, so this is the highest-volume fetch site —
        // attribution here is what most defenders will see in their logs.
        // The default `0-crawler/1.0` UA is replaced with the
        // engagement-tagged UA inside applyAttribution when configured.
        //
        // Manual redirect handling (0#238). `redirect: "manual"` and
        // a per-hop scope+origin check below stop attribution headers
        // from leaking to a 3xx target on a different host. Each Location
        // is validated BEFORE the next fetch, so the next request only
        // ships if the destination is still in-scope and same-origin.
        const buildCrawlInit = (urlForAttribution: string): RequestInit => {
          const init = applyAttribution(
            urlForAttribution,
            {
              method: "GET",
              signal: controller.signal,
              redirect: "manual",
              headers: { "User-Agent": "0-crawler/1.0", ...this.activeAuthHeaders(urlForAttribution) },
            },
            this.usesTargetIdentity(urlForAttribution) ? this.ctx.attribution : undefined,
            crawlScope,
          )!;
          // crawl explicitly wants the engagement-tagged UA (not the
          // generic crawler one) when attribution is configured. We
          // overwrite here because the attribution path keeps caller UA
          // for principle-of-least-surprise in other call sites.
          if (this.usesTargetIdentity(urlForAttribution) && this.ctx.attribution?.userAgentToken) {
            (init.headers as Record<string, string>)["User-Agent"] =
              formatUserAgent(this.ctx.attribution.userAgentToken);
          }
          return init;
        };

        const MAX_REDIRECTS = 5;
        let currentUrl = normalizedUrl;
        let redirectCount = 0;
        let res: Response;
        let redirectBailReason: string | null = null;
        // Walk the redirect chain ourselves; each hop is scope+origin
        // validated before we re-issue with attribution attached.
        while (true) {
          if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(currentUrl);
          // js/no-ssrf FP: `currentUrl` is the validated crawl seed (or a
          // same-origin, in-scope redirect target re-validated each hop below);
          // cross-origin / out-of-scope / private-IP hops are refused. Crawling
          // the in-scope target is intended 0 behaviour.
          // foxguard:ignore
          res = await this.fetchTarget(currentUrl, buildCrawlInit(currentUrl));
          if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(currentUrl, res);
          // Capture cookies on every hop so authenticated crawls persist
          // session state across pages (0#564).
          this.captureActiveCookies(res, currentUrl);

          if (res.status < 300 || res.status >= 400) break;
          const location = res.headers.get("location");
          if (!location) break; // 30x without Location → treat as terminal

          if (++redirectCount > MAX_REDIRECTS) {
            redirectBailReason = "too many redirects";
            break;
          }

          let next: URL;
          try {
            next = new URL(location, currentUrl);
          } catch {
            redirectBailReason = "malformed redirect target";
            break;
          }
          if (!["http:", "https:"].includes(next.protocol)) {
            redirectBailReason = "non-http redirect target";
            break;
          }
          if (isScopeEnforcementEnabled() && !this.ctx.publicNetwork && next.hostname !== originHost) {
            redirectBailReason = "cross-origin redirect target";
            break;
          }
          if (crawlScope) {
            const verdict = crawlScope.enforce(next.toString())
            if (!verdict.allowed) {
              redirectBailReason = `out-of-scope redirect target: ${verdict.reason}`;
              break;
            }
          }
          currentUrl = next.toString();
        }

        clearTimeout(timer);

        if (redirectBailReason) {
          // Refused mid-chain — record the page as visited but don't
          // read the body; the response in hand is the final 30x and
          // we never sent attribution to the off-scope/cross-origin
          // destination.
          results.push({
            url: normalizedUrl,
            status: res.status,
            links: [],
            forms: [],
            scripts: [],
            cookies: this.parseCookies(res.headers),
          });
          (results[results.length - 1] as Record<string, unknown>).error = redirectBailReason;
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("html") && !contentType.includes("text")) {
          results.push({
            url: normalizedUrl,
            status: res.status,
            links: [],
            forms: [],
            scripts: [],
            cookies: this.parseCookies(res.headers),
          });
          continue;
        }

        const html = await res.text();
        const { links, forms, scripts } = this.parseHtml(html.slice(0, 500_000), normalizedUrl);
        const cookies = this.parseCookies(res.headers);
        const responseHeaders = Object.fromEntries(res.headers.entries()) as Record<string, string>;
        const sensitiveValues = [
          ...authSecretValues(this.ctx.authConfig),
          ...Object.values(crawlAuthHeaders),
          ...sensitiveHeaderValues(responseHeaders),
        ];

        // Extract visible text content so the agent can inspect target data
        // without receiving reflected authentication material.
        const textContent = redactAuthValues(
          html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000),
          sensitiveValues,
        );

        results.push({ url: normalizedUrl, status: res.status, links, forms, scripts, cookies, textContent });

        // Enqueue discovered links for deeper crawling
        if (item.depth < maxDepth) {
          for (const link of links) {
            queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          url: normalizedUrl,
          status: 0,
          links: [],
          forms: [],
          scripts: [],
          cookies: [],
        });
        // Include the error inline so the agent sees partial results
        (results[results.length - 1] as Record<string, unknown>).error = msg;
      }
    }

    this.persistToolArtifact("crawl", {
      startUrl: resolved.toString(),
      depth: maxDepth,
      pagesVisited: results.length,
    });

    return {
      success: true,
      output: {
        pages: results,
        totalPages: results.length,
        totalLinks: results.reduce((n, p) => n + p.links.length, 0),
        totalForms: results.reduce((n, p) => n + p.forms.length, 0),
      },
    };
  }

  private async submitForm(args: Record<string, unknown>): Promise<ToolResult> {
    const rawUrl = args.url as string;
    const method = ((args.method as string) ?? "POST").toUpperCase();
    const fields = (args.fields as Record<string, string>) ?? {};
    const formAuthHeaders = this.activeAuthHeaders(rawUrl);
    const extraHeaders = { ...formAuthHeaders, ...(args.headers as Record<string, string>) ?? {} };

    // Validate URL against same-origin policy (same as http_request)
    let resolved: URL;
    try {
      const validated = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      resolved = new URL(validated);
    } catch (err) {
      return { success: false, output: null, error: err instanceof Error ? err.message : `Invalid URL: ${rawUrl}` };
    }

    // Encode fields as application/x-www-form-urlencoded
    const encoded = new URLSearchParams(fields).toString();

    let fetchUrl = resolved.toString();
    const fetchOpts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
      redirect: "manual",
    };

    if (method === "GET") {
      // Append fields to query string
      const withParams = new URL(fetchUrl);
      for (const [k, v] of Object.entries(fields)) {
        withParams.searchParams.set(k, v);
      }
      fetchUrl = withParams.toString();
    } else {
      fetchOpts.body = encoded;
    }

    const controller = new AbortController();
    fetchOpts.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      // Attribution-header injection (0#216). submit_form is one
      // of the noisier fetch sites in pen-test contexts (login attempts,
      // CSRF probes), so attribution here is critical for deconfliction.
      const submitInit = applyAttribution(fetchUrl, fetchOpts, this.usesTargetIdentity(fetchUrl) ? this.ctx.attribution : undefined, this.ctx.scope)!;
      // #214: rate-limit the form submission before dispatching.
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(fetchUrl);
      // js/no-ssrf FP: `fetchUrl` derives from validateTargetUrl() above
      // (same-origin + scope + private-IP/localhost block). Submitting forms to
      // the in-scope target is intended 0 behaviour.
      // foxguard:ignore
      const res = await this.fetchTarget(fetchUrl, submitInit);
      if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(fetchUrl, res);
      // Capture the session cookie a login form sets, so the very next
      // request is authenticated without manual `curl -c/-b` jars (0#564).
      this.captureActiveCookies(res, fetchUrl);
      clearTimeout(timer);
      const text = await res.text();
      const sentHeaders = submitInit.headers as Record<string, string>;
      const responseHeaders = Object.fromEntries(res.headers.entries()) as Record<string, string>;
      const sensitiveValues = [
        ...authSecretValues(this.ctx.authConfig),
        ...Object.values(formAuthHeaders),
        ...sensitiveHeaderValues(sentHeaders),
        ...sensitiveHeaderValues(responseHeaders),
      ];
      const safeBody = redactAuthValues(text, sensitiveValues);
      const output = {
        status: res.status,
        headers: redactAuthHeaders(responseHeaders, sensitiveValues),
        body: safeBody.slice(0, 10_000),
      };

      this.persistToolArtifact("submit_form", {
        request: { url: fetchUrl, method, headers: redactAuthHeaders(sentHeaders, sensitiveValues), fields },
        response: { status: output.status, body: output.body.slice(0, 5_000) },
      });

      return { success: true, output };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  // ── Access-control probe (0#564) ──

  /**
   * Resolve the principals this probe can act as. Prefers the live
   * `SessionEngine` (so per-identity cookie jars + re-auth apply); falls back
   * to the resolved identity list / legacy `authConfig` with static auth only.
   */
  private resolveProbeIdentities(): ProbePrincipal[] {
    const session = this.ctx.session;
    if (session) {
      return session.all.map((s) => ({
        label: s.label,
        role: s.role,
        headers: () => session.headersFor(s.label, this.ctx.target),
        capture: (res: Response) => {
          session.capture(s.label, res.headers, this.ctx.target);
          session.handleAuthStatus(s.label, res.status, this.ctx.target);
        },
      }));
    }
    const identities = resolveIdentities({ auth: this.ctx.authConfig, identities: this.ctx.identities });
    return identities.map((idn: NamedIdentity) => ({
      label: idn.label,
      role: idn.role,
      headers: () => buildAuthHeaders(idn.auth),
      capture: () => {},
    }));
  }

  /** Issue one request to the target as a specific principal. */
  private async fetchAs(
    principal: ProbePrincipal,
    rawUrl: string,
    method: string,
    body: string | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<ProbeResponse> {
    // Same-origin / scope / path-allowlist enforcement as every other tool.
    const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
    const principalHeaders = principal.headers();
    const authNames = new Set(["authorization", "cookie", "proxy-authorization", "host", "x-api-key", "x-auth-token"]);
    const allHeaders = this.resolveProbeIdentities().flatMap(p => Object.entries(p.headers()));
    for (const [name] of allHeaders) authNames.add(name.toLowerCase());
    if (Object.keys(extraHeaders).some(name => authNames.has(name.toLowerCase()))) {
      throw new Error("Replay headers cannot override identity credentials or Host");
    }
    const headers = { "Content-Type": "application/json", ...extraHeaders, ...principalHeaders };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const fetchInit = applyAttribution(
        url,
        { method, headers, body: body ?? undefined, signal: controller.signal, redirect: "manual" },
        this.ctx.attribution,
        this.ctx.scope,
      )!;
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
      // js/no-ssrf FP: `url` is the operator-specified probe target validated by
      // validateTargetUrl() above (same-origin + scope + private-IP/localhost
      // block + path allowlist). The access-control probe replays requests to
      // the in-scope target as different identities — intended behaviour.
      // foxguard:ignore
      const res = await this.fetchTarget(url, fetchInit);
      if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
      principal.capture(res);
      const text = await res.text();
      const safeText = redactAuthValues(text, allHeaders.flatMap(([name, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, ""), ...(name.toLowerCase() === "cookie" ? value.split(";").map(pair => pair.slice(pair.indexOf("=") + 1).trim()) : [])]));
      return {
        identity: principal.label,
        role: principal.role,
        url,
        method,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: safeText.slice(0, 10_000),
        redacted: safeText !== text,
        ...(text.length > 10_000 ? { truncated: true } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private static readonly accessProbeSchema = z.object({
    url: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    body: z.string().optional(), headers: z.record(z.string(), z.string()).optional(),
    baseline_identity: z.string().min(1).optional(),
    compare_identities: z.array(z.string().min(1)).min(1).max(16).optional(),
    expect_denied: z.boolean().optional(),
    ownership_marker: z.string().min(16).max(500).optional(),
  }).strict();

  private async accessControlProbe(args: Record<string, unknown>): Promise<ToolResult> {
    const validated = ToolExecutor.accessProbeSchema.safeParse(args);
    if (!validated.success) return { success: false, output: null, error: "Invalid access-control probe arguments" };
    args = validated.data;
    const rawUrl = args.url as string;
    if (!rawUrl) return { success: false, output: null, error: "url is required" };
    const method = ((args.method as string) ?? "GET").toUpperCase();
    const body = args.body as string | undefined;
    const extraHeaders = (args.headers as Record<string, string>) ?? {};
    const expectDenied = args.expect_denied === true;
    const ownershipMarker = args.ownership_marker;

    const principals = this.resolveProbeIdentities();
    if (principals.length < 2) {
      return {
        success: false,
        output: null,
        error:
          `access_control_probe needs at least 2 identities — configure scan \`identities\` ` +
          `(label + role + auth) for the principals you want to diff. Currently available: ${principals.length}.`,
      };
    }

    const baselineLabel = (args.baseline_identity as string) ?? this.ctx.session?.activeLabel ?? principals[0].label;
    const baseline = principals.find((p) => p.label === baselineLabel);
    if (!baseline) {
      return {
        success: false,
        output: null,
        error: `unknown baseline_identity "${baselineLabel}"; known identities: ${principals.map((p) => p.label).join(", ")}`,
      };
    }

    let compareLabels: string[];
    if (Array.isArray(args.compare_identities) && (args.compare_identities as unknown[]).length > 0) {
      compareLabels = (args.compare_identities as unknown[]).map(String);
    } else {
      compareLabels = principals.filter((p) => p.label !== baselineLabel).map((p) => p.label);
    }

    if (compareLabels.some(label => label === baselineLabel)) {
      return { success: false, output: null, error: "Comparison identity must differ from baseline identity" };
    }
    const authFingerprint = (p: ProbePrincipal) => JSON.stringify(Object.entries(p.headers()).map(([k, v]) => [k.toLowerCase(), v]).sort());
    if (compareLabels.some(label => {
      const p = principals.find(p => p.label === label);
      return p && authFingerprint(p) === authFingerprint(baseline);
    })) {
      return { success: false, output: null, error: "Comparison identities must have distinct authentication" };
    }

    // Authorized baseline request.
    let baselineResp: ProbeResponse;
    try {
      baselineResp = await this.fetchAs(baseline, rawUrl, method, body, extraHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `baseline request failed: ${msg}` };
    }

    const comparisons: Record<string, unknown>[] = [];
    for (const label of compareLabels) {
      const principal = principals.find((p) => p.label === label);
      if (!principal) {
        comparisons.push({ identity: label, error: `unknown identity "${label}"` });
        continue;
      }
      let resp: ProbeResponse;
      try {
        resp = await this.fetchAs(principal, rawUrl, method, body, extraHeaders);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        comparisons.push({ identity: label, role: principal.role, error: msg });
        continue;
      }
      const diff = diffAccessResponses(baselineResp, resp, {
        baselineRole: baseline.role,
        comparisonRole: principal.role,
        expectDenied,
        ownershipMarker: typeof ownershipMarker === "string" ? ownershipMarker : undefined,
      });
      comparisons.push({
        identity: label,
        role: principal.role,
        status: resp.status,
        truncated: resp.truncated ?? false,
        response_digest: "sha256:" + createHash("sha256").update(resp.body).digest("hex"),
        owner_marker_observed: typeof ownershipMarker === "string" && resp.body.includes(ownershipMarker),
        ...diff,
        evidence: probeEvidence(resp),
      });
    }

    const broken = comparisons.filter((c) => c.broken === true);
    const uncertain = comparisons.some(c => c.error || c.verdict === "inconclusive" || c.verdict === "unverified_access_candidate");
    const output = {
      url: baselineResp.url,
      method,
      baseline: {
        identity: baseline.label,
        role: baseline.role,
        status: baselineResp.status,
        evidence: probeEvidence(baselineResp),
      },
      comparisons,
      broken_count: broken.length,
      verdict: broken.length > 0 ? "broken_access_control" : uncertain ? "inconclusive" : "no_break_detected",
      summary:
        broken.length > 0
          ? `Authorization boundary broken: ${broken
              .map((b) => `${b.identity} (${b.verdict})`)
              .join(", ")} reached ${baseline.label}'s resource at ${baselineResp.url}. ` +
            `Save a finding with the A-vs-B evidence below.`
          : uncertain ? `Access-control result is inconclusive at ${baselineResp.url}; review the comparison evidence.`
          : `No access-control break reproduced at ${baselineResp.url}.`,
    };

    // Only the operator-owned fixture can establish restricted ownership for
    // a public milestone. Model-supplied expect_denied/markers are insufficient.
    const fixture = method === "GET" && body === undefined && Object.keys(extraHeaders).length === 0
      ? this.ctx.accessControlFixtures?.find(f => {
        try { return new URL(f.url).href === baselineResp.url && f.ownerIdentity === baseline.label
          && f.ownershipMarker === ownershipMarker && expectDenied; } catch { return false; }
      }) : undefined;
    const qualified = fixture ? comparisons.filter(c => fixture.comparisonIdentities.includes(String(c.identity))) : [];
    const markerObserved = typeof ownershipMarker === "string" && baselineResp.body.includes(ownershipMarker);
    const confirmedRead = !baselineResp.truncated && markerObserved && qualified.some(c => c.broken === true && c.truncated === false);
    const blockedRead = !baselineResp.truncated && is2xx(baselineResp.status) && markerObserved
      && qualified.length > 0 && fixture!.comparisonIdentities.every(identity => qualified.some(c => c.identity === identity))
      && qualified.every(c => c.verdict === "properly_denied" && c.truncated === false);
    this.persistToolArtifact("access_control_probe", {
      url: baselineResp.url,
      method,
      baseline: baseline.label,
      compared: compareLabels,
      broken_count: broken.length,
      ...(confirmedRead || blockedRead ? { access_proof: {
        schema: "0.access-proof/v1", authority: "operator-fixture", access_class: "unauthorized-read",
        status: confirmedRead ? "confirmed" : "blocked", baseline_status: baselineResp.status,
        owner_marker_observed: true, comparison_marker_observed: confirmedRead,
        cleanup: "not-required",
        baseline_observation: { status: baselineResp.status, truncated: baselineResp.truncated ?? false,
          response_digest: "sha256:" + createHash("sha256").update(baselineResp.body).digest("hex"), marker_observed: true },
        comparison_observations: (confirmedRead ? qualified.filter(c => c.broken === true && c.truncated === false) : qualified).map(c => ({ identity: c.identity, status: c.status,
          truncated: c.truncated, response_digest: c.response_digest, marker_observed: c.owner_marker_observed })),
      } } : {}),
    });

    return { success: true, output };
  }

  private static readonly workflowSchema = z.object({
    allow_mutation: z.literal(true),
    owner_identity: z.string().min(1),
    actor_identity: z.string().min(1),
    observation_url: z.string().min(1),
    observation_json_pointer: z.string().regex(/^(?:\/(?:[^~]|~[01])*)?$/),
    expected_state: z.string().max(500),
    steps: z.array(z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      url: z.string().min(1),
      body: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }).strict()).min(1).max(10),
  }).strict();

  /** State transitions are evidence only when both owner observations succeed. */
  private async accessControlWorkflow(raw: Record<string, unknown>): Promise<ToolResult> {
    const parsed = ToolExecutor.workflowSchema.safeParse(raw);
    if (!parsed.success) return { success: false, output: null, error: parsed.error.message };
    const args = parsed.data;
    const principals = this.resolveProbeIdentities();
    const owner = principals.find((p) => p.label === args.owner_identity);
    const actor = principals.find((p) => p.label === args.actor_identity);
    if (!owner || !actor || owner.label === actor.label) {
      return { success: false, output: null, error: "Configure distinct owner_identity and actor_identity principals" };
    }
    // The model supplies the operator placeholder, never the proof challenge.
    // Issue a fresh host-only nonce and bind it to the actor request body before
    // dispatch; it is disclosed only after the final owner observation.
    const stateFixture = stateContract(this.ctx.accessControlFixtures, args.observation_url, owner.label, actor.label, args.observation_json_pointer);
    const challengeIssued = !!stateFixture && args.expected_state === stateFixture.ownershipMarker
      && args.steps.some(step => typeof step.body === "string" && step.body.includes(stateFixture.ownershipMarker));
    if (challengeIssued) {
      const challenge = "zero-state-" + randomUUID();
      args.steps = args.steps.map(step => ({ ...step, ...(step.body ? { body: step.body.split(stateFixture!.ownershipMarker).join(challenge) } : {}) }));
      args.expected_state = challenge;
    }
    const ownerHeaders = owner.headers();
    const actorHeaders = actor.headers();
    const canonicalHeaders = (headers: Record<string, string>) =>
      JSON.stringify(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b)));
    if (canonicalHeaders(ownerHeaders) === canonicalHeaders(actorHeaders)) {
      return { success: false, output: null, error: "Owner and actor have identical authentication; no authorization boundary can be tested" };
    }
    // Reject configured custom credential headers as well as standard ones.
    const authHeaderNames = new Set([...Object.keys(ownerHeaders), ...Object.keys(actorHeaders)].map((key) => key.toLowerCase()));
    for (const name of ["authorization", "cookie", "proxy-authorization", "host", "x-api-key", "x-auth-token"]) authHeaderNames.add(name);
    const secrets = authSecretValues(this.ctx.authConfig);
    const collectSecrets = (headers: Record<string, string>) => {
      for (const [name, value] of Object.entries(headers)) {
        secrets.push(value);
        if (name.toLowerCase() === "authorization") secrets.push(value.replace(/^(?:Bearer|Basic)\s+/i, ""));
        if (name.toLowerCase() === "cookie") {
          for (const cookie of value.split(";")) secrets.push(cookie.slice(cookie.indexOf("=") + 1).trim());
        }
      }
    };
    collectSecrets(ownerHeaders);
    collectSecrets(actorHeaders);
    const safe = (value: string) => redactAuthValues(value, secrets);
    try {
      validateTargetUrl(this.ctx.target, args.observation_url, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      for (const step of args.steps) {
        validateTargetUrl(this.ctx.target, step.url, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
        if (step.method === "GET" && step.body !== undefined) throw new Error("GET steps cannot have a request body");
        // Headers validates HTTP names/values before any earlier step can mutate.
        const headers = new Headers(step.headers);
        for (const key of headers.keys()) {
          if (authHeaderNames.has(key.toLowerCase())) throw new Error(`Actor step cannot override authentication or routing header: ${key}`);
        }
      }
    } catch (error) {
      return { success: false, output: null, error: safe(error instanceof Error ? error.message : String(error)) };
    }
    const evidence: Array<Record<string, unknown>> = [];
    let before: Record<string, unknown> | null = null;
    let after: Record<string, unknown> | null = null;
    const finish = (verdict: "confirmed" | "no_change" | "inconclusive", reason: string): ToolResult => {
      // Capture cookies obtained during the workflow before redacting evidence.
      collectSecrets(owner.headers());
      collectSecrets(actor.headers());
      const sanitize = (value: unknown): unknown => {
        if (typeof value === "string") return safe(value);
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
        return value;
      };
      const contract = stateContract(this.ctx.accessControlFixtures, args.observation_url, owner.label, actor.label, args.observation_json_pointer);
      const prior = contract ? this.retainedStateAccessProof(contract) : undefined;
      const proof = verdict === "confirmed" && contract ? confirmedStateProof(contract, {
        before, after, steps: evidence, expected: args.expected_state, prior, now: Date.now(), challengeIssued,
      }) : null;
      const output = {
        ...(proof ? { state_access_proof: proof } : {}),
        workflow: "access_control_workflow", owner_identity: safe(owner.label), actor_identity: safe(actor.label),
        observation_url: safe(args.observation_url), observation_json_pointer: safe(args.observation_json_pointer),
        expected_state: safe(args.expected_state), observation_before: sanitize(before), steps: sanitize(evidence),
        observation_after: sanitize(after), verdict, reason: safe(reason),
      };
      this.persistToolArtifact("access_control_workflow", output);
      return { success: true, output };
    };
    const observe = async (): Promise<{ evidence: Record<string, unknown>; value?: unknown; error?: string }> => {
      try {
        const response = await this.fetchAs(owner, args.observation_url, "GET", undefined, {});
        const observation: Record<string, unknown> = { status: response.status, truncated: response.truncated ?? false, redacted: response.redacted ?? false };
        if (response.status < 200 || response.status >= 300 || response.truncated) {
          return { evidence: observation, error: "Owner observation was unsuccessful or truncated" };
        }
        let value: unknown;
        try { value = JSON.parse(response.body); }
        catch { return { evidence: observation, error: "Owner observation was not valid JSON" }; }
        const pointer = args.observation_json_pointer;
        for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
          const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
          if (typeof value !== "object" || value === null || !Object.hasOwn(value, key) ||
              (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) {
            return { evidence: observation, error: "Observation JSON pointer is missing" };
          }
          value = (value as Record<string, unknown>)[key];
        }
        observation.field_present = true;
        observation.value_type = value === null ? "null" : typeof value;
        observation.value_truncated = typeof value === "string" && value.length > 500;
        observation.json_pointer_value = typeof value === "string" ? value.slice(0, 500) : value === null ? null : typeof value;
        return { evidence: observation, value };
      } catch (error) {
        return { evidence: {}, error: safe(error instanceof Error ? error.message : String(error)) };
      }
    };
    const baseline = await observe();
    before = baseline.evidence;
    if (baseline.error) return finish("inconclusive", baseline.error);
    if (baseline.value === args.expected_state) return finish("no_change", "Expected marker was already present; actor requests were not sent");
    let transportFailed = false;
    for (const [index, step] of args.steps.entries()) {
      try {
        const response = await this.fetchAs(actor, step.url, step.method, step.body, step.headers ?? {});
        evidence.push({ step_index: index, method: step.method, url: step.url, status: response.status,
          body_length: response.body.length, truncated: response.truncated ?? false,
          request_body_digest: step.body === undefined ? null : "sha256:" + createHash("sha256").update(step.body).digest("hex"), request_body_bytes: step.body === undefined ? 0 : Buffer.byteLength(step.body, "utf8"),
          retained_response_digest: "sha256:" + createHash("sha256").update(response.body).digest("hex"), response_redacted: response.redacted ?? false, request_marker_sent: typeof step.body === "string" && step.body.includes(args.expected_state) });
        // An HTTP denial is observable evidence; a transport error is not.
      } catch (error) {
        evidence.push({ step_index: index, method: step.method, url: step.url, error: safe(error instanceof Error ? error.message : String(error)) });
        transportFailed = true;
        break;
      }
    }
    const observation = await observe();
    after = observation.evidence;
    if (observation.error || transportFailed) return finish("inconclusive", observation.error ?? "Actor workflow failed to complete");
    if (observation.value === args.expected_state) return finish("confirmed", "Owner observed the unique expected marker only after the distinct actor workflow");
    if (Object.is(observation.value, baseline.value)) return finish("no_change", "Actor requests did not change the observed state");
    return finish("inconclusive", "State changed, but not to the declared marker; attribution is uncertain");
  }

  private retainedStateAccessProof(fixture: AccessControlFixture) {
    try { return this.db ? latestStateProof(this.db.getRecentScanEvents(this.ctx.scanId, "tool_artifact", 500, ["access_control_workflow", "access_control_cleanup"]), fixture) : undefined; }
    catch { return undefined; }
  }

  /** Read-only cleanup verification: never performs compensating mutations. */
  private async accessControlCleanup(raw: Record<string, unknown>): Promise<ToolResult> {
    const parsed = z.object({ observation_url: z.string().min(1).max(8192), owner_identity: z.string().min(1).max(64) }).strict().safeParse(raw);
    if (!parsed.success) return { success: false, output: null, error: "Provide observation_url and owner_identity only" };
    const { observation_url, owner_identity } = parsed.data;
    const contract = stateContract(this.ctx.accessControlFixtures, observation_url, owner_identity);
    const owner = this.resolveProbeIdentities().find(identity => identity.label === owner_identity);
    if (!contract?.stateChange || !owner || !this.db) return { success: false, output: null, error: "A retained operator-owned state-change proof and owner identity are required" };
    const prior = this.retainedStateAccessProof(contract);
    if (!prior) return { success: false, output: null, error: "No matching retained state-change proof is available; cleanup remains unverified" };
    try {
      const response = await this.fetchAs(owner, observation_url, "GET", undefined, {});
      if (!is2xx(response.status) || response.truncated || response.redacted) throw new Error("Owner cleanup observation was unsuccessful or incomplete");
      const digest = stateDigest(observedState(response.body, contract.stateChange.jsonPointer));
      const proof = { ...prior, cleanup: digest === prior.baseline_digest ? "completed" as const : "failed" as const, cleanup_at: Date.now(), cleanup_revision: prior.cleanup_revision + 1 };
      const output = { workflow: "access_control_cleanup", observation_url: contract.url, state_access_proof: proof,
        observation: { status: response.status, truncated: false, value_digest: digest } };
      this.persistToolArtifact("access_control_cleanup", output);
      return { success: true, output };
    } catch {
      // Do not expose private response data or infer cleanup from an error.
      return { success: false, output: null, error: "Cleanup observation was unavailable; the retained cleanup status is unchanged" };
    }
  }

  /**
   * Scope-validated request returning status + body text, mirroring the
   * enforcement path of `fetchAs`/`httpRequest` (validateTargetUrl + scope +
   * SSRF guard + attribution + rate limiter). No identity auth is injected —
   * the caller passes any auth via `headers`. Used by the detection probes.
   */
  private async scopedFetchText(
    rawUrl: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<{ status: number; text: string }> {
    const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const fetchInit = applyAttribution(
        url,
        { method, headers, body: body ?? undefined, signal: controller.signal, redirect: "manual" },
        this.ctx.attribution,
        this.ctx.scope,
      )!;
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
      // foxguard:ignore — `url` validated by validateTargetUrl above
      // (same-origin + scope + private-IP/localhost block + path allowlist).
      const res = await this.fetchTarget(url, fetchInit);
      if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
      const text = await res.text();
      return { status: res.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * #774 — drive the structural / JSON-key SQLi break→balance loop over live
   * HTTP and return the verdict + iteration trail. The KEY (`base_key`) is the
   * injection surface; each iteration mutates it into a copy of `body`.
   */
  private async structuralSqliProbe(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    const baseKey = args.base_key as string;
    if (!url) return { success: false, output: null, error: "url is required" };
    if (!baseKey) return { success: false, output: null, error: "base_key is required" };
    const method = ((args.method as string) ?? "POST").toUpperCase();
    const baseBody =
      args.body && typeof args.body === "object"
        ? (args.body as Record<string, unknown>)
        : {};
    const maxIterations =
      typeof args.max_iterations === "number" ? args.max_iterations : undefined;
    // Inject the scan's configured auth so the probe works on authenticated
    // endpoints (not just the unauthenticated McKinsey case). Empty when the
    // engagement configured no creds — buildAuthHeaders tolerates undefined.
    const authHeaders = this.ctx.authConfig
      ? buildAuthHeaders(this.ctx.authConfig)
      : {};

    const sendKey = async (payload: {
      key: string;
    }): Promise<ProbeObservation> => {
      // The key is the injection surface — set the mutated key with a benign
      // value in a copy of the base body; other fields go verbatim.
      const bodyObj: Record<string, unknown> = { ...baseBody, [payload.key]: "1" };
      const json = JSON.stringify(bodyObj);
      try {
        const { status, text } = await this.scopedFetchText(url, method, json, {
          "Content-Type": "application/json",
          ...authHeaders,
        });
        return { payloadKey: payload.key, responseText: text, status };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { payloadKey: payload.key, responseText: msg };
      }
    };

    let result;
    try {
      result = await runStructuralSqliProbeAsync({ baseKey, maxIterations }, sendKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `structural_sqli_probe failed: ${msg}` };
    }

    this.persistToolArtifact("structural_sqli_probe", {
      url,
      base_key: baseKey,
      verdict: result.verdict,
      dialect: result.dialect,
    });

    const summary =
      result.verdict === "confirmed"
        ? `Structural SQL injection CONFIRMED on JSON key "${baseKey}" at ${url} (${result.dialect ?? "dialect unpinned"}): a balanced key parsed cleanly while the broken key errored. Save a finding with the iteration trail.`
        : result.verdict === "error_signal"
          ? `Key "${baseKey}" reaches the SQL parser (broken key errored, ${result.dialect ?? "dialect unpinned"}) but no clean differential confirmation within ${result.trail.length} iterations — likely structural SQLi; inspect the trail or re-probe.`
          : `No structural SQLi signal on key "${baseKey}" at ${url}: the broken key never triggered a SQL error (surface is not concatenating the key into SQL).`;

    // On a confirmed break, pre-draft the finding so the agent can save_finding
    // without re-deriving the evidence (a common drop point). Advisory only —
    // the agent still decides whether/when to save.
    const suggested_finding =
      result.verdict === "confirmed"
        ? {
            title: `Structural SQL injection via JSON key "${baseKey}"`,
            severity: "high",
            category: "sql_injection",
            description: summary,
          }
        : null;

    return {
      success: true,
      output: {
        url,
        base_key: baseKey,
        verdict: result.verdict,
        dialect: result.dialect,
        iterations: result.trail.length,
        trail: result.trail,
        summary,
        suggested_finding,
      },
    };
  }

  /**
   * #775 — classify the WRITE impact of a prompt-layer DB asset the agent has
   * already read. Verification-only: pure classification over read-only
   * evidence, no writes.
   */
  private async promptLayerProbe(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.writable !== "boolean") {
      return { success: false, output: null, error: "writable (boolean) is required" };
    }
    const asset: PromptLayerAsset = {
      table: args.table as string | undefined,
      column: args.column as string | undefined,
      sample: args.sample as string | undefined,
      writable: args.writable,
      reReadAtInference: args.re_read_at_inference === true,
    };
    const result = classifyPromptLayerImpact(asset);
    const suggested_finding =
      result.severity === "high"
        ? {
            title: `Writable prompt-layer asset${asset.table ? ` (${asset.table}${asset.column ? `.${asset.column}` : ""})` : ""} — persistent prompt injection`,
            severity: "high",
            category: "prompt_injection",
            description: result.narrative,
          }
        : null;
    return {
      success: true,
      output: {
        is_prompt_layer: result.isPromptLayer,
        impacts: result.impacts,
        severity: result.severity,
        narrative: result.narrative,
        suggested_finding,
      },
    };
  }

  /**
   * #770 — probe a set of endpoints for unauthenticated reachability (the
   * "N of M endpoints require no auth" class). Sends each endpoint unauthed
   * (auth stripped) and, when the scan configured creds, authed, then diffs.
   * Every request goes through the scope-validated fetch path.
   */
  private async authBoundaryProbe(args: Record<string, unknown>): Promise<ToolResult> {
    const rawEndpoints = args.endpoints;
    if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
      return { success: false, output: null, error: "endpoints (non-empty array of url strings or {url,method,body}) is required" };
    }
    const endpoints = rawEndpoints as Array<AuthBoundaryEndpoint | string>;

    // Scope-validated FetchLike — the prober owns the authed/unauthed diff
    // logic; this only enforces scope/SSRF/attribution and shapes the response.
    const fetchImpl: AuthBoundaryFetchLike = async (rawUrl, init) => {
      const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const fetchInit = applyAttribution(
          url,
          {
            method: init?.method ?? "GET",
            headers: init?.headers ?? {},
            body: init?.body,
            signal: controller.signal,
            redirect: "manual",
          },
          this.ctx.attribution,
          this.ctx.scope,
        )!;
        if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
        // foxguard:ignore — `url` validated by validateTargetUrl above.
        const res = await this.fetchTarget(url, fetchInit);
        if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
        const bodyText = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          headers: res.headers,
          text: async () => bodyText,
        };
      } finally {
        clearTimeout(timer);
      }
    };

    let report;
    try {
      report = await runAuthBoundaryProbe({
        endpoints,
        auth: this.ctx.authConfig,
        fetchImpl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `auth_boundary_probe failed: ${msg}` };
    }

    this.persistToolArtifact("auth_boundary_probe", {
      endpoint_count: report.endpointCount,
      unauth_reachable_count: report.unauthReachableCount,
    });

    const leaks = report.results.filter((r) => r.unauthReachable);
    const summary =
      leaks.length > 0
        ? `${leaks.length}/${report.endpointCount} endpoint(s) reachable WITHOUT authentication: ${leaks
            .map((l) => `${l.method} ${l.url} (${l.severity})`)
            .join(", ")}. Save a finding for each unauth-reachable break with the evidence below.`
        : `All ${report.endpointCount} endpoint(s) gated: none were reachable unauthenticated.`;

    // Pre-draft a finding per unauthenticated-reachable endpoint so the agent
    // can save_finding directly. Advisory only.
    const suggested_findings = leaks.map((l) => ({
      title: `Unauthenticated access to ${l.method} ${l.url}`,
      severity: l.severity === "high" ? "high" : "medium",
      category: "broken_access_control",
      description: `${l.method} ${l.url} is reachable without authentication (verdict: ${l.verdict}). ${l.note}`,
    }));

    return {
      success: true,
      output: {
        endpoint_count: report.endpointCount,
        unauth_reachable_count: report.unauthReachableCount,
        results: report.results,
        summary,
        suggested_findings,
      },
    };
  }

  /**
   * #769 — map the target's API surface (OpenAPI/Swagger spec discovery +
   * endpoint enumeration + MCP probe) in one call, so the agent can recon the
   * surface mid-scan and feed the endpoint list into auth_boundary_probe /
   * structural_sqli_probe. All probes go through the scope-validated fetch, so
   * out-of-scope candidates are naturally dropped (recon records them as
   * warnings rather than probing them).
   */
  private async discoverApiSurface(args: Record<string, unknown>): Promise<ToolResult> {
    const domain = (args.domain as string) ?? this.ctx.target;
    if (!domain) {
      return { success: false, output: null, error: "domain is required (or set the scan target)" };
    }

    // Scope-validated fetch matching `typeof fetch` — recon only reaches paths
    // validateTargetUrl accepts; anything out of scope throws and recon folds
    // it into `warnings` instead of probing it.
    const scopedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      const fetchInit = applyAttribution(
        url,
        { ...init, redirect: "manual" },
        this.ctx.attribution,
        this.ctx.scope,
      )!;
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
      // foxguard:ignore — `url` validated by validateTargetUrl above.
      const res = await this.fetchTarget(url, fetchInit);
      if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
      return res;
    }) as typeof fetch;

    let result;
    try {
      result = await runRecon(domain, { fetchImpl: scopedFetch });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `discover_api_surface failed: ${msg}` };
    }

    this.persistToolArtifact("discover_api_surface", {
      domain: result.domain,
      total: result.summary.total,
      by_kind: result.summary.byKind,
    });


    const endpoints = result.assets.filter((a) => a.kind === "endpoint").length;
    const specs = result.assets.filter((a) => a.kind === "openapi_spec").length;
    const summary =
      result.assets.length > 0
        ? `Mapped ${result.assets.length} asset(s) on ${result.domain}: ${specs} API spec(s), ${endpoints} endpoint(s)` +
          (result.summary.byKind.mcp_server ? `, ${result.summary.byKind.mcp_server} MCP server(s)` : "") +
          `. Feed the endpoint list into auth_boundary_probe to find unauthenticated ones, then structural_sqli_probe the dynamic params.`
        : `No API spec or MCP surface found at ${result.domain}${result.warnings.length ? ` (${result.warnings.length} probe warning(s))` : ""}.`;

    return {
      success: true,
      output: {
        domain: result.domain,
        total: result.summary.total,
        by_kind: result.summary.byKind,
        assets: result.assets,
        warnings: result.warnings,
        summary,
      },
    };
  }

  /**
   * #761 — one-call attack-surface sweep: discover_api_surface +
   * auth_boundary_probe composed. Maps the surface, then probes every
   * discovered endpoint for unauthenticated reachability, returning the
   * inventory + per-endpoint verdicts + pre-drafted findings for the leaks.
   */
  private async surfaceSweep(args: Record<string, unknown>): Promise<ToolResult> {
    const domain = (args.domain as string) ?? this.ctx.target;
    if (!domain) {
      return { success: false, output: null, error: "domain is required (or set the scan target)" };
    }

    // Scope-validated fetch for the recon leg (typeof fetch).
    const scopedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      const fetchInit = applyAttribution(
        url,
        { ...init, redirect: "manual" },
        this.ctx.attribution,
        this.ctx.scope,
      )!;
      if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
      // foxguard:ignore — `url` validated by validateTargetUrl above.
      const res = await this.fetchTarget(url, fetchInit);
      if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
      return res;
    }) as typeof fetch;

    let recon;
    try {
      recon = await runRecon(domain, { fetchImpl: scopedFetch });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `surface_sweep recon failed: ${msg}` };
    }

    // Turn discovered "METHOD /path" endpoints into absolute probe endpoints.
    const origin = recon.domain.replace(/\/+$/, "");
    const endpoints: AuthBoundaryEndpoint[] = recon.assets
      .filter((a) => a.kind === "endpoint")
      .map((a) => {
        const [maybeMethod, ...rest] = a.value.trim().split(/\s+/);
        const hasMethod = rest.length > 0;
        const method = hasMethod ? maybeMethod : "GET";
        const path = (hasMethod ? rest.join(" ") : a.value).trim();
        const url = path.startsWith("http")
          ? path
          : `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
        return { url, method };
      });

    // No endpoints to probe — return the surface map alone.
    if (endpoints.length === 0) {
      return {
        success: true,
        output: {
          domain: recon.domain,
          surface: { total: recon.summary.total, by_kind: recon.summary.byKind, assets: recon.assets },
          endpoint_count: 0,
          unauth_reachable_count: 0,
          results: [],
          suggested_findings: [],
          summary: `Mapped ${recon.summary.total} asset(s) on ${recon.domain} but found no concrete endpoints to auth-probe (no parseable API spec).`,
        },
      };
    }

    // Scope-validated FetchLike for the boundary leg.
    const fetchLike: AuthBoundaryFetchLike = async (rawUrl, init) => {
      const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const fetchInit = applyAttribution(
          url,
          { method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body, signal: controller.signal, redirect: "manual" },
          this.ctx.attribution,
          this.ctx.scope,
        )!;
        if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
        // foxguard:ignore — `url` validated by validateTargetUrl above.
        const res = await this.fetchTarget(url, fetchInit);
        if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
        const bodyText = await res.text();
        return { ok: res.ok, status: res.status, headers: res.headers, text: async () => bodyText };
      } finally {
        clearTimeout(timer);
      }
    };

    let report;
    try {
      report = await runAuthBoundaryProbe({ endpoints, auth: this.ctx.authConfig, fetchImpl: fetchLike });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `surface_sweep boundary probe failed: ${msg}` };
    }

    this.persistToolArtifact("surface_sweep", {
      domain: recon.domain,
      assets: recon.summary.total,
      endpoints: report.endpointCount,
      unauth_reachable: report.unauthReachableCount,
    });


    const leaks = report.results.filter((r) => r.unauthReachable);
    const suggested_findings = leaks.map((l) => ({
      title: `Unauthenticated access to ${l.method} ${l.url}`,
      severity: l.severity === "high" ? "high" : "medium",
      category: "broken_access_control",
      description: `${l.method} ${l.url} is reachable without authentication (verdict: ${l.verdict}). ${l.note}`,
    }));

    return {
      success: true,
      output: {
        domain: recon.domain,
        surface: { total: recon.summary.total, by_kind: recon.summary.byKind, assets: recon.assets },
        endpoint_count: report.endpointCount,
        unauth_reachable_count: report.unauthReachableCount,
        results: report.results,
        suggested_findings,
        summary:
          `Swept ${recon.domain}: ${recon.summary.total} asset(s), ${report.endpointCount} endpoint(s) probed, ` +
          `${report.unauthReachableCount} reachable WITHOUT auth` +
          (leaks.length > 0
            ? `: ${leaks.map((l) => `${l.method} ${l.url}`).join(", ")}. Drill into dynamic params with structural_sqli_probe.`
            : `. Surface gated.`),
      },
    };
  }

  /**
   * #927 — JS/crawl-based endpoint + runtime secret discovery (the CodeWall
   * "credentials in a public JS file" move). Fetches the in-scope JS the
   * target serves (the `scripts` a crawl found, or the target page's scripts
   * when none are passed), mines each bundle for endpoint/route strings + API
   * bases and for embedded secrets, then auto-probes the discovered endpoints
   * with auth_boundary_probe. Endpoints come back in the discover_api_surface
   * shape; secrets come back redacted (the raw value never leaves the body).
   */
  private async jsRecon(args: Record<string, unknown>): Promise<ToolResult> {
    // Resolve the candidate JS URLs: explicit `scripts` arg, else crawl the
    // target page once and use its <script src> URLs.
    let scriptUrls: string[] = Array.isArray(args.scripts)
      ? (args.scripts as unknown[]).filter((s): s is string => typeof s === "string")
      : [];

    if (scriptUrls.length === 0) {
      if (!this.ctx.target) {
        return { success: false, output: null, error: "js_recon needs `scripts` (or a scan target to crawl for them)" };
      }
      const crawlResult = await this.crawl({ url: this.ctx.target, depth: 1 });
      if (crawlResult.success && crawlResult.output) {
        const pages = (crawlResult.output as { pages?: Array<{ scripts?: string[] }> }).pages ?? [];
        scriptUrls = [...new Set(pages.flatMap((p) => p.scripts ?? []))];
      }
    }

    if (scriptUrls.length === 0) {
      return {
        success: true,
        output: {
          scanned: [],
          endpoints: [],
          api_base_urls: [],
          secrets: [],
          suggested_findings: [],
          summary: "js_recon found no JS files to mine (no scripts on the target page).",
        },
      };
    }

    const maxFiles = typeof args.max_files === "number" ? args.max_files : undefined;

    // Scope-validated fetchText. Out-of-scope URLs throw inside
    // validateTargetUrl; runJsRecon also pre-filters via the ScopePolicy, so
    // an out-of-scope script is skipped rather than fetched.
    const fetchText = async (rawUrl: string): Promise<{ status: number; body: string }> => {
      let url: string;
      try {
        url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
      } catch {
        return { status: 0, body: "" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const fetchInit = applyAttribution(
          url,
          { method: "GET", signal: controller.signal, redirect: "manual", headers: { Accept: "*/*" } },
          this.ctx.attribution,
          this.ctx.scope,
        )!;
        if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
        // foxguard:ignore — `url` validated by validateTargetUrl above.
        const res = await this.fetchTarget(url, fetchInit);
        if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
        const body = await res.text();
        return { status: res.status, body };
      } catch {
        return { status: 0, body: "" };
      } finally {
        clearTimeout(timer);
      }
    };

    let recon;
    try {
      recon = await runJsRecon({ scriptUrls, scope: this.ctx.scope, fetchText, maxFiles });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `js_recon failed: ${msg}` };
    }

    this.persistToolArtifact("js_recon", {
      scanned: recon.scanned.length,
      endpoints: recon.endpoints.length,
      secrets: recon.secrets.length,
    });


    // Auto-probe the discovered endpoints for unauthenticated reachability —
    // the issue's acceptance criterion ("then auto-probes the discovered
    // endpoints"). Reuse the same scope-validated FetchLike as surface_sweep.
    let authResults: Array<{
      url: string;
      method: string;
      unauthReachable: boolean;
      verdict: string;
      note: string;
      severity?: string;
    }> = [];
    if (recon.endpoints.length > 0) {
      const probeEndpoints: AuthBoundaryEndpoint[] = recon.endpoints.map((a) => {
        const method = a.metadata?.method ?? "GET";
        const path = a.metadata?.path ?? a.value;
        const url = path.startsWith("http")
          ? path
          : `${(this.ctx.target ?? "").replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
        return { url, method };
      });

      const fetchLike: AuthBoundaryFetchLike = async (rawUrl, init) => {
        const url = validateTargetUrl(this.ctx.target, rawUrl, this.ctx.scope, this.ctx.enforcement, this.ctx.publicNetwork);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const fetchInit = applyAttribution(
            url,
            { method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body, signal: controller.signal, redirect: "manual" },
            this.ctx.attribution,
            this.ctx.scope,
          )!;
          if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url);
          // foxguard:ignore — `url` validated by validateTargetUrl above.
          const res = await this.fetchTarget(url, fetchInit);
          if (this.ctx.rateLimiter) this.ctx.rateLimiter.noteResponse(url, res);
          const bodyText = await res.text();
          return { ok: res.ok, status: res.status, headers: res.headers, text: async () => bodyText };
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        const report = await runAuthBoundaryProbe({
          endpoints: probeEndpoints,
          auth: this.ctx.authConfig,
          fetchImpl: fetchLike,
        });
        authResults = report.results.map((r) => ({
          url: r.url,
          method: r.method,
          unauthReachable: r.unauthReachable,
          verdict: r.verdict,
          note: r.note,
          severity: r.severity,
        }));
      } catch {
        // Boundary probe failed — still return endpoints + secrets.
        authResults = [];
      }
    }

    // Pre-drafted findings: every high-confidence leaked secret + every
    // unauthenticated-reachable endpoint discovered from JS. Secrets are
    // already redacted by scanBody/redactSecret.
    const secretFindings = recon.secrets
      .filter((s) => s.confidence === "high")
      .map((s) => ({
        title: `Leaked credential in served JavaScript (${s.kind})`,
        severity: "high",
        category: "information-disclosure",
        description:
          `A high-confidence ${s.kind} value (${s.match}) is hardcoded in a JavaScript file served to the browser: ${s.chunk}. ` +
          `A genuine credential shipped client-side must be treated as compromised and rotated.`,
        evidence: { file: s.chunk, kind: s.kind, match: s.match },
      }));

    const leaks = authResults.filter((r) => r.unauthReachable);
    const endpointFindings = leaks.map((l) => ({
      title: `Unauthenticated access to ${l.method} ${l.url} (discovered via JS)`,
      severity: l.severity === "high" ? "high" : "medium",
      category: "broken_access_control",
      description: `${l.method} ${l.url} — extracted from served JS, reachable without authentication (verdict: ${l.verdict}). ${l.note}`,
    }));

    const highSecrets = secretFindings.length;
    return {
      success: true,
      output: {
        scanned: recon.scanned,
        skipped: recon.skipped,
        endpoints: recon.endpoints,
        api_base_urls: recon.apiBaseUrls,
        secrets: recon.secrets,
        auth_boundary_results: authResults,
        unauth_reachable_count: leaks.length,
        suggested_findings: [...secretFindings, ...endpointFindings],
        summary:
          `Mined ${recon.scanned.length} JS file(s): ${recon.endpoints.length} endpoint(s), ` +
          `${recon.apiBaseUrls.length} API base URL(s), ${recon.secrets.length} secret hit(s) ` +
          `(${highSecrets} high-confidence). ` +
          (recon.endpoints.length > 0
            ? `${leaks.length} discovered endpoint(s) reachable WITHOUT auth. `
            : "") +
          `Feed endpoints into surface_sweep / structural_sqli_probe; save any high-confidence secret as a finding.`,
      },
    };
  }


  /**
   * burp-network-20260913 — Burp-style intercepting HTTP(S) proxy. Thin
   * delegate to executeProxy (agent/tools/proxy.ts), threading this session's
   * cross-turn {@link ProxyHost} (running driver + in-memory HTTP-history store
   * + installed match/replace rules). The real proxy server lives behind a
   * lazy, guarded ProxyDriver seam; egress is scope-gated through
   * `this.ctx` exactly like http_request. The listener is torn down in
   * cleanup().
   */
  private async proxyAction(args: Record<string, unknown>): Promise<ToolResult> {
    return executeProxy(this.ctx, args, { host: this._proxyHost });
  }

  /**
   * #925 — test S3 buckets for public access + orphaned-bucket takeover.
   * Anonymous, read-only: GET / and GET /?acl per bucket. NoSuchBucket (404)
   * is classified as takeover-able (the BCG orphaned-integration finding) but
   * the bucket is never re-created — 0 only flags it. Returns per-bucket
   * verdicts + pre-drafted findings for public buckets and takeover-able refs.
   *
   * SCOPE-GATED, deny-by-default (#924 parity): probing a target org's bucket
   * is recon against that org, NOT an infra call, so each bucket must clear the
   * engagement ScopePolicy via `bucketInScope`. With no scope configured every
   * bucket is denied (no-op skip); out-of-scope buckets are skipped and
   * reported under `skipped`. The operator authorizes cloud probing by adding
   * the bucket's S3 endpoint (or `*.amazonaws.com`) to the scope's in_scope.
   */
  private async cloudS3Probe(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.cloudSurface) {
      return { success: false, output: null, error: "cloud_s3_probe is disabled. Set ZERO_FEATURE_CLOUD_SURFACE=1 to enable." };
    }
    const rawBuckets = args.buckets;
    if (!Array.isArray(rawBuckets) || rawBuckets.length === 0) {
      return { success: false, output: null, error: "buckets (non-empty array of bucket name strings) is required" };
    }
    const buckets = rawBuckets
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .map((b) => b.trim());
    if (buckets.length === 0) {
      return { success: false, output: null, error: "buckets must contain at least one non-empty bucket name string" };
    }
    const region = typeof args.region === "string" ? args.region : undefined;
    const maxKeys = typeof args.max_keys === "number" ? args.max_keys : undefined;

    // Deny-by-default scope gate: only probe buckets the engagement scope
    // authorizes. No scope policy → every bucket is denied (no-op).
    const results = [];
    const skipped: Array<{ bucket: string; reason: string }> = [];
    for (const bucket of buckets) {
      const gate = bucketInScope(bucket, this.ctx.scope, region);
      if (!gate.allowed) {
        skipped.push({ bucket, reason: gate.reason });
        continue;
      }
      const probe = await probeS3Bucket(bucket, { region, maxKeys });
      const takeover = classifyTakeover(probe);
      results.push({ ...probe, takeoverable: takeover.takeoverable, takeover_note: takeover.note });
    }

    const publicBuckets = results.filter((r) => r.verdict === "public");
    const takeoverable = results.filter((r) => r.takeoverable);

    this.persistToolArtifact("cloud_s3_probe", {
      bucket_count: results.length,
      public_count: publicBuckets.length,
      takeoverable_count: takeoverable.length,
      skipped_count: skipped.length,
    });


    const suggested_findings = [
      ...publicBuckets.map((r) => ({
        title: `Public S3 bucket: ${r.bucket}`,
        severity: r.severity === "high" ? "high" : "medium",
        category: "security-misconfiguration",
        description: `${r.endpoint} is anonymously listable (HTTP ${r.listStatus}${r.aclReadable ? ", ACL publicly readable" : ""}). ${r.note}${r.sampleKeys.length ? ` Sample keys: ${r.sampleKeys.slice(0, 5).join(", ")}.` : ""}`,
      })),
      ...takeoverable.map((r) => ({
        title: `Orphaned S3 bucket takeover: ${r.bucket}`,
        severity: "high",
        category: "security-misconfiguration",
        description: r.takeover_note,
      })),
    ];

    // All buckets out of scope → make the deny-by-default outcome explicit
    // rather than silently returning a zero-result success.
    if (results.length === 0 && skipped.length > 0) {
      return {
        success: true,
        output: {
          bucket_count: 0,
          public_count: 0,
          takeoverable_count: 0,
          results: [],
          skipped,
          suggested_findings: [],
          summary: `All ${skipped.length} bucket(s) skipped — none in engagement scope. ${skipped[0].reason}. Add the bucket's S3 endpoint to the scope's in_scope to authorize probing.`,
        },
      };
    }

    const summary =
      publicBuckets.length || takeoverable.length
        ? `${results.length} bucket(s) probed: ${publicBuckets.length} PUBLIC, ${takeoverable.length} takeover-able (NoSuchBucket)${skipped.length ? `, ${skipped.length} out-of-scope skipped` : ""}. Save a finding for each. Read-only — no buckets were written or created.`
        : `${results.length} bucket(s) probed: none public, none takeover-able${skipped.length ? `, ${skipped.length} out-of-scope skipped` : ""}.`;

    return {
      success: true,
      output: {
        bucket_count: results.length,
        public_count: publicBuckets.length,
        takeoverable_count: takeoverable.length,
        results,
        skipped,
        suggested_findings,
        summary,
      },
    };
  }

  /**
   * #925 — validate a harvested AWS credential safely (read-only) and gauge
   * over-privilege. sts:GetCallerIdentity confirms liveness + identity; a few
   * read-only List* probes measure effective permissions. The action allowlist
   * is enforced in cloud-surface.ts so no mutating API can be reached.
   *
   * SCOPE-GATED, deny-by-default (#924 parity): validating a harvested credential
   * is recon against the target org's cloud account, so it requires an
   * authorized engagement. With no engagement ScopePolicy configured the tool
   * refuses (deny-by-default) — the same authorization signal recon uses.
   */
  private async cloudValidateCredentials(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.cloudSurface) {
      return { success: false, output: null, error: "cloud_validate_credentials is disabled. Set ZERO_FEATURE_CLOUD_SURFACE=1 to enable." };
    }
    if (isScopeEnforcementEnabled() && !this.ctx.scope) {
      return {
        success: false,
        output: null,
        error:
          "cloud_validate_credentials denied: no engagement scope configured (cloud credential validation is deny-by-default — it requires an authorized engagement scope).",
      };
    }
    const accessKeyId = typeof args.access_key_id === "string" ? args.access_key_id.trim() : "";
    const secretAccessKey = typeof args.secret_access_key === "string" ? args.secret_access_key.trim() : "";
    if (!accessKeyId || !secretAccessKey) {
      return { success: false, output: null, error: "access_key_id and secret_access_key are required" };
    }
    const sessionToken = typeof args.session_token === "string" ? args.session_token : undefined;
    const region = typeof args.region === "string" ? args.region : undefined;

    let result;
    try {
      result = await validateAwsCredentials({ accessKeyId, secretAccessKey, sessionToken, region });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `cloud_validate_credentials failed: ${msg}` };
    }

    // Never persist the secret — only the non-secret outcome.
    this.persistToolArtifact("cloud_validate_credentials", {
      valid: result.valid,
      over_privileged: result.effectivePermissions.length > 1,
      severity: result.severity,
    });

    const suggested_findings = result.valid
      ? [
          {
            title:
              result.effectivePermissions.length > 1
                ? `Over-privileged AWS credential (${result.arn ?? accessKeyId})`
                : `Live AWS credential (${result.arn ?? accessKeyId})`,
            severity: result.severity === "high" ? "high" : result.severity === "medium" ? "medium" : "low",
            category: "security-misconfiguration",
            description: `${result.note} Effective read-only permissions: ${result.effectivePermissions.join(", ")}.`,
          },
        ]
      : [];

    return {
      success: true,
      output: {
        valid: result.valid,
        account: result.account,
        arn: result.arn,
        effective_permissions: result.effectivePermissions,
        severity: result.severity,
        note: result.note,
        suggested_findings,
      },
    };
  }

  private async shellExec(args: Record<string, unknown>): Promise<ToolResult> {
    let command = (args.command as string)?.trim();
    if (!command) {
      return { success: false, output: null, error: "Command is required" };
    }
    const networkScope = this.ctx.publicNetwork ? this.ctx.publicNetwork.scope : this.ctx.scope;
    const acquisition = parseRepositoryAcquisition(command);
    if (this.ctx.consoleSession && acquisition && !repositoryIdentityMatchesTarget(this.ctx.target, acquisition.url)) {
      return {
        success: false,
        output: null,
        error: "Console repository acquisition refused: provide the exact HTTPS repository URL as the current target before cloning or reviewing source.",
      };
    }

    if (this.ctx.autonomyMode === "yolo" && !this.ctx.enforcement) {
      if (acquisition && !networkScope?.match(acquisition.url).allowed) {
        if (!repositoryAcquisitionAllowed(acquisition, networkScope)) {
          return { success: false, output: null, error: "Repository source is explicitly excluded by the engagement scope" };
        }
        const ceilingMs = resolveBashWallclockCeilingMs();
        const requested = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 90;
        const timeoutMs = Math.min(ceilingMs, Math.max(1, requested) * 1000);
        const result = await runRepositoryAcquisition(acquisition, command, timeoutMs, ceilingMs, networkScope);
        this.persistToolArtifact("bash", {
          command: command.slice(0, 500),
          output: String(result.output ?? result.error ?? "").slice(0, 2_000),
          sourceAcquisition: true,
        });
        return result;
      }
    }

    // Programmatic scope pre-flight (0#215). The bash subprocess can
    // reach out to anywhere — we don't have an egress proxy yet (issue
    // is acknowledged in the DoD), so the best we can do is grep the
    // command for obvious URLs and refuse if any are out of scope. This
    // catches the common case (`curl https://evil.com/x`); a cleverer
    // agent that hides the URL behind base64 / DNS / a temp file is NOT
    // caught here, and that gap is documented as a follow-up.
    if (isScopeEnforcementEnabled() && networkScope) {
      const urls = extractUrls(command);
      for (const url of urls) {
        const verdict = networkScope.enforce(url)
        if (!verdict.allowed) {
          this.ctx.enforcement?.noteOutOfScopeBlocked();
          return {
            success: false,
            output: null,
            error: `bash refused: command references out-of-scope URL '${url}' (${verdict.reason})`,
          };
        }
        // http_audit path allowlist on bash-extracted URLs (FROZEN CONTRACT).
        if (this.ctx.enforcement) {
          const pathVerdict = this.ctx.enforcement.pathPolicy.enforce(url);
          if (!pathVerdict.allowed) {
            this.ctx.enforcement.noteOutOfScopeBlocked();
            return {
              success: false,
              output: null,
              error: `bash refused: command references out-of-path URL '${url}' (${pathVerdict.reason})`,
            };
          }
        }
      }

      // Generic-scanner-traffic suppression (0#217). When scope is
      // loaded the engagement is presumed to be a coordinated-disclosure
      // run, and most venue policies explicitly forbid the named
      // generic scanners (sqlmap/nikto/gobuster/…) because they
      // fingerprint themselves on the wire. The shell-first agent has
      // `http_request` + `crawl` for the actual probing it needs to do.
      // `--allow-scanners` (threaded down as `ctx.allowScanners`)
      // overrides this gate for engagements that explicitly permit
      // those tools.
      if (!this.ctx.allowScanners) {
        const hit = detectScannerBinary(command);
        if (hit) {
          return {
            success: false,
            output: null,
            error: `bash refused: ${hit.reason}`,
          };
        }
      }
    } else {
      // Record disabled or unconfigured authorization honestly; resource and
      // credential controls below are independent of scope activation.
      const guards = describeScopeGuards(false);
      if (guards.required) {
        return { success: false, output: null, error: scopeRequiredRefusal("bash") };
      }
      const unscopedUrls = extractUrls(command);
      const egressSegments = detectHttpEgressSegments(command);
      if (unscopedUrls.length > 0 || egressSegments.length > 0) {
        this.persistToolArtifact("bash", {
          scope_guards: "inert",
          inert_guards: guards.inertGuards,
          unscoped_egress_urls: unscopedUrls.slice(0, 10),
          unscoped_egress_segments: egressSegments.slice(0, 10).map((s) => s.slice(0, 120)),
          note: guards.message,
        });
      }
    }

    // ── http_audit bash-egress SSRF gate (FROZEN CONTRACT) ──
    // Close the gap where bash curl/wget/python-http bypasses the
    // host+path allowlist that http_request/crawl/submit_form enforce.
    // Any HTTP-egress segment MUST carry at least one explicit http(s) URL
    // (which the scope+path block above already verified is in-scope AND
    // in-path). An egress command with no statically-resolvable URL is
    // refused fail-closed — its destination can't be audited, which defeats
    // the bounded-egress guarantee of http_audit. Non-egress bash is
    // untouched. Only active in http_audit mode (enforcement set).
    if (isScopeEnforcementEnabled() && this.ctx.enforcement) {
      const egressSegments = detectHttpEgressSegments(command);
      for (const segment of egressSegments) {
        const urlsInSegment = extractUrls(segment);
        if (urlsInSegment.length === 0) {
          this.ctx.enforcement.noteOutOfScopeBlocked();
          return {
            success: false,
            output: null,
            error:
              `bash refused (http_audit): HTTP-egress command '${segment.slice(0, 80)}' has no explicit ` +
              `in-scope http(s) URL to verify against the host+path allowlist. Use the http_request tool, ` +
              `or pass a literal in-scope URL.`,
          };
        }
        // URLs present in the segment were already host+path validated in
        // the scope block above (any out-of-scope URL would have returned).
      }
    }

    // ── Close the bash rate-limiter bypass (0#568) ──
    // The bash subprocess shells out to curl/wget/python-http, which bypass
    // node's `fetch` and therefore the per-host RateLimiter (#214) that the
    // http_request / crawl / submit_form tools pace against. Without an egress
    // proxy we can't throttle the subprocess socket itself, but we CAN pace +
    // count BEFORE exec: for every explicit, in-scope http(s) URL an egress
    // segment will hit, acquire a token from the SAME per-host bucket (so bash
    // traffic paces identically to the fetch tools and honours any active 429
    // cool-off) and tally it on the enforcement tracker, so bash-issued
    // requests show up in `requests_in_scope` / peak-RPS instead of being
    // invisible. URLs were already host+path validated above when scope is set;
    // when scope is unset we still pace whatever explicit URLs are present.
    if (this.ctx.rateLimiter || this.ctx.enforcement) {
      const egressSegments = detectHttpEgressSegments(command);
      const pacedUrls = new Set<string>();
      for (const segment of egressSegments) {
        for (const egressUrl of extractUrls(segment)) {
          if (pacedUrls.has(egressUrl)) continue;
          pacedUrls.add(egressUrl);
          if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(egressUrl);
          if (isScopeEnforcementEnabled()) this.ctx.enforcement?.noteInScope();
        }
      }
    }

    // Deterministic auth-header injection (0#282). When `authConfig`
    // is set, rewrite curl/wget invocations whose URL is in scope and
    // which don't already carry explicit auth, so the env-var
    // indirection (`$AUTH_CURL_FLAG` / `$AUTH_HEADER:$AUTH_VALUE`) lands
    // in the bash command before exec. Python `requests` invocations
    // are refused with a hint pointing at the `http_request` tool.
    //
    // Only run when authConfig is set (no auth ⇒ nothing to inject) AND
    // scope is set (no scope ⇒ can't verify in-scope ⇒ don't leak auth
    // to potentially-non-engagement targets).
    if (this.ctx.authConfig && this.ctx.scope) {
      const verdict = injectAuthIntoBashCommand(command, this.ctx.scope);
      if (verdict.kind === "refuse") {
        return { success: false, output: null, error: `bash refused: ${verdict.reason}` };
      }
      if (verdict.kind === "rewrite") {
        command = verdict.command;
      }
    }

    // Per-call requested timeout (caller arg) is clamped against the wallclock
    // ceiling. Even if the caller asks for a longer one, we never exceed the
    // ceiling — a runaway subprocess (e.g. python3 requests.post with no
    // timeout) must not be able to wedge the agent indefinitely.
    const ceilingMs = resolveBashWallclockCeilingMs();
    const requestedMs = Math.max(1, ((args.timeout as number) ?? 30) * 1000);
    const timeoutMs = Math.min(requestedMs, ceilingMs);

    const env = { ...sanitizedEnv(), TARGET: this.ctx.target, ...this.buildAuthEnvVars() };

    // The command the OPERATOR asked for (the value may have been rewritten by
    // auth-header injection above; the card shows the model's original intent).
    const displayCommand = (args.command as string).trim();
    const startedAt = Date.now();
    const outcome = await runBashWithWallclock(command, {
      timeoutMs, ceilingMs, env, cwd: this.ctx.scopePath ?? this.ctx.workspaceRoot, signal: this._executionContext.getStore()?.signal,
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

  // ── Code eval (js_eval / python_eval) ──

  /** `js_eval` handler — evaluate a JavaScript snippet with Node.js. */
  private async jsEval(args: Record<string, unknown>): Promise<ToolResult> {
    return this.codeEval("javascript", args);
  }

  /** `python_eval` handler — evaluate a Python 3 snippet. */
  private async pythonEval(args: Record<string, unknown>): Promise<ToolResult> {
    return this.codeEval("python", args);
  }

  /**
   * Shared runtime for the two eval tools. It is a THIN WRAPPER over
   * {@link shellExec}: it builds a quoted-heredoc `node` / `python3` command and
   * delegates, so every scope / egress / auth-header / rate-limit guard and the
   * wallclock ceiling that protect `bash` apply here unchanged — this adds NO
   * new execution or sandbox-escape path. It then re-labels the result's
   * display-only `meta` from a `command` card to a `code` card carrying the
   * language, source, output, exit code, and duration; the model-facing
   * `output` / `error` are passed through untouched.
   */
  private async codeEval(language: EvalLanguage, args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseEvalArgs(args);
    if (!parsed.ok) return { success: false, output: null, error: parsed.error };
    const { code, timeout } = parsed.value;

    const command = buildEvalCommand(language, code);
    const result = await this.shellExec({ command, ...(timeout != null ? { timeout } : {}) });

    // shellExec attaches a `command`-kind meta (durationMs / exitCode / stdout).
    // Reuse its measurements but present a `code` card instead.
    const cmdMeta = result.meta && result.meta.kind === "command" ? result.meta : undefined;
    const output = cmdMeta?.stdout ?? (typeof result.output === "string" ? result.output : "");
    return {
      ...result,
      meta: {
        kind: "code",
        language,
        code,
        output,
        exitCode: cmdMeta?.exitCode ?? null,
        ...(cmdMeta?.durationMs != null ? { durationMs: cmdMeta.durationMs } : {}),
      },
    };
  }

  // ── Browser automation (multi-tab, tools/browser.ts) ──

  /**
   * Scope-pinned request transport handed to the browser driver as its
   * `interceptor`. Mirrors the old `context.route("**\/*") -> fetchTarget`
   * block: for a public-network scan it fetches every page resource through
   * the scope-checked `fetchTarget` sink (so no sub-resource escapes scope and
   * attribution is applied) and hands the fulfilled response back to the
   * driver; for a normal scoped/unscoped scan it returns `null`, letting the
   * request continue directly (Chromium reaches only the in-scope host that
   * `executeBrowser`'s pre-`goto` + post-redirect scope gate already vetted).
   */
  private _browserInterceptor = async (req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array } | null> => {
    // Only the public-network path pins the transport, exactly as before.
    if (!this.ctx.publicNetwork) return null;
    const execution = this._executionContext.getStore();
    const response = await this.fetchTarget(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ? Buffer.from(req.body) : undefined,
      redirect: "manual",
      signal: execution?.signal,
    });
    const headers = Object.fromEntries(response.headers.entries());
    delete headers["content-encoding"];
    delete headers["content-length"];
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers, body };
  };

  /**
   * The `browser` tool handler. Delegates to the next-gen multi-tab driver in
   * tools/browser.ts (`executeBrowser`), holding the driver across calls in
   * `_browserHost` and passing the scope-pinned interceptor + attribution
   * UA/headers. The method name is unchanged so dispatch (`browser ->
   * browserAction`) is untouched. Scope gating (pre-`goto` + post-redirect
   * re-check, 0#218) lives inside `executeBrowser`, and a missing backend
   * degrades to a clear install hint there rather than throwing here.
   */
  private async browserAction(args: Record<string, unknown>): Promise<ToolResult> {
    // Attribution: Playwright has its own request pipeline (not applyAttribution),
    // so the UA + headers are pinned on the browser context. Out-of-scope hosts
    // are never reached (scope gate + interceptor), so this stays in-scope-only —
    // and public-network browsing carries no attribution, as before.
    const attribution = this.ctx.publicNetwork ? undefined : this.ctx.attribution;
    const userAgent = attribution?.userAgentToken
      ? formatUserAgent(attribution.userAgentToken)
      : "0-browser/1.0";
    const extraHeaders =
      attribution && Object.keys(attribution.headers).length > 0 ? attribution.headers : undefined;
    if (this._browserJev === undefined) {
      // Misconfiguration (enabled feature without a key, malformed read-only URL)
      // must degrade to assist-handoff, never break unrelated browser actions.
      try {
        const config = jevConfigFromEnvironment("browser", process.env);
        this._browserJev = config ? createJevEvaluator(config) : null;
        this._browserReadOnlyUrls = new Set((process.env["ZERO_JEV_BROWSER_READ_ONLY_URLS"] ?? "")
          .split(",").map(url => url.trim()).filter(Boolean).map(url => new URL(url).href));
      } catch {
        this._browserJev = null;
        this._browserReadOnlyUrls = new Set();
      }
    }
    const execution = this._executionContext.getStore();

    const result = await executeBrowser(this.ctx, args, {
      host: this._browserHost,
      userAgent,
      extraHeaders,
      interceptor: this._browserInterceptor,
      jev: this._browserJev ?? undefined,
      readOnlyUrls: this._browserReadOnlyUrls,
      signal: execution?.signal,
      assertAuthority: execution?.assertAuthority,
    });

    if (args.action === "screenshot" && result.success && result.meta?.image?.mimeType === "image/png") {
      execution?.assertAuthority?.();
      const output = result.output as Record<string, unknown>;
      try {
        const receipt = await retainBrowserScreenshot(result.meta.image.imageBase64, execution?.signal, typeof output.url === "string" ? output.url : undefined, typeof output.screenshot_caption === "string" ? output.screenshot_caption : undefined);
        output.evidence_retention = receipt ? "retained" : "local_only";
        if (receipt) { output.evidence_reference = receipt.reference; output.evidence_sha256 = receipt.sha256; }
      } catch {
        output.evidence_retention = "unavailable";
      }
    }

    // Evidence trail: persist the action + resulting URL, as the old handler did.
    if (result.success) {
      const out = result.output as { url?: string } | null;
      this.persistToolArtifact("browser", {
        action: (args.action as string) ?? "",
        url: (args.url as string) ?? out?.url ?? this.ctx.target,
      });
    }
    return result;
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
    const scopeRulesArr: string[] | undefined = this.ctx.scope
      ? [
          ...(this.ctx.scope.raw.in_scope ?? []),
          ...(this.ctx.scope.raw.out_of_scope ?? []),
        ]
      : undefined;
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
      ...(scopeRulesArr !== undefined ? { scope_rules: scopeRulesArr } : {}),
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

  private checkoutKeys(): string[] {
    // Shell and scoped file tools historically use different fallback roots.
    // Reserve both without changing either tool's authority or cwd semantics.
    const roots = [this.ctx.scopePath ?? this.ctx.workspaceRoot ?? process.cwd(), this.ctx.scopePath ?? process.cwd()];
    return [...new Set([...new Set(roots)].map(root => captureWorkspaceIdentity(root)?.repositoryRoot ?? realpathSync(root)))];
  }

  private isReadOnlyWorker(): boolean { return this._workerTree.workspace(this.ctx.scanId)?.readOnly === true; }

  private acquireWorker(base: SubagentLifecycleBase, readOnly = false, guardedKeys?: string[], allowedTools?: readonly string[]): ReturnType<AuditWorkerTree["acquire"]> {
    const restricted = readOnly || this.isReadOnlyWorker();
    const keys = guardedKeys ?? this.checkoutKeys();
    const effectiveTools = this.subagentTools(undefined, restricted).filter(tool => allowedTools === undefined || allowedTools.includes(tool.name));
    const writeCapable = !restricted && effectiveTools.some(tool => !isCheckoutReadOnlyTool(tool.name));
    return this._workerTree.acquire(base.agent_id, this.ctx.scanId, { ...base,
      workspace: { key: keys[0], guardedKeys: keys, writeCapable, readOnly: restricted },
    });
  }

  private subagentTools(messaging: MessagingRuntime | undefined, readOnly = this.isReadOnlyWorker()): ToolDefinition[] {
    const inherited = this.ctx.delegationTools ?? getToolsForRole(this.ctx.role ?? "attack", {
      hasScope: !!this.ctx.scopePath, webSearchEnabled: this.ctx.webSearchEnabled,
          allowScanners: this.ctx.allowScanners,
    });
    // A console workspace is not necessarily a source-audit target. In the
    // prompt-free modes, retain the parent's advertised capabilities instead
    // of silently downgrading a web worker to source-only tools. An explicit
    // read-only source boundary remains authoritative in every mode.
    const inheritConsoleTools = this.ctx.consoleSession && this.ctx.delegationTools !== undefined &&
      (this.ctx.autonomyMode === "yolo" || this.ctx.autonomyMode === "copilot");
    const scopedSource = !!getLocalSourceBoundary() || (!inheritConsoleTools &&
      !!this.ctx.scopePath && (this.ctx.role === "audit" || this.ctx.role === "review"));
    return filterWorkflowAgentTools(inherited.filter(tool =>
      Object.hasOwn(TOOL_DEFINITIONS, tool.name) &&
      (this.ctx.webSearchEnabled !== false || tool.name !== "web_search") &&
      (!scopedSource || Object.hasOwn(SCOPED_SOURCE_AUDIT_TOOLS, tool.name)) &&
      (!readOnly || isCheckoutReadOnlyTool(tool.name)),
    ).concat(REPORT_STATUS_TOOL, buildSendMessageTool(messaging), CHECK_MESSAGES_TOOL));
  }

  /** Validate before allocating workers; a requested list can only narrow admission. */
  private admittedSubagentTools(requested: readonly string[] | undefined): string[] | undefined {
    const host = this.ctx.workerPolicy?.allowedTools;
    if (requested === undefined && host === undefined && getWorkflowAuditExecutionPolicy()?.allowedAgentTools === undefined) return undefined;
    const available = new Set(this.subagentTools(undefined).map(tool => tool.name));
    if (requested !== undefined) for (const name of requested) {
      if (!available.has(name)) throw new Error(`allowed_tools contains unavailable tool "${name}"`);
    }
    // Capture effective host + inherited ceilings before any parked revival.
    const effective = requested ?? [...available];
    return [...new Set(host === undefined ? effective : effective.filter(tool => host.includes(tool)))];
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
      "Use only your provided tools within the inherited scope.",
      names.has("spawn_agent") ? "Delegate independent subtasks when useful." : "",
      names.has("save_finding") ? "Save evidence-backed findings with save_finding." : "",
      names.has("done") ? "Call done when finished." : "Return your result in prose when finished.",
    ].filter(Boolean).join(" ");
  }

  /** Children publish through the root writer, bound to its selected scan/store. */
  private delegatedFindingPersistence(signal?: AbortSignal): ToolContext["persistDelegatedFinding"] {
    if (this.ctx.persistFindings === false) return undefined;
    const inherited = this.ctx.persistDelegatedFinding;
    const db = this.db;
    if (!inherited && (!this.ctx.consoleSession || !db)) return undefined;
    return finding => {
      // Every ancestor's closure fences publication after its subtree is stopped.
      signal?.throwIfAborted();
      if (inherited) inherited(finding);
      else if (db && !db.getFinding(finding.id)) db.saveFinding(this.ctx.scanId, finding);
    };
  }

  private mergeSubagentFindings(findings: readonly Finding[], sink = this.ctx.findings): void {
    for (const finding of findings) {
      if (!sink.some(existing => existing.id === finding.id)) sink.push(finding);
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
      lease ??= this.acquireWorker(base, false, undefined, allowedTools);
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

      const subTools = this.subagentTools(childMessaging, this._workerTree.workspace(base.agent_id)?.readOnly).filter(tool => allowedTools === undefined || allowedTools.includes(tool.name));

      // running — immediately before the agent loop starts
      this.emitWorkerLifecycle({ ...base,
      status: "running" as const, });

      // 0#218 review: propagate scope + auth to the spawned loop so
      // the sub-agent's bash/http_request gates use the same policy as
      // the parent. Without this, a parent scan locked to in-scope hosts
      // could spawn a child that hits arbitrary URLs via bash/curl.
      //
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
          scope: this.ctx.scope,
          authConfig: this.usesTargetIdentity(this.ctx.target) ? this.ctx.authConfig : undefined,
          costLedger: this.ctx.costLedger,
          requirePricedUsage: this.ctx.requirePricedUsage,
          costCeilingUsd: this.ctx.costCeilingUsd,
          costModel: rt.resolvedModel?.() ?? this.ctx.costModel,
          scopePath: this._workspaceIdentity?.scopePath ?? this.ctx.scopePath,
          workspaceIdentity: this._workspaceIdentity,
          autonomyMode: this.ctx.autonomyMode,
          consoleSession: this.ctx.consoleSession,
          workerPolicy,
          publicNetwork: this.ctx.publicNetwork,
          webSearchEnabled: this.ctx.webSearchEnabled,
        allowScanners: this.ctx.allowScanners,
          attribution: this.ctx.attribution,
          engagement: this.ctx.engagement,
          codebaseLearning: false,
          allowModelSelfExtension: subTools.some(tool => tool.name === "self_extend") && (this.ctx.selfExtension?.isEnabled() ?? false),
          executablePlugins: this.ctx.executablePluginConfiguration,
          workspaceRoot: this.ctx.workspaceRoot,
          skillDiscoveryOptions: this.ctx.skillDiscoveryOptions,
          skillAuthoring: this.ctx.skillAuthoring,
          executableEvolutionProfiles: this.ctx.executableEvolutionProfiles,
          enforcement: this.ctx.enforcement,
          rateLimiter: this.ctx.rateLimiter,
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

    const subTools = this.subagentTools(childMessaging, this._workerTree.workspace(base.agent_id)?.readOnly).filter(tool => allowedTools === undefined || allowedTools.includes(tool.name));
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
        scope: this.ctx.scope,
        authConfig: this.usesTargetIdentity(this.ctx.target) ? this.ctx.authConfig : undefined,
        costLedger: this.ctx.costLedger,
        requirePricedUsage: this.ctx.requirePricedUsage,
        costCeilingUsd: this.ctx.costCeilingUsd,
        costModel: rt.resolvedModel?.() ?? this.ctx.costModel,
        scopePath: this._workspaceIdentity?.scopePath ?? this.ctx.scopePath,
        workspaceIdentity: this._workspaceIdentity,
        autonomyMode: this.ctx.autonomyMode,
        consoleSession: this.ctx.consoleSession,
        workerPolicy,
        publicNetwork: this.ctx.publicNetwork,
        webSearchEnabled: this.ctx.webSearchEnabled,
        allowScanners: this.ctx.allowScanners,
        attribution: this.ctx.attribution,
        engagement: this.ctx.engagement,
        codebaseLearning: false,
        allowModelSelfExtension: subTools.some(tool => tool.name === "self_extend") && (this.ctx.selfExtension?.isEnabled() ?? false),
        executablePlugins: this.ctx.executablePluginConfiguration,
        workspaceRoot: this.ctx.workspaceRoot,
        skillDiscoveryOptions: this.ctx.skillDiscoveryOptions,
        skillAuthoring: this.ctx.skillAuthoring,
        executableEvolutionProfiles: this.ctx.executableEvolutionProfiles,
        enforcement: this.ctx.enforcement,
        rateLimiter: this.ctx.rateLimiter,
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
    if (args.read_only !== undefined && typeof args.read_only !== "boolean") return { success: false, output: null, error: "read_only must be a boolean" };
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

    const lifetime = prepared?.lease ?? this.acquireWorker(base, args.read_only === true, undefined, allowedTools);
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

  /** Session-scoped background-process supervisor (lazy). */
  private processManager(): ProcessManager {
    if (!this._processManager) this._processManager = new ProcessManager();
    return this._processManager;
  }

  private monitorSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  /**
   * `monitor` — supervise a long-running background process across turns (see
   * process-manager.ts). Ops: start (with a log/port ready-gate), logs
   * (cursor + grep), wait (exit | pattern | timeout), stop (signal), ps, send.
   * Args are Zod-validated then rejected before any side effect.
   */
  private async monitor(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = validateMonitorArgs(args);
    if (!parsed.ok) {
      this.recordToolHealth({ tool: "monitor", category: "error", message: parsed.error });
      return { success: false, output: null, error: parsed.error };
    }
    const a = parsed.args;
    const pm = this.processManager();
    const now = () => Date.now();
    const signal = this._executionContext.getStore()?.signal;
    const cancelledWait = (proc: ReturnType<ProcessManager["start"]>): ToolResult => ({
      success: false,
      output: { name: proc.name, pid: proc.pid, reason: "cancelled", status: proc.status, exit_code: proc.exitCode },
      error: "Process wait cancelled by operator. This cancels only the wait; inspect the retained process status or stop it explicitly.",
    });

    if (a.op === "ps") {
      const t = now();
      return {
        success: true,
        output: {
          processes: pm.list().map((p) => ({
            name: p.name,
            pid: p.pid,
            status: p.status,
            exit_code: p.exitCode,
            uptime_s: Math.round((t - p.startedAt) / 1000),
          })),
        },
      };
    }

    const name = a.name as string;

    if (a.op === "start") {
      let proc;
      try {
        proc = pm.start({ name, command: a.command as string, args: a.args, cwd: a.cwd, env: undefined });
      } catch (err) {
        return { success: false, output: null, error: err instanceof Error ? err.message : String(err) };
      }
      const gate: ReadyGate = {
        ...(a.ready_log ? { log: new RegExp(a.ready_log) } : {}),
        ...(a.ready_port ? { port: a.ready_port } : {}),
      };
      if (!gate.log && !gate.port) {
        return { success: true, output: { started: true, name, pid: proc.pid, status: proc.status } };
      }
      // Block until the ready-gate holds / the process exits / the timeout. Log
      // match is STICKY across polls so a combined log+port gate can be satisfied
      // by a log line and a port that come ready at different moments.
      const timeoutMs = Math.min(MONITOR_TIMEOUT_MAX_S, a.ready_timeout_s ?? MONITOR_READY_TIMEOUT_DEFAULT_S) * 1000;
      const deadline = now() + timeoutMs;
      let cursor = 0;
      let logMatched = gate.log === undefined;
      let matchedLine: string | undefined;
      for (;;) {
        if (signal?.aborted) return cancelledWait(proc);
        if (proc.status !== "running") {
          return { success: true, output: { started: true, name, pid: proc.pid, status: proc.status, ready: "exited", exit_code: proc.exitCode } };
        }
        const batch = proc.log.read(cursor);
        cursor = batch.cursor;
        if (gate.log && !logMatched) {
          const hit = batch.lines.find((l) => gate.log!.test(l.text));
          if (hit) {
            logMatched = true;
            matchedLine = hit.text;
          }
        }
        const portOpen = gate.port ? await probePort(gate.port) : true;
        if (signal?.aborted) return cancelledWait(proc);
        if (logMatched && portOpen) {
          const ready = gate.log && gate.port ? "both" : gate.log ? "log" : "port";
          return { success: true, output: { started: true, name, pid: proc.pid, status: "running", ready, ...(matchedLine ? { matched_line: matchedLine } : {}) } };
        }
        if (now() >= deadline) {
          return { success: true, output: { started: true, name, pid: proc.pid, status: "running", ready: "timeout", note: `ready-gate not satisfied within ${timeoutMs / 1000}s; the process is still running` } };
        }
        await this.monitorSleep(MONITOR_POLL_MS, signal);
      }
    }

    const proc = pm.get(name);
    if (!proc) return { success: false, output: null, error: `no process named "${name}" (use op:ps to list)` };

    if (a.op === "logs") {
      const grep = a.grep ? new RegExp(a.grep) : undefined;
      const batch = proc.log.read(a.cursor ?? 0, { grep, limit: a.limit });
      return {
        success: true,
        output: { name, status: proc.status, exit_code: proc.exitCode, cursor: batch.cursor, lines: batch.lines.map((l) => l.text) },
      };
    }

    if (a.op === "stop") {
      const ok = pm.stop(name, a.signal ?? "TERM");
      return { success: true, output: { stopped: ok, name, signal: a.signal ?? "TERM", status: proc.status } };
    }

    if (a.op === "send") {
      const ok = pm.send(name, a.text as string);
      return { success: true, output: { sent: ok, name } };
    }

    // op === "wait": block until the process exits, a pattern matches new output,
    // or the timeout. Watches NEW output from the tail by default.
    const pattern = a.pattern ? new RegExp(a.pattern) : undefined;
    const timeoutMs = Math.min(MONITOR_TIMEOUT_MAX_S, a.timeout_s ?? MONITOR_READY_TIMEOUT_DEFAULT_S) * 1000;
    const deadline = now() + timeoutMs;
    let cursor = a.cursor ?? proc.log.head;
    for (;;) {
      if (signal?.aborted) return cancelledWait(proc);
      if (proc.status !== "running") {
        const tail = proc.log.read(cursor, { limit: a.limit });
        return { success: true, output: { name, reason: "exit", status: proc.status, exit_code: proc.exitCode, cursor: tail.cursor, lines: tail.lines.map((l) => l.text) } };
      }
      if (pattern) {
        const batch = proc.log.read(cursor);
        cursor = batch.cursor;
        const hit = batch.lines.find((l) => pattern.test(l.text));
        if (hit) {
          return { success: true, output: { name, reason: "pattern", status: "running", matched_line: hit.text, cursor } };
        }
      }
      if (now() >= deadline) {
        return { success: true, output: { name, reason: "timeout", status: proc.status, cursor } };
      }
      await this.monitorSleep(MONITOR_POLL_MS, signal);
    }
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
    if (args.read_only !== undefined && typeof args.read_only !== "boolean") return fail("read_only must be a boolean");
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
      if (args.wait === true || ["context", "name", "model", "role", "max_turns", "expected_workspace", "read_only", "allowed_tools", "allowed_http_methods"].some(key => args[key] !== undefined)) {
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
      // No asynchronous work occurs while reserving: all entries share these actual roots.
      const guardedKeys = this.checkoutKeys();
      // Reserve the entire batch before starting any child. Failure admits none.
      for (const spec of specs) {
        const base = this.buildSubagentLifecycleBase(spec.task, spec.maxTurns, spec.name);
        leases.push({ base, lease: this.acquireWorker(base, args.read_only === true || spec.args.read_only === true, guardedKeys, this.admittedSubagentTools((spec.args.allowed_tools as string[] | undefined))) });
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

    const lease = this.acquireWorker(base, args.read_only === true, undefined, allowedTools);
    try {
    // queued — before any async setup
    this.emitWorkerLifecycle({ ...base, status: "queued" as const });

    const outcome = await this.runOneSubagent(task, maxTurns, base, undefined, undefined, selection.data, lease, typeof args.context === "string" ? args.context : undefined, workspace.data.expected_workspace, allowedTools, this.admittedSubagentHttpMethods(parsed.args.allowedHttpMethods));
    // Preserve accepted findings even if a later model request failed.
    this.mergeSubagentFindings(outcome.findings ?? []);
    if (!outcome.ok) {
      return { success: false, output: null, error: outcome.error };
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
    if (args.read_only !== undefined && typeof args.read_only !== "boolean") return { success: false, output: null, error: "read_only must be a boolean" };
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
    const specs: Array<{ task: string; maxTurns: number | undefined; base: SubagentLifecycleBase; selection: SubagentModelSelection; readOnly?: boolean; allowedTools?: string[]; allowedHttpMethods?: WorkflowHttpMethod[]; expectedWorkspace?: ExpectedWorkspace; lease?: ReturnType<AuditWorkerTree["acquire"]> }> = [];
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
      specs.push({ task, maxTurns, allowedTools, allowedHttpMethods: this.admittedSubagentHttpMethods(limits.args.allowedHttpMethods), base: this.buildSubagentLifecycleBase(task, maxTurns), selection: selection.data, readOnly: args.read_only === true || workspace.data.read_only === true, expectedWorkspace: workspace.data.expected_workspace });
    }

    // Reserve queued work too, so stop-all cannot miss later concurrency waves.
    try {
      const guardedKeys = this.checkoutKeys();
      for (const spec of specs) {
        spec.lease = this.acquireWorker(spec.base, spec.readOnly, guardedKeys, spec.allowedTools);
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
      async (spec) =>
        this.runOneSubagent(
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
        ),
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
      this.mergeSubagentFindings(outcome.findings ?? []);
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
    const todosPayload = buildTodosPayload(this._todos.snapshot()).todos;
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
      ...(todosPayload.length > 0 ? { todos: todosPayload } : {}),
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
      for (const spec of specs) spec.lease?.release();
    }
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
          "save_finding requires non-empty evidence_request, evidence_response, poc_steps, or description. " +
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

    const oastHandleId =
      typeof args.oast_handle_id === "string" ? args.oast_handle_id.trim() : "";
    const oastProof = oastHandleId ? this._oastVerified.get(oastHandleId) : undefined;
    if (oastHandleId && !oastProof) {
      return {
        success: false,
        output: null,
        error:
          `oast_handle_id="${oastHandleId}" has no verified callback. ` +
          "Call oast_poll after the trigger and pass its verified handle.",
      };
    }
    const category = typeof args.category === "string" ? args.category : "";
    if (oastProof && categoryToOastClass(category) !== oastProof.oastClass) {
      return {
        success: false,
        output: null,
        error:
          `oast_handle_id="${oastHandleId}" confirmed ${oastProof.oastClass}, ` +
          `which cannot verify finding category="${category}".`,
      };
    }
    const suppliedAnalysis =
      typeof args.evidence_analysis === "string" ? args.evidence_analysis : undefined;
    const oastAnalysis = oastProof
      ? `OAST callback verified (${oastProof.oastClass}/${oastProof.verdict.protocol}): ` +
        oastProof.verdict.evidence
      : undefined;
    const evidenceAnalysis = oastAnalysis
      ? suppliedAnalysis
        ? `${suppliedAnalysis}\n\n${oastAnalysis}`
        : oastAnalysis
      : suppliedAnalysis;

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
    // supplies this JSON-encoded string at save_finding time rather than via a
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

    if (oastProof) {
      if (finding.status === "false-positive") {
        return {
          success: false,
          output: null,
          error: "cannot attach OAST proof to a finding with an unverifiable source annotation",
        };
      }
      finding.status = "verified";
      finding.confidence = oastProof.verdict.confidence;
      finding.triageStatus = "accepted";
      finding.triageNote = `oast_verified: ${oastProof.verdict.evidence}`;
      finding.layerVerdicts = [
        {
          layer: "oracle",
          verdict: "pass",
          confidence: oastProof.verdict.confidence,
          reason: `OAST ${oastProof.oastClass} verified: ${oastProof.verdict.evidence}`,
          durationMs: 0,
          costUsd: 0,
        },
      ];

      // Mirror the trusted proof onto the source call so the native loop's
      // cloud-sink and event paths persist the same verification state.
      args.status = finding.status;
      args.confidence = finding.confidence;
      args.evidence_analysis = finding.evidence.analysis ?? "";
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
    // `update_finding` (an explicit, separate code path).
    const newNormTitle = normalizeFindingTitle(finding.title);
    const newEvidencePrefix = evidenceRequestPrefix(finding.evidence.request);
    const existing = this.ctx.findings.find((f) => {
      if (f.category !== finding.category) return false;
      const existingNormTitle = normalizeFindingTitle(f.title);
      if (existingNormTitle === newNormTitle) return true;
      const existingEvidencePrefix = evidenceRequestPrefix(f.evidence.request);
      if (existingEvidencePrefix !== newEvidencePrefix) return false;
      return (
        levenshtein(existingNormTitle, newNormTitle) <=
        FUZZY_TITLE_DISTANCE_THRESHOLD
      );
    });
    // Cross-session dedupe (operator directive): sibling lane agents save into
    // their own scanIds, so the in-memory check above cannot see their
    // findings. Before persisting, fuzzy-match against what the engagement's
    // other agents already stored — the first saved copy wins and later
    // near-duplicates merge into it instead of doubling the triage pile.
    // Cheap: engagement findings are a few dozen rows.
    if (!existing && this.db && this.ctx.persistFindings !== false) {
      try {
        const persisted = this.db.listFindings({ limit: 500 }) as Array<{
          id: string;
          title: string;
          evidence?: { request?: string };
        }>;
        const dbDupe = persisted.find((f) => {
          const existingNormTitle = normalizeFindingTitle(f.title ?? "");
          if (!existingNormTitle) return false;
          if (existingNormTitle === newNormTitle) return true;
          const existingEvidencePrefix = evidenceRequestPrefix(f.evidence?.request ?? "");
          if (existingEvidencePrefix && existingEvidencePrefix === newEvidencePrefix) return true;
          return levenshtein(existingNormTitle, newNormTitle) <= FUZZY_TITLE_DISTANCE_THRESHOLD;
        });
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
    } else if (this.ctx.persistFindings !== false) {
      this.ctx.persistDelegatedFinding?.(finding);
    }
    this.ctx.findings.push(finding);

    // 0#567 — harvest reusable footholds (credentials/tokens/cookies/…)
    // out of this finding's evidence into the loot ledger so the agent can
    // chain them into follow-up requests via `use_loot`. No-op when the loot
    // feature is off (ctx.loot undefined). Best-effort: a harvest failure must
    // never block a finding from being saved.
    try {
      this.ctx.loot?.harvestFromFinding(finding);
    } catch {
      /* harvesting is best-effort and must not abort save_finding */
    }

    return { success: true, output: { findingId: finding.id, message: "Finding saved" } };
  }

  /**
   * `use_loot` (0#567) — return previously captured footholds so the agent
   * can replay a leaked credential / token / cookie / endpoint / hash / path in
   * a follow-up request. Read-only and TRUSTED (we construct the output). When
   * the loot feature is off (no ledger), returns an empty, explanatory result
   * rather than an error so the call is always safe.
   */
  private useLoot(args: Record<string, unknown>): ToolResult {
    const ledger = this.ctx.loot;
    if (!ledger || ledger.size === 0) {
      return {
        success: true,
        output: {
          count: 0,
          items: [],
          message:
            "No footholds captured yet. Keep probing — leaked credentials, tokens, cookies, endpoints, and hashes are harvested automatically and will appear here for reuse.",
        },
      };
    }
    const kindArg = typeof args.kind === "string" ? args.kind : undefined;
    const items = ledger.query({
      kind: kindArg as LootKind | undefined,
      search: typeof args.search === "string" ? args.search : undefined,
      id: typeof args.id === "string" ? args.id : undefined,
    });
    return {
      success: true,
      output: {
        count: items.length,
        items: items.map((it) => ({
          id: it.id,
          kind: it.kind,
          value: it.value,
          source: it.source,
          context: it.context,
          turn: it.turn,
        })),
      },
    };
  }

  /**
   * `plan` — read and mutate the agent's typed TODO ledger.
   *
   * Two-stage, per the structured-output discipline in agent/AGENTS.md §1:
   * `validatePlanArgs` parses the raw payload against a Zod discriminated
   * union first and a malformed call is returned as an ERROR result naming the
   * offending field, so the model self-corrects on the next turn rather than
   * silently no-oping. Only after validation does `applyPlanAction` touch the
   * ledger. Semantic rejections from the ledger itself (unknown id, restarting
   * a closed task, plan full) come back the same way and for the same reason.
   *
   * When the feature is off there is no ledger, and this returns a graceful
   * explanatory success rather than an error — same contract as `use_loot` and
   * `oast_register`, so a model that calls a disabled tool is informed, not
   * punished with a failed turn.
   */
  private planTool(args: Record<string, unknown>): ToolResult {
    const ledger = this.ctx.plan;
    if (!ledger) {
      return {
        success: true,
        output: {
          enabled: false,
          message:
            "Plan tracking is not enabled for this scan. Continue without it — keep your objective in your own reasoning.",
        },
      };
    }

    const validated = validatePlanArgs(args);
    if (!validated.ok) {
      return { success: false, output: null, error: validated.error };
    }

    const turn = this.ctx.currentTurn ?? 0;
    const result = applyPlanAction(ledger, validated.args, turn);
    if (!result.ok) {
      return { success: false, output: null, error: result.error };
    }

    return {
      success: true,
      output: {
        message: result.message,
        // Always return the full open plan, not just the mutated tasks: the
        // model's next decision depends on what is LEFT, and echoing only the
        // task it just touched invites it to lose track of the rest.
        open: ledger.open().map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail,
          status: t.status,
        })),
        total: ledger.size,
      },
    };
  }

  /**
   * `oast_register` (0#659) — mint a unique out-of-band interaction handle
   * from the hosted collaborator. Returns a unique subdomain + correlation
   * token + ready-to-inject payload URLs. When no collaborator is configured
   * (feature off or ZERO_OAST_URL unset), returns a graceful, explanatory
   * result rather than an error — the agent should fall back to in-band proof.
   */
  private async oastRegister(args: Record<string, unknown>): Promise<ToolResult> {
    const collaborator = this.ctx.oast;
    if (!collaborator) {
      return {
        success: true,
        output: {
          available: false,
          message:
            "OAST collaborator not deployed for this scan. Blind/out-of-band callbacks cannot be confirmed here; fall back to in-band proof (SQL error, timing, reflected token, exfil content) or mark the candidate inconclusive.",
        },
      };
    }
    const handle = await collaborator.register();
    this._oastHandles.set(handle.id, handle);

    const candidate = typeof args.candidate === "string" ? args.candidate.trim() : "";
    const probe = candidate ? deriveProbe(handle, candidate) : null;
    if (probe) this._oastCandidates.set(handle.id, probe.nonce);

    return {
      success: true,
      output: {
        available: true,
        handle_id: handle.id,
        token: handle.token,
        host: probe ? probe.host : handle.host,
        http_url: probe ? probe.httpUrl : handle.httpUrl,
        dns_host: probe ? probe.dnsHost : handle.dnsHost,
        candidate: probe ? probe.nonce : undefined,
        guidance:
          "Inject http_url (blind SSRF/XSS/RCE HTTP callback) or dns_host (OOB-SQLi via xp_dirtree/UTL_HTTP/LOAD_FILE, JNDI/log4shell, DNS-exfil), trigger the payload, then call oast_poll. After a verified callback, pass this handle_id as oast_handle_id to save_finding so the proof persists with the finding.",
      },
    };
  }

  /**
   * `oast_poll` (0#659) — poll the collaborator for a handle and run the
   * OAST oracle (correlation-token matching) to return a confirmed/inconclusive
   * verdict. A confirmed callback is added to the loot ledger so the interaction
   * host can be chained. Trusted output (we construct it).
   */
  private async oastPoll(args: Record<string, unknown>): Promise<ToolResult> {
    const collaborator = this.ctx.oast;
    if (!collaborator) {
      return {
        success: true,
        output: {
          available: false,
          message: "OAST collaborator not deployed for this scan; cannot poll for callbacks.",
        },
      };
    }
    const handleId = String(args.handle_id ?? args.handleId ?? "").trim();
    if (!handleId) return { success: false, output: null, error: "handle_id is required" };
    const handle = this._oastHandles.get(handleId);
    if (!handle) {
      return {
        success: false,
        output: null,
        error: `unknown handle_id="${handleId}" — call oast_register first`,
      };
    }

    // Resolve a validated OAST class from an explicit class or finding category.
    const explicit = typeof args.class === "string" ? args.class.trim() : "";
    const category = typeof args.category === "string" ? args.category.trim() : "";
    const oastClass = explicit
      ? OAST_CLASS_BY_NAME[explicit]
      : categoryToOastClass(category);
    if (!oastClass) {
      return {
        success: false,
        output: null,
        error: "provide class (blind-ssrf|blind-xss|oob-rce|oob-sqli|xxe-oob|jndi) or a category",
      };
    }
    const suppliedCandidate =
      typeof args.candidate === "string" ? args.candidate.trim() : "";
    const candidate = suppliedCandidate || this._oastCandidates.get(handle.id);

    const interactions = await collaborator.poll(handle);
    const verdict = confirmOast({
      oastClass,
      token: handle.token,
      nonce: candidate,
      interactions,
    });

    // Feed a confirmed callback into the loot ledger so the interaction host can
    // be chained into follow-up requests. Best-effort; no-op without a ledger.
    if (verdict.verified) {
      this._oastVerified.set(handle.id, { oastClass, verdict });
      this.ctx.loot?.add({
        kind: "endpoint",
        value: handle.host,
        source: "oast_poll",
        context: `confirmed ${oastClass} via ${verdict.protocol} callback`,
      });
    }

    return {
      success: true,
      output: {
        available: true,
        handle_id: handle.id,
        class: oastClass,
        verified: verdict.verified,
        confidence: verdict.confidence,
        protocol: verdict.protocol,
        evidence: verdict.evidence,
        reason: verdict.reason,
        interaction_count: interactions.length,
      },
    };
  }

  private queryFindings(args: Record<string, unknown>): ToolResult {
    const allSessions = args.all_sessions === true;
    const requestedScanId = typeof args.scan_id === "string" && args.scan_id.trim() !== ""
      ? args.scan_id.trim()
      : undefined;
    const scanId = allSessions ? undefined : (requestedScanId ?? this.ctx.scanId);

    if (this.db) {
      const results = this.db.queryFindings({
        scanId,
        severity: args.severity as string | undefined,
        category: args.category as string | undefined,
        status: args.status as string | undefined,
        limit: (args.limit as number) ?? 20,
      });
      return { success: true, output: results };
    }

    // Fallback to in-memory: a running agent only has the current session's
    // in-memory findings. Cross-session queries require the persistent DB.
    if (allSessions || requestedScanId) {
      return {
        success: false,
        output: null,
        error: "Cross-session findings are unavailable because no persistent database is attached. In a subagent, ask the parent to run this query; otherwise configure the persistent findings database.",
      };
    }

    let results = [...this.ctx.findings];
    if (args.severity) results = results.filter((f) => f.severity === args.severity);
    if (args.category) results = results.filter((f) => f.category === args.category);
    if (args.status) results = results.filter((f) => f.status === args.status);
    return { success: true, output: results.slice(0, (args.limit as number) ?? 20) };
  }

  private updateFinding(args: Record<string, unknown>): ToolResult {
    const id = args.finding_id as string;
    const status = args.status as string;

    const finding = this.ctx.findings.find((f) => f.id === id);
    if (finding) {
      finding.status = status as Finding["status"];
    }
    if (this.db) {
      this.db.updateFindingStatus(id, status);
    }

    return { success: true, output: { message: `Finding ${id} updated to ${status}` } };
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "read_file requires a scoped local directory and is not available for remote target scanning",
      };
    }

    const requestedPath = args.path as string;
    const raw = await readScopedFile(this.ctx.scopePath, requestedPath, { signal: this._executionContext.getStore()?.signal });

    // Windowing + argument validation live in ./tools/read-file-window.ts so
    // the arithmetic is unit-testable without a ToolExecutor. `offset` is
    // 1-based to line up with grep/rg/sed and the `file.c:247` citation format
    // the finding schema expects.
    const window = windowFileContent(raw, {
      offset: args.offset,
      maxLines: args.max_lines,
      numberLines: this.ctx.diffScopedReview,
    });
    if (!window.ok) {
      return { success: false, output: null, error: window.error };
    }

    return {
      success: true,
      output: {
        content: window.content,
        totalLines: window.totalLines,
        truncated: window.truncated,
        startLine: window.startLine,
        endLine: window.endLine,
        ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset } : {}),
      },
    };
  }

  private listFiles(args: Record<string, unknown>): ToolResult {
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "list_files requires a scoped local directory and is not available for remote target scanning",
      };
    }

    return { success: true, output: listScopedFiles(this.ctx.scopePath ?? process.cwd(), args) };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "search_files requires a scoped local directory and is not available for remote target scanning",
      };
    }

    return { success: true, output: await searchScopedFiles(this.ctx.scopePath ?? process.cwd(), args, this._executionContext.getStore()?.signal) };
  }

  /**
   * apply_patch — 0#230. Structured DSL for reliable file edits.
   * Refuses to run without a scopePath (same gate as read_file/run_command);
   * paths are resolved through `resolveScopedPath` so patches cannot escape
   * the audit directory. The actual parsing and apply logic lives in
   * `apply-patch.ts` so it can be unit-tested without a ToolExecutor.
   */
  private applyPatch(args: Record<string, unknown>): ToolResult {
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "apply_patch requires a scoped local directory and is not available for remote target scanning",
      };
    }

    const patchInput = args.patch;
    if (typeof patchInput !== "string" || patchInput.trim().length === 0) {
      return {
        success: false,
        output: null,
        error: "apply_patch: `patch` argument must be a non-empty string envelope",
      };
    }

    const scopePath = this.ctx.scopePath ?? process.cwd();
    try {
      const ops = parsePatch(patchInput);
      const result = applyPatchOps(ops, (logical) => resolveScopedPath(scopePath, logical));
      // Display-only edit-card sidecar (never seen by the model): the edited
      // path(s), +/- line counts and a hunk diff body derived from the patch
      // envelope. The `*** …` op markers and `@@` anchors are dropped; the
      // remaining ` `/`+`/`-` lines are the diff the operator wants to see.
      const editMeta = buildEditCardMeta(patchInput, result.applied);
      return { success: true, output: { applied: result.applied }, meta: editMeta };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  /**
   * str_replace — exact-string file edit (Claude text_editor `str_replace`
   * contract). More reliable than `apply_patch` for single edits: there are no
   * fragile context hunks to mismatch — matching preserves whitespace and
   * indentation, tolerates LF/CRLF for multiline blocks and, unless `replace_all` is
   * set, UNIQUELY. Same gate as `apply_patch`/`run_command`: refuses without a
   * `scopePath` and resolves the path through `resolveScopedPath` so the edit
   * can never escape the audit directory. Fail-soft — every error is a clear,
   * self-correctable message, never a thrown exception or a silent no-op.
   */
  private strReplace(args: Record<string, unknown>): ToolResult {
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "str_replace requires a scoped local directory and is not available for remote target scanning",
      };
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
      return {
        success: false,
        output: null,
        error: "str_replace: `old_string` must not be empty; to create a new file use apply_patch",
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
      abs = resolveScopedPath(this.ctx.scopePath, rawPath);
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

  private async runCommand(args: Record<string, unknown>): Promise<ToolResult> {
    // YOLO uses full shell syntax; other modes tokenize commands and pipes.
    // Executables and package-manager subcommands are unrestricted in both paths.
    if (this.ctx.autonomyMode === "yolo") {
      return this.shellExec(args);
    }

    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "run_command requires a scoped local directory and is not available for remote target scanning",
      };
    }

    const command = (args.command as string).trim();
    if (containsUnquotedShellChars(command)) {
      return {
        success: false,
        output: null,
        error: `Shell operators (;, &, <, >, \`, $) are not allowed outside of quoted strings. Use pipe (|) for chaining, or bash for shell syntax.`,
      };
    }

    // Split on pipe to support "grep foo | head -5" style commands.
    // Empty segments indicate shell operators like || or malformed pipes.
    // Quote-aware so a `|` inside a regex pattern (e.g.
    // `grep "foo\|bar" file`) doesn't get treated as a pipe break.
    const rawSegments = splitOnTopLevelPipes(command);
    if (rawSegments.some((segment) => segment.trim().length === 0)) {
      return { success: false, output: null, error: "Empty pipe segments are not allowed" };
    }

    const segments = rawSegments.map((s) => s.trim());
    if (segments.length === 0) {
      return { success: false, output: null, error: "Command cannot be empty" };
    }

    // Validate each segment
    const tokenizedSegments: string[][] = [];
    for (const segment of segments) {
      let tokens: string[];
      try {
        tokens = tokenizeCommand(segment);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: msg };
      }

      if (tokens.length === 0) {
        return { success: false, output: null, error: "Empty pipe segments are not allowed" };
      }

      try {
        tokens = validateScopedCommand(tokens, this.ctx.scopePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: msg };
      }

      tokenizedSegments.push(tokens);
    }

    const requestedCwd = args.cwd as string | undefined;
    const timeout = (args.timeout as number) ?? 30_000;
    const cwd = resolveScopedPath(this.ctx.scopePath, requestedCwd ?? ".");

    // Dependency-audit lockfile reconciliation (0#tool-reliability): an
    // `npm audit` on a pnpm/yarn repo ENOLOCKs. Detect the real package
    // manager from the lockfile and either redirect to the matching audit or
    // skip non-fatally when no lockfile exists.
    let auditNote: string | undefined;
    const auditResolution = resolveDependencyAuditCommand(tokenizedSegments, cwd);
    if (auditResolution.kind === "skip") {
      this.recordToolHealth({
        tool: "run_command",
        category: "wrong-lockfile",
        message: auditResolution.message,
        remedy: auditResolution.remedy,
      });
      return {
        success: true,
        output: { skipped: true, reason: auditResolution.message },
      };
    }
    if (auditResolution.kind === "run") {
      tokenizedSegments[0] = auditResolution.tokens;
      if (auditResolution.redirectedFrom) {
        auditNote = auditResolution.note;
        this.recordToolHealth({
          tool: "run_command",
          category: "wrong-lockfile",
          message: `'${auditResolution.redirectedFrom} audit' redirected to '${auditResolution.tokens[0]} audit' (repo lockfile is ${auditResolution.tokens[0]}).`,
          remedy: `run '${auditResolution.tokens[0]} audit' directly to match the repo's lockfile.`,
        });
      }
    }

    try {
      const startedAt = Date.now();
      const result = executePipeline(tokenizedSegments, cwd, timeout, (input) =>
        this.recordToolHealth(input),
      );
      const durationMs = Date.now() - startedAt;
      // Display-only command-card sidecar (never seen by the model). Only when
      // there is a textual body to show: a `skipped`/object output stays a
      // plain tool line rather than an empty card.
      const stdout =
        typeof result.output === "string"
          ? result.output
          : result.success
            ? undefined
            : result.error;
      const commandMeta =
        stdout !== undefined
          ? {
              kind: "command" as const,
              command,
              exitCode: result.success ? 0 : 1,
              durationMs,
              timeoutMs: timeout,
              timedOut: false,
              stdout,
            }
          : undefined;
      // Prepend the redirect note so the agent sees WHY the executable changed.
      if (auditNote && result.success && typeof result.output === "string") {
        return {
          ...result,
          output: `${auditNote}\n${result.output}`,
          ...(commandMeta ? { meta: { ...commandMeta, stdout: `${auditNote}\n${result.output}` } } : {}),
        };
      }
      return commandMeta ? { ...result, meta: commandMeta } : result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordToolHealth({
        tool: "run_command",
        category: "error",
        message: `'${tokenizedSegments[0]?.[0] ?? "command"}' failed: ${msg.slice(0, 200)}`,
      });
      return { success: false, output: null, error: msg.slice(0, 2_000) };
    }
  }

  // ── PTY session management (feature-gated) ──

  private ensurePtyManager(): PtySessionManager {
    if (!this._ptyManager) {
      this._ptyManager = new PtySessionManager();
    }
    return this._ptyManager;
  }

  private async ptySession(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.ptySession) {
      return { success: false, output: null, error: "pty_session is disabled. Set ZERO_FEATURE_PTY_SESSION=1 to enable." };
    }

    const action = (args.action as string ?? "").trim();
    const sessionName = (args.session_name as string ?? "").trim();
    const input = args.input as string ?? "";
    const timeout = (args.timeout as number) ?? 5000;

    const mgr = this.ensurePtyManager();

    try {
      switch (action) {
        case "create": {
          if (!sessionName) {
            return { success: false, output: null, error: "session_name is required for create action." };
          }
          const session = mgr.createSession(sessionName, {
            env: { TARGET: this.ctx.target, ...this.buildAuthEnvVars() },
          });
          // Wait briefly for the shell prompt to appear
          const initialOutput = await mgr.read(session.id, 1000);
          return {
            success: true,
            output: `Session "${sessionName}" created (id: ${session.id}).\n${initialOutput}`,
          };
        }

        case "send": {
          if (!sessionName) {
            return { success: false, output: null, error: "session_name is required for send action." };
          }
          if (!input) {
            return { success: false, output: null, error: "input is required for send action." };
          }
          const session = mgr.findByName(sessionName);
          if (!session) {
            return { success: false, output: null, error: `No session named "${sessionName}" found.` };
          }
          // Drain any pending output first
          await mgr.read(session.id, 100);
          mgr.send(session.id, input);
          // Wait for response
          const output = await mgr.read(session.id, timeout);
          return { success: true, output: output || "(no output within timeout)" };
        }

        case "read": {
          if (!sessionName) {
            return { success: false, output: null, error: "session_name is required for read action." };
          }
          const session = mgr.findByName(sessionName);
          if (!session) {
            return { success: false, output: null, error: `No session named "${sessionName}" found.` };
          }
          const output = await mgr.read(session.id, timeout);
          return { success: true, output: output || "(no output within timeout)" };
        }

        case "close": {
          if (!sessionName) {
            return { success: false, output: null, error: "session_name is required for close action." };
          }
          const session = mgr.findByName(sessionName);
          if (!session) {
            return { success: false, output: null, error: `No session named "${sessionName}" found.` };
          }
          mgr.close(session.id);
          return { success: true, output: `Session "${sessionName}" closed.` };
        }

        case "list": {
          const sessions = mgr.listSessions();
          if (sessions.length === 0) {
            return { success: true, output: "No active sessions." };
          }
          const lines = sessions.map(
            (s) => `${s.name} (${s.id}) — ${s.alive ? "alive" : "dead"} — cwd: ${s.cwd}`
          );
          return { success: true, output: lines.join("\n") };
        }

        default:
          return { success: false, output: null, error: `Unknown pty_session action: "${action}". Use create, send, read, close, or list.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  // ── Python kernel (feature-gated, compute-only) ──

  private ensurePyKernel(): PythonKernelManager {
    if (!this._pyKernel) {
      this._pyKernel = new PythonKernelManager();
    }
    return this._pyKernel;
  }

  /**
   * `python_exec` (Phase-0): run code in a persistent, COMPUTE-ONLY Python
   * kernel. State persists across calls within a scan. Networking is blocked at
   * the socket source whenever an engagement scope / enforcement tracker is
   * configured, so `urllib` / `requests` / `http.client` fail closed — the
   * agent must use `http_request` for HTTP.
   */
  private async pythonExec(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.pythonExec) {
      return { success: false, output: null, error: "python_exec is disabled. Set ZERO_FEATURE_PYTHON_EXEC=1 to enable." };
    }

    const code = (args.code as string) ?? "";
    if (!code.trim()) {
      return { success: false, output: null, error: "code is required" };
    }

    // http_audit kill switch: refuse to start (and, below, to return) once the
    // wall-clock budget is exhausted.
    if (this.ctx.enforcement?.isKillExpired()) {
      return { success: false, output: null, error: "Kill switch expired — refusing to execute python_exec." };
    }

    // Per-call timeout clamp: default 30s, min 1s, max 120s.
    const rawTimeout = typeof args.timeout === "number" ? args.timeout : 30;
    const timeoutSec = Math.min(120, Math.max(1, rawTimeout));
    const timeoutMs = timeoutSec * 1_000;

    // EGRESS SAFETY: block networking whenever an authorized engagement is
    // active (scope or enforcement configured). This is the whole point of the
    // Phase-0 compute-only cut.
    const blockNet = Boolean(this.ctx.scope || this.ctx.enforcement);
    const mgr = this.ensurePyKernel();
    mgr.blockNetworking = blockNet;

    try {
      const session = mgr.ensureDefaultSession();
      if (args.reset === true) {
        mgr.reset(session.id);
      }

      const frame = await mgr.send(session.id, code, timeoutMs);

      // Intra-call kill-switch check: if the budget expired while executing,
      // discard the result rather than acting on stale work.
      if (this.ctx.enforcement?.isKillExpired()) {
        return { success: false, output: null, error: "Kill switch expired mid-execution — python_exec result discarded." };
      }

      const stdout = capText(frame.stdout, 10_000);

      if (frame.error) {
        const tail = tracebackTail(frame.traceback ?? frame.error);
        return {
          success: false,
          output: { stdout, stderr: frame.stderr },
          error: tail,
        };
      }

      const output: { stdout: string; value?: string; stderr?: string } = { stdout };
      if (frame.value != null) output.value = frame.value;
      if (frame.stderr) output.stderr = frame.stderr;
      return { success: true, output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  /**
   * `analyze_binary` is an explicit 0verse bridge. The agent may only submit a
   * regular file below its local source scope; the child receives the minimal
   * credential-free environment and 0verse keeps target execution disabled by
   * default.
   */
  private async analyzeBinary(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.zeroverse) {
      return {
        success: false,
        output: null,
        error: "analyze_binary is disabled. Set ZERO_FEATURE_ZEROVERSE=1 to enable.",
      };
    }
    if (isScopeEnforcementEnabled() && !this.ctx.scopePath) {
      return {
        success: false,
        output: null,
        error: "analyze_binary requires a local scoped source root.",
      };
    }

    const validated = validateOverseArgs(args);
    if (!validated.ok) {
      return { success: false, output: null, error: validated.error };
    }

    try {
      const binaryPath = resolveScopedPath(this.ctx.scopePath, validated.args.binary_path);
      if (!statSync(binaryPath).isFile()) {
        return { success: false, output: null, error: "analyze_binary requires a regular file." };
      }
      return await executeOverseScan({
        args: { ...validated.args, binary_path: binaryPath },
        env: sanitizedEnv(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: null, error: `analyze_binary refused: ${message}` };
    }
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
            if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url, 1, requestSignal);
            execution?.assertAuthority?.();
            const response = await fetchScoped(url, { ...init, signal: requestSignal, redirect: "error" }, {
              baseUrl: "https://mcp.parallel.ai", timeoutMs: 10_000,
              validateUrl: () => execution?.assertAuthority?.(),
            });
            this.ctx.rateLimiter?.noteResponse(url, response);
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
        if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(url, 1, signal);
        execution?.assertAuthority?.();
        const res = await fetchScoped(url, {
          headers: { "User-Agent": "0/1.0" }, signal, redirect: "follow",
        }, {
          baseUrl: "https://html.duckduckgo.com", timeoutMs: 15_000,
          validateUrl: () => execution?.assertAuthority?.(),
        });
        this.ctx.rateLimiter?.noteResponse(url, res);
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

  // 0#1284 — intel handler bodies extracted to ./tools/intel.ts as free
  // functions; these stay as thin delegates so tools/dispatch.test.ts keeps
  // resolving each tool name to a real ToolExecutor method.
  private intelTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeIntel(this.ctx, args);
  }
  private jevPrepassTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeJevPrepass(this.ctx, args);
  }


  // ── Offline / read-only security engines (dev-live-engine-recovery) ──
  // Thin delegates to the free-function handlers in tools/security-engines.ts,
  // mirroring the intelTool → executeIntel shape (0#1284).
  private adAttackPathsTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeAdAttackPaths(this.ctx, args);
  }

  private entraAttackPathsTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeEntraAttackPaths(this.ctx, args);
  }

  private entraPostureTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeEntraPosture(this.ctx, args);
  }

  private assembleAdvisoryTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeAssembleAdvisory(this.ctx, args);
  }

  private cveLookupTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeCveLookup(this.ctx, args);
  }

  // ── Phase-2 offensive / active security engines (dev-live-engine-recovery) ──
  // Thin delegates to the free-function handlers in tools/offensive-engines.ts.
  // GROUP 1 offline (variant/assumption/fix); GROUP 2 scope-gated (verify /
  // protocol / spec / safety); GROUP 3 feature-flag + scope gated (memsafety /
  // npm / kernel / cve). The handlers re-check every gate (defense-in-depth).
  private variantHuntTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeVariantHunt(this.ctx, args);
  }

  private assumptionHuntTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeAssumptionHunt(this.ctx, args);
  }

  private generateFixTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeGenerateFix(this.ctx, args);
  }

  private verifyFindingTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeVerifyFinding(this.ctx, args);
  }

  private protocolConformanceTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeProtocolConformance(this.ctx, args);
  }

  private specDriftTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSpecDrift(this.ctx, args);
  }

  private safetyEvalTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSafetyEval(this.ctx, args);
  }

  private memsafetyFuzzTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeMemsafetyFuzz(this.ctx, args);
  }

  private npmDynamicDiscoveryTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeNpmDynamicDiscovery(this.ctx, args);
  }

  private weaponizeKernelTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeWeaponizeKernel(this.ctx, args);
  }

  private cveAdaptTool(args: Record<string, unknown>): Promise<ToolResult> {
    return executeCveAdapt(this.ctx, args);
  }

  private updateTarget(args: Record<string, unknown>): ToolResult {
    if (args.type) this.ctx.targetInfo.type = args.type as TargetInfo["type"];
    if (args.model) this.ctx.targetInfo.model = args.model as string;
    if (args.system_prompt) this.ctx.targetInfo.systemPrompt = args.system_prompt as string;
    if (args.endpoints) {
      try {
        this.ctx.targetInfo.endpoints = JSON.parse(args.endpoints as string);
      } catch {
        /* ignore parse errors */
      }
    }
    if (args.features) {
      try {
        this.ctx.targetInfo.detectedFeatures = JSON.parse(args.features as string);
      } catch {
        /* ignore parse errors */
      }
    }

    if (this.db) {
      this.db.upsertTarget({
        url: this.ctx.target,
        type: this.ctx.targetInfo.type ?? "unknown",
        ...this.ctx.targetInfo,
      } as TargetInfo);
    }

    return { success: true, output: { message: "Target profile updated", target: this.ctx.targetInfo } };
  }

  // ── WordPress fingerprinter (feature-gated) ──

  private async wpFingerprint(args: Record<string, unknown>): Promise<ToolResult> {
    if (!featureFlags.wpFingerprint) {
      return {
        success: false,
        output: null,
        error:
          "wp_fingerprint is disabled. Enable with --features wp_fingerprint or ZERO_FEATURE_WP_FINGERPRINT=1.",
      };
    }

    // Same-origin enforcement: only probe the scan target.
    const base = validateTargetUrl(this.ctx.target, this.ctx.target, this.ctx.scope, undefined, this.ctx.publicNetwork);

    // Build an auth-aware fetch wrapper that reuses the active identity's
    // credentials + captured session cookies (0#564).
    const authHeaders = this.activeAuthHeaders();
    const scope = this.ctx.scope;
    const rateLimiter = this.ctx.rateLimiter;
    const attribution = this.ctx.attribution;
    const wrappedFetch: FetchLike = async (url, init) => {
      // Scope check (0#215). runWpFingerprint walks the WP plugin
      // namespace by appending paths to `target`; under same-origin that
      // can't escape the host, but if the host itself is out-of-scope —
      // e.g. operator passed --scope without including the WP target —
      // we refuse here rather than fetching anyway.
      if (scope) {
        const verdict = scope.enforce(url)
        if (!verdict.allowed) {
          throw new Error(`wp_fingerprint scope violation: ${verdict.reason}`);
        }
      }
      const headers = {
        ...authHeaders,
        ...(init?.headers ?? {}),
      };
      // Attribution-header injection (0#216). wp_fingerprint runs
      // dozens of plugin probes in a tight loop, so attribution on
      // every probe is what tells defenders this is engagement traffic
      // rather than a botnet pulling /wp-content/plugins/* paths.
      const fetchInit = applyAttribution(
        url,
        { method: init?.method ?? "GET", headers, body: init?.body },
        attribution,
        scope,
      )!;
      // Every hop is authorized and DNS-pinned before acquiring its socket.
      const res = await this.fetchTarget(
        url,
        { ...fetchInit, redirect: "follow" },
        rateLimiter ? hop => rateLimiter.acquire(hop) : undefined,
      );
      if (rateLimiter) rateLimiter.noteResponse(res.url, res);
      return {
        ok: res.ok,
        status: res.status,
        text: () => res.text(),
        json: () => res.json(),
      };
    };
    const advisoryFetch: FetchLike = async (url, init) => {
      const origin = new URL(url).origin;
      if (origin !== "https://api.osv.dev" && origin !== "https://wpscan.com" &&
          origin !== "https://www.wpvulnerability.net") {
        throw new Error("Unknown WordPress advisory service");
      }
      const execution = this._executionContext.getStore();
      // Advisory credentials belong only to their fixed service. Target auth,
      // attribution and target allow rules never flow into this transport.
      const response = await fetchScoped(url, {
        ...init, signal: execution?.signal, redirect: "follow",
      }, {
        baseUrl: origin,
        timeoutMs: 10_000,
        validateUrl: () => execution?.assertAuthority?.(),
        beforeRequest: rateLimiter ? hop => rateLimiter.acquire(hop) : undefined,
      });
      rateLimiter?.noteResponse(response.url, response);
      return response;
    };

    try {
      const result = await runWpFingerprint({
        target: base,
        fetchImpl: wrappedFetch,
        advisoryFetchImpl: advisoryFetch,
        maxPluginProbes: (args.max_plugin_probes as number) ?? 40,
        maxVulnerablePluginProbes: (args.max_vulnerable_plugin_probes as number) ?? 40,
        skipOsv: (args.skip_osv as boolean) ?? false,
        wpScanApiToken: (args.wpscan_api_token as string | undefined)
          ?? process.env.WPSCAN_API_TOKEN
          ?? process.env["ZERO_WPSCAN_API_TOKEN"],
      });
      return {
        success: true,
        output: {
          summary: summarizeWpFingerprint(result),
          result,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  // ── Engagement-gated structured scanner wrappers (0#555) ──
  //
  // Shared glue for run_sqlmap / run_nmap / run_ffuf / run_nuclei. Each public
  // method validates the target against scope, acquires a rate-limit token,
  // builds a SAFE argv (delegated to the pure builders in scanner-tools.ts),
  // runs the binary under the wallclock ceiling (partial output on timeout),
  // parses stdout into a normalized result, emits a `scanner_tool_run` event,
  // and returns structured output + save_finding-ready evidence. Never raw
  // blobs back to the model.

  /**
   * Common preflight for every scanner wrapper — the authorized-engagement
   * profile gate (0#926). Delegates the allow/deny decision to the pure
   * `scannerEngagementGate`, which enforces, in order:
   *   - ctx.allowScanners must be true (defense-in-depth; the tool is also
   *     absent from the tool set otherwise — see getToolsForRole);
   *   - an engagement scope policy MUST be present (deny-by-default — an
   *     authorized engagement is always explicitly scoped);
   *   - the per-invocation target host is in scope, its path is in the
   *     http_audit path allowlist (when one is set), and the wall-clock kill
   *     switch has not fired.
   * On a pass we acquire a per-host rate-limit token (best-effort; see the
   * subprocess gap note in scanner-tools.ts). Returns an error ToolResult to
   * short-circuit, or null to proceed.
   */
  private async scannerPreflight(
    tool: string,
    scopeUrl: string,
  ): Promise<ToolResult | null> {
    const verdict = scannerEngagementGate(tool, scopeUrl, {
      allowScanners: this.ctx.allowScanners,
      scope: this.ctx.scope,
      enforcement: this.ctx.enforcement,
    });
    if (!verdict.allowed) {
      if (verdict.countsAsBlocked) this.ctx.enforcement?.noteOutOfScopeBlocked();
      this.recordToolHealth({
        tool,
        category: "scope-denied",
        message: verdict.reason,
        remedy: "confirm the target is in the engagement scope and run with --allow-scanners.",
      });
      return { success: false, output: null, error: verdict.reason };
    }
    if (this.ctx.rateLimiter) await this.ctx.rateLimiter.acquire(scopeUrl);
    return null;
  }

  /**
   * Run a scanner binary under the bash wallclock ceiling and parse its
   * stdout. Shapes the structured ToolResult, emits the scanner_tool_run
   * event, and projects save_finding-ready evidence. `timeoutSec` is the
   * caller-requested wallclock, clamped to the ceiling inside runScannerProcess.
   */
  private async executeScanner(
    tool: string,
    binary: string,
    argv: string[],
    parse: (raw: string) => ScannerParsedResult,
    timeoutSec: unknown,
  ): Promise<ToolResult> {
    const ceilingMs = resolveBashWallclockCeilingMs();
    const requestedMs = Math.max(1, ((timeoutSec as number) ?? 90) * 1000);
    const env = { ...sanitizedEnv(), TARGET: this.ctx.target };

    const outcome = await runScannerProcess(binary, argv, {
      timeoutMs: requestedMs,
      ceilingMs,
      env,
    });

    if (outcome.kind === "error") {
      this.persistToolArtifact("scanner_tool_run", {
        scanner: tool,
        binary,
        argv,
        error: outcome.message,
        durationMs: outcome.durationMs,
      });
      // ENOENT → the binary isn't installed on this runner. Graceful skip: a
      // clear "not installed — skipping (install: …)" result that does NOT
      // count as a hard failure, plus a missing-binary tool-health event, so
      // the operator sees WHY the scanner didn't run and how to fix it.
      if (/ENOENT|not found/i.test(outcome.message)) {
        const install = SCANNER_INSTALL_HINTS[binary];
        this.recordToolHealth({
          // Attribute to the missing BINARY (what the operator installs), so the
          // summary reads "missing: nuclei, sqlmap" rather than the tool name.
          tool: binary,
          category: "missing-binary",
          message: `'${binary}' is not installed on this runner — skipping ${tool}.`,
          ...(install ? { remedy: `install: ${install}` } : {}),
        });
        return {
          success: true,
          output: {
            skipped: true,
            scanner: tool,
            reason: `'${binary}' not installed — skipping.`,
            ...(install ? { install } : {}),
          },
        };
      }
      // Any other spawn failure is a genuine error.
      this.recordToolHealth({
        tool,
        category: "error",
        message: `${tool} failed: ${outcome.message}`.slice(0, 300),
      });
      return {
        success: false,
        output: null,
        error: `${tool} failed: ${outcome.message}`,
      };
    }

    const raw =
      outcome.kind === "timeout" ? outcome.partial : outcome.combined;
    const exitCode = outcome.kind === "exit" ? outcome.exitCode : null;
    const timedOut = outcome.kind === "timeout";
    const result = parse(raw);
    const stats: ScannerRunStats = {
      binary,
      argv,
      durationMs: outcome.durationMs,
      timedOut,
      exitCode,
    };
    const suggested = suggestedFindingsFor(result, stats);

    this.persistToolArtifact("scanner_tool_run", {
      scanner: tool,
      binary,
      argv,
      exitCode,
      timedOut,
      durationMs: outcome.durationMs,
      summary: summarizeScannerResult(result),
      suggestedFindings: suggested.length,
    });

    return {
      success: true,
      output: {
        summary:
          summarizeScannerResult(result) +
          (timedOut ? " [PARTIAL — wallclock ceiling hit]" : ""),
        timed_out: timedOut,
        exit_code: exitCode,
        result,
        // save_finding-ready projections (the agent decides whether to save;
        // we never auto-save — operator gate + false-positive discipline).
        finding_evidence: suggested,
      },
    };
  }

  /** `run_scanner` — route to the right scanner by `tool` (handlers unchanged). */
  private async runScanner(args: Record<string, unknown>): Promise<ToolResult> {
    const tool = String(args.tool ?? "").trim();
    switch (tool) {
      case "sqlmap":
        return this.runSqlmap(args);
      case "nmap":
        return this.runNmap(args);
      case "ffuf":
        return this.runFfuf(args);
      case "nuclei":
        return this.runNuclei(args);
      default:
        return { success: false, output: null, error: `run_scanner: unknown tool "${tool}" — use sqlmap|nmap|ffuf|nuclei` };
    }
  }

  private async runSqlmap(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url ?? "");
    if (!url) {
      return { success: false, output: null, error: "run_sqlmap requires a 'url'." };
    }
    const pre = await this.scannerPreflight("run_sqlmap", url);
    if (pre) return pre;
    const argv = buildSqlmapArgv({
      url,
      data: typeof args.data === "string" ? args.data : undefined,
      level: args.level as number | undefined,
      risk: args.risk as number | undefined,
      technique: typeof args.technique === "string" ? args.technique : undefined,
      dbms: typeof args.dbms === "string" ? args.dbms : undefined,
      enumerateDbs: args.enumerate_dbs === true,
      dump: args.dump === true,
      threads: args.threads as number | undefined,
    });
    return this.executeScanner("run_sqlmap", "sqlmap", argv, parseSqlmapOutput, args.timeout);
  }

  private async runNmap(args: Record<string, unknown>): Promise<ToolResult> {
    const target = String(args.target ?? "");
    if (!target) {
      return { success: false, output: null, error: "run_nmap requires a 'target'." };
    }
    // nmap takes a bare host; build a URL purely for the scope check.
    const scopeUrl = /^https?:\/\//i.test(target) ? target : `http://${target}`;
    const pre = await this.scannerPreflight("run_nmap", scopeUrl);
    if (pre) return pre;
    const argv = buildNmapArgv({
      target,
      ports: typeof args.ports === "string" ? args.ports : undefined,
      serviceDetection: args.service_detection === true,
      topPorts: args.top_ports as number | undefined,
      skipPing: args.skip_ping as boolean | undefined,
    });
    return this.executeScanner("run_nmap", "nmap", argv, parseNmapOutput, args.timeout);
  }

  private async runFfuf(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args.url ?? "");
    const wordlist = String(args.wordlist ?? "");
    if (!url || !wordlist) {
      return {
        success: false,
        output: null,
        error: "run_ffuf requires 'url' (with a FUZZ keyword) and 'wordlist'.",
      };
    }
    if (!url.includes("FUZZ")) {
      return {
        success: false,
        output: null,
        error: "run_ffuf: 'url' must contain a FUZZ keyword, e.g. http://host/FUZZ.",
      };
    }
    const pre = await this.scannerPreflight("run_ffuf", url);
    if (pre) return pre;
    const argv = buildFfufArgv({
      url,
      wordlist,
      matchStatus: typeof args.match_status === "string" ? args.match_status : undefined,
      threads: args.threads as number | undefined,
    });
    return this.executeScanner("run_ffuf", "ffuf", argv, parseFfufOutput, args.timeout);
  }

  private async runNuclei(args: Record<string, unknown>): Promise<ToolResult> {
    const target = String(args.target ?? "");
    if (!target) {
      return { success: false, output: null, error: "run_nuclei requires a 'target'." };
    }
    const scopeUrl = /^https?:\/\//i.test(target) ? target : `http://${target}`;
    const pre = await this.scannerPreflight("run_nuclei", scopeUrl);
    if (pre) return pre;
    const argv = buildNucleiArgv({
      target,
      severity: typeof args.severity === "string" ? args.severity : undefined,
      tags: typeof args.tags === "string" ? args.tags : undefined,
    });
    return this.executeScanner("run_nuclei", "nuclei", argv, parseNucleiOutput, args.timeout);
  }

  private payloadLookup(args: Record<string, unknown>): ToolResult {
    const name = String(args.name ?? "");
    if (name === "jsfuck_alert") {
      return {
        success: true,
        output: {
          name,
          payload: JSFUCK_ALERT_PAYLOAD,
          description: "JSFuck-encoded alert(1) using only []()!+",
          emits: "1",
          bestFor: "Generic JavaScript execution proof when any alert is sufficient",
          avoidWhen: "The target checks for an exact required dialog/output string such as XSS",
        },
      };
    }
    if (name === "jsfuck_xss") {
      return {
        success: true,
        output: {
          name,
          payload: JSFUCK_XSS_PAYLOAD,
          description: "JSFuck-encoded alert('XSS') using only []()!+",
          emits: "XSS",
          bestFor: "Exact-output validators that require the dialog or script result to equal XSS",
          avoidWhen: "Only generic JS execution proof is needed and payload length matters more than exact output",
        },
      };
    }
    return {
      success: false,
      output: null,
      error: `Unknown payload: ${name}. Valid: jsfuck_alert, jsfuck_xss`,
    };
  }

  // ── MongoDB ObjectID forge (feature-gated, default ON) ──

  private mongoObjectIdForge(args: Record<string, unknown>): ToolResult {
    if (!featureFlags.mongoObjectIdForge) {
      return {
        success: false,
        output: null,
        error:
          "mongo_objectid is disabled. Enable with --features mongo_objectid_forge or ZERO_FEATURE_MONGO_OBJECTID_FORGE=1.",
      };
    }

    try {
      const timestamp = args.timestamp as number;
      const machineId = args.machineId as string;
      const counter = (args.counter as number) ?? 0;
      const count = (args.count as number | undefined) ?? 1;

      if (count <= 1) {
        const oid = forgeObjectId({ timestamp, machineId, counter });
        const parsed = parseObjectId(oid);
        return {
          success: true,
          output: {
            objectId: oid,
            components: parsed,
            hint: "Paste this 24-char hex string in place of any ObjectId in the target's URL/body to test IDOR. For the 'first user', try counter=0, then 1, 2, ...",
          },
        };
      }

      const sequence = forgeObjectIdSequence({
        timestamp,
        machineId,
        counterStart: counter,
        count,
      });
      return {
        success: true,
        output: {
          objectIds: sequence,
          count: sequence.length,
          counterStart: counter,
          counterEnd: counter + sequence.length - 1,
          hint: `Forged ${sequence.length} consecutive ObjectIds (counters ${counter}..${counter + sequence.length - 1}). Try them in order to enumerate IDOR victims.`,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: msg };
    }
  }

  // ── JIT Skill tools (#457) ──

  /**
   * Lazily load and cache the cloud audit-skills bundle from the
   * ZERO_AUDIT_SKILLS_MANIFEST environment variable. Returns null when
   * the env var is unset (no cloud skills configured); returns an empty
   * Map for valid manifests with zero skills; returns the loaded Map for
   * a populated bundle. Cache lives for the lifetime of this ToolExecutor.
   */
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

  private readSkill(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSkillAuthoring("read", args, typeof this.ctx.skillAuthoring === "function" ? this.ctx.skillAuthoring() : this.ctx.skillAuthoring);
  }

  private createSkill(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSkillAuthoring("create", args, typeof this.ctx.skillAuthoring === "function" ? this.ctx.skillAuthoring() : this.ctx.skillAuthoring);
  }

  private saveSkill(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSkillAuthoring("update", args, typeof this.ctx.skillAuthoring === "function" ? this.ctx.skillAuthoring() : this.ctx.skillAuthoring);
  }

  private copySkill(args: Record<string, unknown>): Promise<ToolResult> {
    return executeSkillAuthoring("copy", args, typeof this.ctx.skillAuthoring === "function" ? this.ctx.skillAuthoring() : this.ctx.skillAuthoring);
  }

  private listSkills(args: Record<string, unknown>): ToolResult {
    const tag = typeof args.tag === "string" ? args.tag : undefined;
    const summaries = listSkillSummaries({ tag, role: this.ctx.role });
    const discovered = discoverAgentSkills({
      projectRoot: this.ctx.workspaceRoot ?? this.ctx.scopePath,
      ...(typeof this.ctx.skillDiscoveryOptions === "function" ? this.ctx.skillDiscoveryOptions() : this.ctx.skillDiscoveryOptions),
    });
    const folderSummaries = discovered.skills.filter((skill) => !tag || skill.tags.includes(tag)).map((skill) => ({
      id: skill.id, name: skill.name, description: skill.description, tags: skill.tags,
      estimated_tokens: skill.estimated_tokens, suggested: false, source: skill.source,
    }));

    // Merge cloud audit skills from env manifest if configured
    const cloudBundle = this.ensureCloudSkillBundle();
    const cloudSummaries = cloudBundle
      ? [...cloudBundle.values()].map((s) => ({
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
      return { success: false, output: null, error: "skill_id is required" };
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
        error: `Unknown skill ID: "${skillId}". Use list_skills to see available skills.`,
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

    return {
      success: true,
      output: {
        kind: "skill_loaded",
        skill_id: skill.id,
        name: skill.name,
        estimated_tokens: skill.estimated_tokens,
        content: skill.content,
      },
    };
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

  private markDone(args: Record<string, unknown>): ToolResult {
    const summary = (args.summary as string) ?? "Task completed";

    // ── Coverage gate (#audit-laziness) ──
    // For audit / review sub-agents auditing a local source tree, refuse a
    // `done` call when the agent has not actually inspected source. The
    // gate is scoped to (role ∈ {audit,review}) AND a non-empty scopePath
    // — that's the package-audit / source-review shape from the
    // @vercel/og bug. Audit-role flag-hunting (no scopePath) is skipped
    // because there's no local source to read; the agent is talking to a
    // remote target. See `evaluateDoneCoverageGate` for the policy and
    // `ZERO_AUDIT_MIN_COVERAGE_FILES` / `ZERO_AUDIT_DONE_GATE` for
    // operator overrides.
    const isSourceAudit =
      (this.ctx.role === "audit" || this.ctx.role === "review")
      && typeof this.ctx.scopePath === "string"
      && this.ctx.scopePath.length > 0
      && (!!getLocalSourceBoundary() || !this.ctx.consoleSession || !/^https?:\/\//i.test(this.ctx.target));
    if (isSourceAudit && !this.ctx.diffScopedReview) {
      const decision = evaluateDoneCoverageGate({
        sourceFilesRead: this._sourceFilesRead.size,
        totalToolCalls: this._totalNonDoneToolCalls,
        elapsedMs: Date.now() - this._startedAt,
        priorRejections: this._doneRejections,
      });
      if (!decision.pass) {
        this._doneRejections += 1;
        return {
          success: false,
          output: null,
          error: decision.reason ?? "done rejected: insufficient audit coverage",
        };
      }
    }

    // ── Anti-honeypot heuristic (GitHub #82) ──
    // Scan the summary for a FLAG{...} token; if one is present and the
    // decoyDetection feature is enabled, validate its shape. Low-confidence
    // flags (looks like a decoy: sentence content, "DECOY"/"FAKE" markers,
    // too short, too long) are rejected once with a hint. A second call with
    // the same flag passes through.
    if (featureFlags.decoyDetection) {
      const flagMatch = summary.match(/FLAG\{[^}]*\}/i);
      if (flagMatch) {
        const proposedFlag = flagMatch[0];
        const validation = validateFlagShape(proposedFlag);
        if (!validation.ok && !this._rejectedDecoyFlags.has(proposedFlag)) {
          this._rejectedDecoyFlags.add(proposedFlag);
          return {
            success: false,
            output: null,
            error:
              `The flag \`${proposedFlag}\` has low shape confidence ` +
              `(${validation.confidence.toFixed(2)}) — looks like a decoy. ` +
              `${validation.reason} ` +
              `Continue exploring for at least one more layer; defenders sometimes plant ` +
              `fake flags in obvious locations (e.g. the first file a naive LFI exploit ` +
              `lands on). Verify the shape matches the suite's expected format (typically ` +
              `hex/uuid). If you genuinely cannot find another candidate, retry \`done\` ` +
              `with the same flag and it will be accepted.`,
          };
        }
      }
    }

    return {
      success: true,
      output: { done: true, summary },
    };
  }
}

// ── Helper: get tools for a specific agent role ──

export function getToolsForRole(role: string, opts?: { hasScope?: boolean; webMode?: boolean; hasBrowser?: boolean; allowScanners?: boolean; webSearchEnabled?: boolean }): ToolDefinition[] {
  const authorized = !isScopeEnforcementEnabled() || opts?.hasScope === true;
  // `update_todos` (structured full-state plan) is offered to every role: it
  // authorizes nothing and only records the model's declared plan. The
  // `write_todos` alias stays registered/dispatchable but out of the advertised
  // sets so only one name is offered (see allEnabledTools filter below).
  const common = ["query_findings", "update_todos", "done"];
  const browserTools = opts?.hasBrowser ? ["browser"] : [];
  const webSearchTools = (opts?.webSearchEnabled ?? featureFlags.webSearch) ? ["web_search"] : [];
  const ptyTools = featureFlags.ptySession ? ["pty_session"] : [];
  // Phase-0 persistent compute-only Python kernel, opt-in (default off).
  const pythonTools = featureFlags.pythonExec ? ["python_exec"] : [];
  // Binary analysis remains opt-in and is only offered to local verification/audit
  // roles; it is never a generic network-scanner capability.
  const binaryTools = featureFlags.zeroverse ? [...BINARY_TOOL_NAMES] : [];
  const payloadTools = ["payload_lookup"];
  const wpTools = featureFlags.wpFingerprint ? ["wp_fingerprint"] : [];
  const mongoTools = featureFlags.mongoObjectIdForge ? ["mongo_objectid"] : [];
  const methodologyTools = ["list_skills", "load_skill"];
  const skillTools = [...methodologyTools, "read_skill", "create_skill", "save_skill", "copy_skill"];
  // 0#567 — loot retrieval tool, only when the ledger feature is on.
  const lootTools = featureFlags.lootLedger ? ["use_loot"] : [];
  // Typed TODO ledger — the `plan` tool, only when the feature is on.
  const planTools = featureFlags.agentPlan ? ["plan"] : [];
  // 0#555: scanner wrappers only when the engagement explicitly permits
  // generic-scanner traffic. Default-off preserves 0#217 stealth.
  const scannerTools = opts?.allowScanners ? [...SCANNER_TOOL_NAMES] : [];
  // 0#925: live cloud-surface tools (S3 public/takeover + read-only cred
  // validation), gated behind the cloud-surface feature flag (default on).
  const cloudTools = featureFlags.cloudSurface ? [...CLOUD_TOOL_NAMES] : [];
  // #659 — OAST out-of-band interaction tools, opt-in (default off; inert
  // without a deployed collaborator). Confirm blind SSRF/XSS, OOB RCE/SQLi.
  const oastTools = featureFlags.oastCollaborator ? [...OAST_TOOL_NAMES] : [];
  // Scope authorization gates tool availability only while its plugin is active.
  const offensiveScopedTools = authorized ? [...OFFENSIVE_SCOPED_TOOL_NAMES] : [];
  // Phase-2 GROUP 3: engines that RUN/BUILD untrusted code or weaponize.
  // Deny-by-default — each needs its named feature flag AND an active scope
  // (ZERO_FEATURE_CLOUD_SURFACE parity). weaponize_kernel / cve_adapt add a
  // runtime kernel-VM-artifact check in their handlers on top of this.
  const memsafetyTools = featureFlags.memsafetyFuzz && authorized ? [...MEMSAFETY_TOOL_NAMES] : [];
  const npmDiscoveryTools = featureFlags.npmDynamicDiscovery && authorized ? [...NPM_DISCOVERY_TOOL_NAMES] : [];
  const kernelWeaponizeTools = featureFlags.kernelWeaponize && authorized ? [...KERNEL_WEAPONIZE_TOOL_NAMES] : [];
  const cveAdaptTools = featureFlags.cveAdapt && authorized ? [...CVE_ADAPT_TOOL_NAMES] : [];
  const networkTools = [
    "http_request",
    "crawl",
    "submit_form",
    "access_control_probe",
    "access_control_workflow",
    "access_control_cleanup",
    "bash",
    // js_eval / python_eval are thin, effectful wrappers over the same guarded
    // shellExec path as bash — advertised to the network roles alongside it,
    // and (like bash) NOT part of the read-only scoped-source-audit set.
    "js_eval",
    "python_eval",
    ...browserTools,
    ...webSearchTools,
    ...ptyTools,
    ...pythonTools,
    ...payloadTools,
    ...wpTools,
    ...mongoTools,
    ...skillTools,
    ...lootTools,
    ...planTools,
    ...scannerTools,
    ...cloudTools,
    ...oastTools,
    ...offensiveScopedTools,
    ...memsafetyTools,
    ...npmDiscoveryTools,
    ...kernelWeaponizeTools,
    ...cveAdaptTools,
    "send_prompt",
    "save_finding",
    "update_finding",
    "update_target",
    ...common,
  ];
  const fileTools = ["read_file", "str_replace", "apply_patch", "run_command", ...binaryTools];
  const allEnabledTools = Object.keys(TOOL_DEFINITIONS).filter((name) =>
    // Keep use_loot out of the audit/review "everything" set when the loot
    // ledger feature is off.
    (featureFlags.lootLedger || name !== "use_loot")
    // The `plan` tool follows the same gating: out of the audit/review
    // "everything" set when the plan ledger feature is off.
    && (featureFlags.agentPlan || name !== "plan")
    // Scanner wrappers stay out of the audit/review "everything" set too,
    // unless the engagement opted in. Without this they'd leak into
    // allEnabledTools regardless of allowScanners (regression of 0#217).
    && (opts?.allowScanners || !SCANNER_TOOL_NAMES.includes(name))
    // Cloud-surface tools follow the same gating: out of the audit/review
    // "everything" set when the feature flag is off (0#925).
    && (featureFlags.cloudSurface || !CLOUD_TOOL_NAMES.includes(name))
    // #659 — OAST tools stay out of the audit/review "everything" set unless the
    // collaborator feature is on (parity with the gating above).
    && (featureFlags.oastCollaborator || !OAST_TOOL_NAMES.includes(name))
    // Phase-0 python_exec stays out unless pythonExec is on.
    && (featureFlags.pythonExec || name !== "python_exec")
    // 0verse execution is opt-in and path-confined by the executor.
    && (featureFlags.zeroverse || !BINARY_TOOL_NAMES.includes(name as (typeof BINARY_TOOL_NAMES)[number]))
    // web_search / pty_session are feature-gated everywhere else (networkTools
    // honors their flags), but leaked into the audit/review "everything" set
    // because this filter forgot them — inflating the default console from 38 to
    // 40 advertised tools. Gate them here too so the count matches the flags.
    && ((opts?.webSearchEnabled ?? featureFlags.webSearch) || name !== "web_search")
    && (featureFlags.ptySession || name !== "pty_session")
    // `write_todos` is a dispatchable ALIAS of `update_todos` — keep it out of
    // the audit/review "everything" set so only one plan tool is advertised.
    && name !== "write_todos"
    // `self_extend` is registered + dispatchable, but is NEVER advertised by
    // role. It is a runtime-gated capability (`allowModelSelfExtension`, default
    // OFF), not a feature flag, so native-loop injects it into the model-facing
    // tool set explicitly when enabled — it must never leak in by omission here.
    && name !== "self_extend" && name !== "remember_codebase"
    // burp-network-20260913 — the intercepting `proxy` tool is registered +
    // dispatchable + unit-tested, but NOT YET advertised by any role. It is a
    // powerful effectful capability (a local MITM proxy + a generated CA); like
    // OAST/cloud/fan-out it must reach the model behind an explicit opt-in
    // feature flag once the transport backend lands (WIRING TODO: add a
    // `featureFlags.proxy` gate + `"proxy"` to networkTools). Excluded by
    // omission here so it never leaks into the audit/review "everything" set.
    && name !== "proxy"
    // Feature/resource/sandbox gates remain independent of authorization.
    && (authorized || !OFFENSIVE_SCOPED_TOOL_NAMES.includes(name))
    && ((featureFlags.memsafetyFuzz && authorized) || !MEMSAFETY_TOOL_NAMES.includes(name))
    && ((featureFlags.npmDynamicDiscovery && authorized) || !NPM_DISCOVERY_TOOL_NAMES.includes(name))
    && ((featureFlags.kernelWeaponize && authorized) || !KERNEL_WEAPONIZE_TOOL_NAMES.includes(name))
    && ((featureFlags.cveAdapt && authorized) || !CVE_ADAPT_TOOL_NAMES.includes(name)),
  );
  const scopedSourceTools = Object.keys(SCOPED_SOURCE_AUDIT_TOOLS).filter((name) =>
    name !== "remember_codebase" && (featureFlags.zeroverse || name !== "analyze_binary"),
  );
  const roleTools: Record<string, string[]> = {
    discovery: networkTools,
    attack: networkTools,
    // Verify agent gets file tools when there's a local scope (audit/review mode)
    verify: authorized ? [...networkTools, ...fileTools] : networkTools,
    report: [...common, ...methodologyTools],
    audit: opts?.hasScope ? scopedSourceTools : allEnabledTools,
    review: opts?.hasScope ? scopedSourceTools : allEnabledTools,
  };

  const toolNames = roleTools[role] ?? allEnabledTools;
  return filterWorkflowAgentTools(toolNames
    .filter(name => !LEGACY_DELEGATION_TOOL_NAMES.has(name))
    .map((name) => TOOL_DEFINITIONS[name])
    .filter((t): t is ToolDefinition => t !== undefined));
}

