export { evaluateBeforeCommand } from "./hooks/before-command.js";
export type { BeforeCommandDecision, BeforeCommandInput, BeforeCommandOutcome, BeforeCommandPolicy, BeforeCommandThread } from "./hooks/before-command.js";
export { runBeforeCommand } from "./agent/before-command.js";
export {
  withWorkflowAuditExecutionPolicy,
  assertWorkflowNativeRuntime,
  workflowPolicyRuntime,
} from "./workflow-execution-policy.js";

export type { ScanEvent } from "./events/scan-event.js";
export {
  finalize,
} from "./context.js";
export {
  sendPrompt,
  extractResponseText,
  fetchScoped,
  isPrivateAddress,
  isAllowedLocalOrigin,
} from "./http.js";
export {
  validateCyberAccessProgram,
  createRuntime,
  ProcessRuntime,
  LlmApiRuntime,
  PiAiRuntime,
  createNativeApiRuntime,
  runtimeFromPrivateWorkerBinding,
  ApiRuntime,
  isApiRuntime,
  runtimeMode,
  selectRuntimeKind,
  pickRuntimeForStage,
  detectAvailableRuntimes,
} from "./runtime/index.js";
export type {
  Runtime,
  RuntimeConfig,
  RuntimeResult,
  RuntimeType,
  NativeRuntime,
  NativeMessage,
  NativeToolDef,
  NativeRuntimeResult,
} from "./runtime/index.js";
export {
  CodexCatalogRefreshError,
} from "./runtime/codex-models.js";
export type { CodexCatalogModel } from "./runtime/codex-models.js";
export { DEFAULT_OPENAI_MODEL } from "./runtime/llm-api/provider-config.js";
export { modelTransportStats } from "./runtime/llm-api/transport.js";
export type { ModelTransportStats } from "./runtime/llm-api/transport.js";
export { snapshotSmolvmWorkspace } from "./runtime/smolvm-workspace.js";
export { runSmolvmWorkbench } from "./runtime/smolvm-workbench.js";
export type { SmolvmWorkbenchOptions, SmolvmWorkbenchResult, SmolvmWorkbenchApprovedImage } from "./runtime/smolvm-workbench.js";
export { resolveSmolvmRuntime, approveSmolvmWorkbenchImage, getSmolvmWorkbenchStatus } from "./runtime/smolvm-provision.js";
export {
  runMcpSecurityChecks,
} from "./mcp.js";
export {
  runLlmIpiAudit,
} from "./llm-ipi-audit.js";


// Agent runner
export { runAnalysisAgent } from "./agent-runner.js";

// Package audit

