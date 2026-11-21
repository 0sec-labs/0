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

// Unified pipeline
export {
  listProjectReviewChecks,
  updateProjectReviewChecks,
} from "./review-checks.js";
export type {
  ProjectReviewChecks,
  ReviewCheckMutation,
} from "./review-checks.js";

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

// Action-level durable action log: the per-invocation `tool_calls` payload
// shape, its redacted args preview, the `tool_calls` ↔ `tool_artifact`
// correlation id, and a reader that tolerates pre-upgrade (turn-level) rows.
export {
  readToolCallNames,
} from "./agent/action-log.js";

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

// Cloud credentials and the independent Windows evidence-worker transport.
export {
  loadCloudCredentials,
} from "./cloud/index.js";

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

// Isolated, evaluated self-rewriting candidates and pinned future workers.

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
export * from "./engine-service.js";

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