// Source code review
export type {
  CrossValidatedLead,
  CrossValidatedLeads,
  CrossValidatedLeadSource,
} from "./shared/index.js";
// Integration spine (0#700): the A→B→C memory-safety scan stage that
// chains the playbook, fuzz loop, and crash triage into Findings.
// npm-ecosystem dynamic-discovery stage + its extensible DETECTOR registry
// (sspp-fuzz, read-unstable, parser-diff). LLM-proposes / harness-disposes;
// confirmed only on an observed runtime consequence (assume-FP). New bug classes
// plug in as detectors — see docs/operations/detector-from-finding.md.
// Craft scan stage (agentic reason→craft→submit→refine, injectable PoC oracle):
// the sibling of the fuzz path that needs no target build.
// Ensemble craft stage (multi-model best-of-N craft + LLM judge → one PoC).
// Exploit scan stage (agentic weaponize-to-root, injectable target executor).
// Nonce-bound root proof + out-of-band module-load denial for the exploit lane.
// A `uid=0` regex over model-influenced output is NOT a root proof; adapters
// (ExploitGym) must verify their own proof artifact against the same challenge.
// Hunt scan stage (parallel novel-bug discovery: fan-out finders -> skeptic+prover gate).
// Deployment-context classification — path heuristics + severity cap for findings
// that target dev/test/build-only code paths (issue #1215, deep-review postmortem).
export type { DeploymentContext } from "./shared/index.js";
// Depth-method specialized-lens sets, per on-chain review profile. These are
// the ready-made `*FinderLenses` / `*VerifyLenses` fan-out + verify-quorum
// axes the seedless `deep-review` command wires into runHuntScan (G-A).
// Deterministic source-file walkers (shared by the review pipeline + the
// seedless deep-review candidate enumeration + its 5000-file scope cap).
export { collectScopeFiles, countScopeFilesUpTo } from "./source-files.js";
// Hunt memory flywheel (ZERO_HUNT_FLYWHEEL=1, ported from 0verse's
// flywheel.py): a preseeded 5-layer memory that PRIMES the best-of-N judge
// ordering + attempt-budget cost-router — it never confirms; see
// hunt-flywheel.ts's header for the invariant.
// Learned negatives (ZERO_HUNT_NEGATIVES, default ON): a known-refuted-shape
// memory that attaches prior refute reasons to the skeptic prompt as context.
// Never auto-rejects, and inert until a caller supplies a corpus; see
// hunt-negatives.ts's header.
// Kernel archetype catalog (multi-archetype hunt seeding; ported from 0verse's
// 90-archetype registry, kernel-domain subset). Data + brief mapping are always
// inert/available; `planArchetypeSweep` is env-gated (ZERO_ARCHETYPE_SWEEP=1).
// The cross-language appsec lens registry — the data-driven sibling of the
// kernel/FreeBSD/Chromium archetype packs, mapped straight to FinderLens[] for
// the seedless finder surfaces (`deep-review` / `hunt`). See appsec-catalog.ts.
// Self-improving lens loop — miss ─▶ synthesize ─▶ bench-validate ─▶ register.
// Turns a confirmed finder MISS into a new, validated, registered appsec lens.
// Fail-closed; adds LENSES, never confirms FINDINGS. See stages/lens-synthesis/.
// Recency flywheel (kernelCTF freshness window): git diff a fresh linux-next
// range → reachability filter → semantic-vs-cosmetic classifier → the refined
// invariant engine → adversarial verify → ranked report. Beats the audit-density
// wall by hunting just-committed code before syzbot/top-groups harden it.
// Whole-subsystem invariant-model hunting (Engine A, the SEEDLESS discovery
// axis): an LLM builds a stored per-object lock/refcount/lifetime model ONCE,
// then a deterministic tree-sitter dataflow checker (c-dataflow.ts) re-finds
// violations against every new revision for free. `InvariantHuntPlan` is
// aliased — invariant-candidates (above) already owns that name in the barrel.
// Assumption-mining (Engine A', the FOURTH seedless axis): an LLM MINES the
// implicit relied-on preconditions each function makes (+ the token a caller/
// lock/API uses to establish each) ONCE; then a deterministic 1b cross-check +
// establisher-propagation caller-scan (no LLM) hunts reachable callers that
// reach a relied-on subject WITHOUT establishing its precondition — the
// dual-view/DirtyCred/AF_UNIX-GC/io_uring shape our fixed-schema checkers cannot
// represent. `AssumptionHuntPlan` is aliased to avoid a barrel name clash.
// Engine A → seeded-hunt adapter (`0 lab research hunt --invariant`): derive the
// subsystem scope from the seed diff, build-or-load its invariant model, and
// format the model + deterministic violation hypotheses as a finder-prompt
// block appended to the hunt brief.
// kernelCTF-reachability gate for hunt candidate selection (path-based; see
// services/orchestrator/src/kernelctf-config.ts for the CONFIG-symbol ground truth).
// Surface-desirability score for the generic fresh-surface hunt: prioritize
// hard-to-fuzz stateful parsers of untrusted input that are NOT recently swept
// (where source review beats fuzzing). Opt-in; default OFF = size-only ranking.
// Threat-model planner stage — pre-candidate-selection trust-boundary lanes.

// Unified pipeline: prepare + static analysis
export {
  expandHomePath,
  isExistingLocalTargetPath,
  isExplicitLocalTargetPath,
} from "./path-resolution.js";


// Unified pipeline
export {
  listProjectReviewChecks,
  updateProjectReviewChecks,
} from "./review-checks.js";
export type {
  ProjectReviewChecks,
  ReviewCheckMutation,
} from "./review-checks.js";

// External seed findings (0#368). Parser + reader for ND-JSON leads
// supplied by upstream probes like GemmaForge (`gemmaforge.leads/v1`).
export {
  readSeedFindings,
} from "./seed-findings.js";

// Agent system
export { runAgentLoop, runNativeAgentLoop, ToolExecutor, getToolsForRole, TOOL_DEFINITIONS, features, estimateCost } from "./agent/index.js";
export {
  McpHost,
  parseMcpConfig,
  connectMcpServers,
  type McpServerConfig,
  type McpToolHost,
} from "./agent/mcp-host.js";
export type { ExtensionRunPort } from "./agent/types.js";
// Named bundles of ZERO_FEATURE_* vars — the documented way to enable the
// full FP moat for an A/B run. See `agent/feature-presets.ts`.
export {
  FEATURE_PRESETS,
  resolveFeaturePreset,
} from "./agent/feature-presets.js";
export {
  scoreEvidence,
} from "./agent/egats.js";
export {
  clearSkillRegistry,
  formatJitSkillsInstruction,
  getSkillById,
  listSkillSummaries,
  loadSkillRegistry,
  matchTriggers,
} from "./agent/skills/index.js";
export type {
  SkillDefinition,
  AgentSkillDiscoveryOptions,
  AgentSkillMetadata,
} from "./agent/skills/index.js";
export {
  discoverAgentSkills,
  isAgentSkillAllowed,
  validateAgentSkillContent,
} from "./agent/skills/index.js";
export {
  branchJournal,
  createJournalWriter,
  loadJournal,
  migrateJournalEntry,
  rehydrateContext,
  streamJournal,
  JOURNAL_SCHEMA_VERSION,
} from "./agent/journal/index.js";
export type {
  JournalEntry,
} from "./agent/journal/index.js";
export {
  discoveryPrompt,
  attackPrompt,
  researchPrompt,
} from "./agent/prompts.js";
export type {
  AgentState,
  ToolCall,
  ToolResult,
  OperatorQuestionRequest,
  OperatorQuestionAnswer,
  NativeAgentState,
} from "./agent/index.js";

// Strategy racing (best-of-N)

// Vulnerability intelligence tools (0#439)
export {
  buildIntelDossier,
  lookupCve,
  searchAdvisories,
  searchSimilar,
  searchTargetHistory,
  inferTargetHistoryInputFromRepo,
  advisorySweep,
  lookupAdvisory,
} from "./intel/index.js";
export type {
  IntelDossier,
  IntelTargetHistory,
  VulnerabilityIntel,
} from "./intel/index.js";

// Structured verification pipeline — `verify()` is the unified entrypoint;
// the trio (runStructuredVerify / runSelfConsistencyVerify) remain as the
// single-pass + self-consistency implementations it delegates to.
// Unified verify funnel — one verdict contract + one disclosure predicate.
// #659 / #1278 — the pov_oracle bucketing (which categories delegate to the
// out-of-band OAST-callback oracle). Consumed by `0 scan verify` to decide when
// a finding's PoV provenance is an OAST callback.


// Triage memories (Semgrep-style persistent FP learning)


// PoV (Proof-of-Vulnerability) gate

// (shared memsafety-types are re-exported above, beside the Track B fuzz-loop exports)

// Handcrafted feature extractor (45-element vector for triage classifiers)

// Per-finding triage provenance — which FP-moat layers actually ran, derived
// from the recorded `layerVerdicts` rather than the current env. See
// `triage/provenance.ts` for why that distinction is load-bearing.

export type {
  Remediation,
} from "./remediation.js";

// Adversarial eval runner (fast AI safety scorecard)



// Action-level durable action log: the per-invocation `tool_calls` payload
// shape, its redacted args preview, the `tool_calls` ↔ `tool_artifact`
// correlation id, and a reader that tolerates pre-upgrade (turn-level) rows.
export {
  readToolCallNames,
} from "./agent/action-log.js";


// Kernel crash ingest (crash report → Finding pipeline)

// Kernel advisory variant hunting (foxguard SARIF → 0 findings)


// Syzbot invalid / auto-closed queue mining (LPE-hunt upgrade #0) — a net-new
// bug-supply channel that mines syzbot's DISCARDED reports (invalid / no-repro /
// moderation) into ranked hunt candidates. Ingestion + candidate-mapping only;
// the dynamic repro is handed to the existing (bench-gated) kernel-vm path.

// Weaponization pipeline — engine bricks (ADR-055 Phase 1). Escalation ladder,
// primitive strategy library + C templates, deterministic success oracle,
// kernel-VM harness, and the control-demo probe that backs `attemptControlDemo`.
// P2 (0cloud dispatch) / P3 (autonomy) build on this surface.
// Autonomous LLM-composed weaponization climb (feat/autonomous-climb-loop).

// kernelCTF patch-gap 1day monitor (upstream-fixed CVE feed → target-tree
// presence check → kernelCTF reachability gate → ranked candidates). See
// 0/packages/engine/src/kernel/patch-gap.ts.

// Bug-to-primitive classifier (the input to the weaponization harness).

// Execution-verified exploitability-upgrade oracle — the PROVE stage (#1119).
// Per-finding PROVE stage — the adapter that makes the kernel-VM exploitability
// oracle reachable as `runHuntScan`'s `opts.exploitability` (see the module
// header for why the gate must be built per finding, not once per hunt).




// Kernel crash verification oracle



// Tier 2 kernel-finding verification (#271). Agent-driven loop that takes a
// static `hypothesis: true, confidence: 0.4` kernel-review Finding and drives
// a constrained reproducer-generation loop until the Tier 1 oracle confirms
// (or the attempt/wall-clock budget is exhausted).

// Autonomous CVE PoC adaptation (issue #272 v0 part 2). The scraper that
// produces `CveArtifacts` lives on a sibling branch and is wired in at
// merge time via the typed `CveArtifactProvider` seam.

// Shared scanner event bus and local presentation adapter.
export {
  eventBus,
  presentationEventSink,
} from "./events/bus.js";
// Consent-gated analytics pipeline — the single choke point that may transmit
// analytics. The CLI entry must set `ZERO_ANALYTICS_LEVEL` from the operator's
// setting and call `maybeSubscribeAnalyticsPipeline()` (mirrors the cloud sink
// wiring); without that call the pipeline never subscribes and transmits
// nothing. USAGE tier only for now — command/code/target/finding collectors
// are a separate, reviewed wave.
export {
  analyticsPipeline,
} from "./telemetry/analytics-pipeline.js";
export {
  ANALYTICS_LEVEL_ENV,
  analyticsOptedOut,
  resolveAnalyticsLevel,
  levelAtLeast,
} from "./telemetry/analytics-level.js";
export {
  configureRunContributionsFromEnvironment,
} from "./telemetry/run-contribution.js";
// Operational NDJSON stderr sink (ZERO_LOG_FORMAT=json). Writes one
// NDJSON line per allowlisted lifecycle/cost event to stderr, stripped
// of all sensitive fields (prompts, responses, reasoning, tool args,
// finding evidence, token deltas, auth material, raw error text).
export {
  maybeSubscribeOperationalEventSink,
} from "./events/operational-sink.js";
// herdr pane-state sink. Reports only 0's coarse working/idle state and
// non-identifying counters to the local herdr socket, so a 0 pane stops
// showing as "unknown" in herdr's sidebar. Inert unless HERDR_ENV=1 with a
// socket and pane id present. Never carries engagement content — the socket
// is readable by any process running as this user.
export {
  createHerdrEventSink,
} from "./integrations/herdr.js";
// Structured diagnostics. Defaults to stderr so non-interactive runs never
// lose a quota or retry notice; the TUI claims the channel at mount so the
// same messages land in the transcript instead of over the framebuffer.
export * from "./diagnostics/channel.js";
// Agent coordination hub: peer roster + a crash-safe local message spool.
// Messages are inert prose by construction — nothing in one can grant scope,
// approve a tool, or alter another session's authorization state.
export {
  peekInbox,
  sendMessage,
} from "./hub/mailbox.js";
// Agent-to-agent addressing policy + the operator→child steering path. The
// policy is pure and inert (it grants nothing); `sendOperatorMessage` is the
// one supported way the console steers a specific running subagent's mailbox.
export {
  clampOutboundBody,
  sendOperatorMessage,
} from "./agent/agent-messaging.js";
// Extensions: the one installable unit (store, installer, install prompt, importer). See plugins/extensions/index.ts.
export {
  createExtensionService, parseManifest as parseExtensionManifest, renderInstallPrompt, extensionEnv, readRepoSuggestions, extensionSkillRoots, runStartupImport,
  BUILTIN_EXTENSIONS, approvalFor, approvalRefusal, FsExtensionStore, DefaultSourceResolver, McpDraftSource, ExtensionInstaller, LegacyImporter, loadable as loadableExtensions, listRows as listExtensionRows, gitTreeHash,
} from "./plugins/extensions/index.js";
export type {
  ExtensionService, ExtensionStore, ExtensionSource, SourceResolver, Installer, Importer, PreparedInstall, InstallPrompt, ExtensionManifest, ExtensionState, ExtensionEntry,
  ImportReport, ExtensionErrorCode, Result as ExtensionResult, ExtensionOverview, ExtensionOverviewRow, LoadResult as ExtensionLoadResult, LoadedExtension, ListRow as ExtensionListRow, Suggestion as ExtensionSuggestion, Capabilities as ExtensionCapabilities,
  McpServerStatus as ExtensionMcpServerStatus, McpToolStatus as ExtensionMcpToolStatus, McpGate as ExtensionMcpGate,
} from "./plugins/extensions/index.js";
// Connector contract (extension manifest `connector`): declaration, auth port, token adapter, secret store.
export { listConnectors, defaultAdapter, TokenConnector, FsConnectionSecrets, GITHUB_CONNECTOR, hostAllowed } from "./plugins/extensions/index.js";
export type { ConnectorDecl, ConnectorStatus, ConnectorState, ConnectorAuthPort, ConnectionSecrets, ConnectorEntry } from "./plugins/extensions/index.js";
export type {
  CostBreakdownEntry,
  SubagentLifecyclePayload,
  SubagentProgressPayload,
  SubagentMessagePayload,
} from "./events/bus.js";
export { ScanCostLedger } from "./agent/cost-ledger.js";


// Verification spec evaluator (0#193 / 0-cloud#111). Re-checks a
// finding's `verificationSpec` predicates against a repo on disk so cloud's
// canary watcher (and any OSS caller) can deterministically decide whether
// a finding is still real after upstream changes.
export {
  runCliPathTraversalReplayFixture,
} from "./verification-spec/index.js";
export type {
  VerificationResult,
} from "./verification-spec/index.js";

// Source fix-and-retest workflow. Generates a scoped local patch only for an
// already reproduced finding, validates it in an isolated Git worktree, then
// optionally applies the same patch after the source contract and test command
// both pass.
export { parseVerifySpec, inlineVerifySpec, verificationLine, isVerified, gateDone, claimsFixed, runVerifier, OciRunner, HostRunner, snapshotWorktree, snapshotHead, isGitRepo, isPinnedImage } from "./verifier/index.js";
export type { VerifySpec, VerifierResult, ContainerRunner } from "./verifier/index.js";

// Deterministic replay runner. Consumes a finding's `pocSteps`, sequentially
// executes them through local, SmolVM, Docker, or QEMU isolation, and emits a canonical
// `VerificationResult` payload matching `@0/engine/shared/verification`. Cloud's
// worker-controller can call this directly in-process without shelling out to
// the CLI.
//
// Names that would collide with existing exports (StepResult,
// DEFAULT_STEP_TIMEOUT_MS) are re-exported under prefixed aliases so
// callers can pick a side without ambiguity.
// in the cli package; this surface is the programmatic entry point.

// Cloud credentials and the independent Windows evidence-worker transport.
export {
  loadCloudCredentials,
} from "./cloud/index.js";

// CVE artifact scraping (#272 v0 part 1). Finds public PoC artifacts,
// write-ups, and affected-version metadata for a given CVE id by hitting
// NVD, GHSA, OSV, distro trackers, and GitHub search. Building/running
// the PoC is the next slice (depends on #271 Tier-1 plumbing).

// Disclosure bundle assembly (finding → GHSA-ready advisory markdown)

// #928 — disclosure-process tracking (status state machine + timeline) and the
// evidence-pack assembler (finding → vendor-notification draft). DRAFT-only,
// never sends.

// PR-shaped finding output (0#377). `emitFindingsAsPRs` turns reproduced
// findings into one GitHub PR each (repro + suggested patch from a fix-template
// registry); non-reproduced findings roll up into a single hypotheses.md.


// ── Interactive operator console: unified conversational front-end that drives
// the full tool registry through the real ToolExecutor + LlmApiRuntime. ──
export { configureSubagentLimits, subagentBatchLimit, subagentConcurrency, subagentDepthLimit, SUBAGENT_LIMIT_DEFAULTS } from "./agent/subagent-limits.js";
export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  createConsoleSession,
  createConsoleRuntime,
  isDangerousLocalRoot,
  AUTO_TITLE_TIMEOUT_MS,
  fallbackConversationTitle,
  firstExchange,
  generateConversationTitle,
  inferTitleSource,
  isDefaultConversationTitle,
  redactForTitle,
  sanitizeGeneratedTitle,
} from "./console/index.js";
export type {
  ConsoleConversationHistory,
  ConsoleSession,
  ConsoleSessionCheckpoint,
  ConsoleSessionConfig,
  ConsoleRenderCallbacks,
  ConsoleTurnOutcome,
  ConsoleUsageReport,
  AutoTitleInput,
  AutoTitleResult,
  ConversationTitleSource,
} from "./console/index.js";

// Protocol-conformance capability (issue #972) — Tier-1 HTTP spec-vs-impl
// differential: LLM hypothesizes divergences, a deterministic oracle confirms.

// Research packs (xnu-fuzz, adgraph, identity) are NOT re-exported here so the
// default import graph and the `core` edition stay free of them. Import them via
// the `@0/engine/xnu-fuzz`, `@0/engine/adgraph` and `@0/engine/identity` subpaths.

// Local, redacted reproducibility manifests for verified findings.


// Isolated, evaluated self-rewriting candidates and pinned future workers.

export type {
  SecureEvent,
  SecureProjectResult,
} from "./secure/types.js";

export {
  runWorkbenchBrokerProgram,
  isAdmittedSmolvmWorkbench,
  resolveWorkbenchBrokerImage,
  DEFAULT_WORKBENCH_BROKER_LIMITS,
  WORKBENCH_BROKER_WORKSPACE,
} from "./runtime/smolvm-broker.js";
export {
  createWorkbenchProviderBroker,
} from "./runtime/workbench-provider-broker.js";
export type {
  WorkbenchProviderGrant,
} from "./runtime/workbench-provider-broker.js";


// Transport-independent workflow execution and owned lifecycle.
export * from "./workflow-runner.js";
export * from "./workflow-service.js";
export * from "./engine-service.js";
export { budgetNativeRuntime } from "./scan-plan.js";
export * from "./notes/index.js";

export * from "./report-export.js";



export { sanitizedEnv } from "./agent/sanitized-env.js";

export {
  observeExecutionResources,
} from "./agent/execution-resource-registry.js";

export {
  parseFlag,
  type FlagParseOptions,
} from "./config/env.js";
export {
  DEPRECATED_ENV,
  applyEnvAliases,
  type DeprecatedEnvEntry,
} from "./config/deprecated-env.js";

export type { ConsoleRuntime, RuntimeKind } from "./runtime/index.js";
export { RECOMMENDED_MODEL_ROLES, recommendModels } from "./runtime/llm-api/recommended-models.js";
export type { RecommendedPick, RecommendedRole, RecommendedRoleSpec } from "./runtime/llm-api/recommended-models.js";


