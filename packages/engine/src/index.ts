// Programmatic scope ingestion (0#215). `loadScope` reads a JSON
// scope file; `ScopePolicy` is the matcher used by every URL chokepoint
// in the agent (validateTargetUrl + 5 fetch sites + shellExec URL
// extraction + redirect-final-URL re-check in the crawler).
export {
  loadScope,
  matchUrl,
  ScopePolicy,
  normalizeScopeHostname,
} from "./scope/scope.js";
export type {
  ScopeJson,
} from "./scope/scope.js";
export {
  networkScopeRequiredRefusal,
  targetRequiresScope,
} from "./scope/scope-guard.js";
export {
  BUILTIN_PLUGINS,
  getBuiltinPlugin,
} from "./plugins/builtin.js";
export { getScopeEnforcementState, isScopeEnforcementEnabled, withScopeEnforcement } from "./scope/activation.js";
export type { ScopeEnforcementState } from "./scope/activation.js";
export {
  withWorkflowAuditExecutionPolicy,
  assertWorkflowNativeRuntime,
  workflowPolicyRuntime,
} from "./workflow-execution-policy.js";

// Attribution-header injection (0#216). Builds on scope ingestion:
// configures per-engagement headers + UA override that get merged into
// every in-scope outbound request, so coordinated-disclosure venues can
// deconflict 0 traffic from real attacks.
export {
  resolveAttribution,
  extractAttributionFromScopeJson,
} from "./scope/attribution.js";

// Engagement hardening profile. One opt-in posture that makes the engine
// behave conservatively on an authorized engagement (no reset-endpoint burst
// probe, rate-limited web-recon pre-pass, no WAF-evasion ladder, jittered
// pacing, reduced rps) plus the auditable record of what was applied.
export {
  resolveEngagementProfile,
  extractEngagementFromScopeJson,
  describeEngagementPosture,
  effectiveFallbackRps,
} from "./scope/engagement-profile.js";
export type {
  EngagementPosture,
  EngagementProfileInputs,
} from "./scope/engagement-profile.js";

export { scan } from "./scanner.js";
export type {
  ScanEvent,
} from "./scanner.js";
export { agenticScan } from "./agentic-scanner.js";
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
export { packageAudit } from "./audit.js";

// Source code review
export { sourceReview } from "./review.js";
export { huntAppFixVariants, appFixVariantsToSeedFindings } from "./review/app-fix-variants.js";
export { checkAlreadyFixed } from "./kernel/fix-commit-intel.js";
export type {
  CrossValidatedLead,
  CrossValidatedLeads,
  CrossValidatedLeadSource,
} from "./shared/index.js";
export {
  scaffoldTier1Harness,
  scaffoldTier2Harness,
} from "./review/c-cpp-profile.js";
export {
  buildTier2Harness,
} from "./review/c-cpp-tier2.js";
export type {
  Sanitizer,
} from "./review/c-cpp-tier2.js";
export {
  extractCorpus,
} from "./review/corpus.js";
export {
  runTier3Validation,
} from "./review/c-cpp-tier3.js";
export type {
  MemSafetyTarget,
  CrashArtifact,
} from "./triage/memsafety-types.js";
// Integration spine (0#700): the A→B→C memory-safety scan stage that
// chains the playbook, fuzz loop, and crash triage into Findings.
export {
  runMemSafetyScan,
  crashArtifactToFinding,
} from "./stages/memsafety-scan.js";
// npm-ecosystem dynamic-discovery stage + its extensible DETECTOR registry
// (sspp-fuzz, read-unstable, parser-diff). LLM-proposes / harness-disposes;
// confirmed only on an observed runtime consequence (assume-FP). New bug classes
// plug in as detectors — see docs/operations/detector-from-finding.md.
export {
  runNpmDynamicDiscovery,
} from "./stages/npm-dynamic-discovery.js";
export type {
  NpmDynamicDiscoveryResult,
} from "./stages/npm-dynamic-discovery.js";
export {
  DETECTOR_REGISTRY,
  getDetectorById,
  listDetectorIds,
  resolveDetectors,
  runDetectorOnPackage,
  guardPackage,
  dedupConfirmation,
  createOsvAdvisoryLookup,
  deriveForkSiblings,
  OsvLookupError,
  inProcessProbe,
  staticProbe,
  ssppFuzzDetector,
  readUnstableDetector,
  parserDiffDetector,
} from "./stages/npm-detectors/index.js";
export type {
  Detector,
  DedupVerdict,
  PackageRef,
} from "./stages/npm-detectors/index.js";
// Craft scan stage (agentic reason→craft→submit→refine, injectable PoC oracle):
// the sibling of the fuzz path that needs no target build.
export {
  runCraftScan,
} from "./stages/craft-scan.js";
export {
  defaultCraftCandidateReviewer,
} from "./stages/craft-adversarial-review.js";
// Ensemble craft stage (multi-model best-of-N craft + LLM judge → one PoC).
export {
  runEnsembleCraft,
  parseEnsembleModels,
} from "./stages/ensemble-craft.js";
export type {
  CraftCandidateJudge,
} from "./stages/ensemble-craft.js";
// Exploit scan stage (agentic weaponize-to-root, injectable target executor).
export { runExploitScan } from "./stages/exploit-scan.js";
// Nonce-bound root proof + out-of-band module-load denial for the exploit lane.
// A `uid=0` regex over model-influenced output is NOT a root proof; adapters
// (ExploitGym) must verify their own proof artifact against the same challenge.
export {
  mintRootProofChallenge,
  verifyRootProof,
  rootProofInstructions,
} from "./stages/exploit-stage-gate.js";
export type {
  RootProofChallenge,
  RootProofVerdict,
} from "./stages/exploit-stage-gate.js";
// Hunt scan stage (parallel novel-bug discovery: fan-out finders -> skeptic+prover gate).
export { runHuntScan, makeSkepticVerifier, composeGate, makeMultiLensVerifier } from "./stages/hunt-scan.js";
export { createEvolvedFinder } from "./stages/evolved-finder.js";
// Deployment-context classification — path heuristics + severity cap for findings
// that target dev/test/build-only code paths (issue #1215, deep-review postmortem).
export {
  classifyDeploymentContext,
} from "./stages/deployment-context.js";
export type { DeploymentContext } from "./shared/index.js";
// Depth-method specialized-lens sets, per on-chain review profile. These are
// the ready-made `*FinderLenses` / `*VerifyLenses` fan-out + verify-quorum
// axes the seedless `deep-review` command wires into runHuntScan (G-A).
export { evmFinderLenses, evmVerifyLenses } from "./review/evm-onchain-profile.js";
export { solanaFinderLenses, solanaVerifyLenses } from "./review/solana-onchain-profile.js";
export { cardanoFinderLenses, cardanoVerifyLenses } from "./review/cardano-onchain-profile.js";
export { cairoFinderLenses, cairoVerifyLenses } from "./review/cairo-onchain-profile.js";
export { moveFinderLenses, moveVerifyLenses } from "./review/move-onchain-profile.js";
// Deterministic source-file walkers (shared by the review pipeline + the
// seedless deep-review candidate enumeration + its 5000-file scope cap).
export { collectScopeFiles, countScopeFilesUpTo } from "./source-files.js";
// Hunt memory flywheel (ZERO_HUNT_FLYWHEEL=1, ported from 0verse's
// flywheel.py): a preseeded 5-layer memory that PRIMES the best-of-N judge
// ordering + attempt-budget cost-router — it never confirms; see
// hunt-flywheel.ts's header for the invariant.
export {
  PRIME_MIN,
} from "./stages/hunt-flywheel.js";
// Learned negatives (ZERO_HUNT_NEGATIVES, default ON): a known-refuted-shape
// memory that attaches prior refute reasons to the skeptic prompt as context.
// Never auto-rejects, and inert until a caller supplies a corpus; see
// hunt-negatives.ts's header.
export {
  loadKnownNegativesFromEnv,
} from "./stages/hunt-negatives.js";
// Kernel archetype catalog (multi-archetype hunt seeding; ported from 0verse's
// 90-archetype registry, kernel-domain subset). Data + brief mapping are always
// inert/available; `planArchetypeSweep` is env-gated (ZERO_ARCHETYPE_SWEEP=1).
export {
  loadKernelArchetypes,
  loadFreebsdArchetypes,
  FREEBSD_BARE_KERNEL_WORDS,
  loadChromiumArchetypes,
  CHROMIUM_BARE_WORDS,
  filterArchetypes,
  symbolsFromDetectionSignature,
  archetypeSweepEnabled,
  planArchetypeSweep,
} from "./stages/archetype-catalog.js";
export type {
  ArchetypeRoute,
  ArchetypeDomain,
  ArchetypeCandidateOptions,
  ArchetypeSweepPlan,
} from "./stages/archetype-catalog.js";
// The cross-language appsec lens registry — the data-driven sibling of the
// kernel/FreeBSD/Chromium archetype packs, mapped straight to FinderLens[] for
// the seedless finder surfaces (`deep-review` / `hunt`). See appsec-catalog.ts.
export {
  loadAppsecFinderLenses,
} from "./stages/appsec-catalog.js";
// Self-improving lens loop — miss ─▶ synthesize ─▶ bench-validate ─▶ register.
// Turns a confirmed finder MISS into a new, validated, registered appsec lens.
// Fail-closed; adds LENSES, never confirms FINDINGS. See stages/lens-synthesis/.
export {
  runLensSynthesisLoop,
  validateCandidateLens,
  makeFinderLensProbe,
  prepareValidationCorpus,
  inspectLensRegistry,
  retireArchetype,
  captureObservation,
  listObservations,
  approveObservation,
  claimForProcessing,
  markProcessed,
  getObservation,
  releaseClaim,
  parseObservationInput,
  parseApprovedObservationShape,
} from "./stages/lens-synthesis/index.js";
export type {
  ConfirmedMiss,
  MissInput,
  ValidationFixture,
  ValidationCorpus,
  LensBaselineSnapshot,
  LensProbe,
  LensProbeOutcome,
  LensSynthesisInput,
  LensSynthesisResult,
  LensSynthesisModel,
  LensRegistryStatus,
  ObservationStatus,
  CaptureObservationInput,
} from "./stages/lens-synthesis/index.js";
export {
  syncLoreMirror,
  localMirrors,
  makeLloreJudge,
} from "./stages/novelty-check.js";
export { generateVariantCandidates } from "./stages/variant-candidates.js";
// Recency flywheel (kernelCTF freshness window): git diff a fresh linux-next
// range → reachability filter → semantic-vs-cosmetic classifier → the refined
// invariant engine → adversarial verify → ranked report. Beats the audit-density
// wall by hunting just-committed code before syzbot/top-groups harden it.
export {
  runRecencyHunt,
  renderRecencyReportMarkdown,
} from "./stages/recency-hunt.js";
// Whole-subsystem invariant-model hunting (Engine A, the SEEDLESS discovery
// axis): an LLM builds a stored per-object lock/refcount/lifetime model ONCE,
// then a deterministic tree-sitter dataflow checker (c-dataflow.ts) re-finds
// violations against every new revision for free. `InvariantHuntPlan` is
// aliased — invariant-candidates (above) already owns that name in the barrel.
export {
  buildInvariantModel,
} from "./stages/subsystem-invariant-model.js";
// Assumption-mining (Engine A', the FOURTH seedless axis): an LLM MINES the
// implicit relied-on preconditions each function makes (+ the token a caller/
// lock/API uses to establish each) ONCE; then a deterministic 1b cross-check +
// establisher-propagation caller-scan (no LLM) hunts reachable callers that
// reach a relied-on subject WITHOUT establishing its precondition — the
// dual-view/DirtyCred/AF_UNIX-GC/io_uring shape our fixed-schema checkers cannot
// represent. `AssumptionHuntPlan` is aliased to avoid a barrel name clash.
export {
  runAssumptionHunt,
} from "./stages/assumption-mining.js";
export type {
  Assumption,
  AssumptionModel,
} from "./stages/assumption-mining.js";
// Engine A → seeded-hunt adapter (`0 research hunt --invariant`): derive the
// subsystem scope from the seed diff, build-or-load its invariant model, and
// format the model + deterministic violation hypotheses as a finder-prompt
// block appended to the hunt brief.
export {
  buildInvariantHuntContext,
} from "./stages/invariant-hunt-context.js";
export type {
  CallEdge,
} from "./stages/graph-slice.js";
export {
  buildGraphSliceHuntContext,
} from "./stages/graph-slice-hunt-context.js";
// kernelCTF-reachability gate for hunt candidate selection (path-based; see
// services/orchestrator/src/kernelctf-config.ts for the CONFIG-symbol ground truth).
export {
  applyReachabilityGate,
} from "./stages/hunt-reachability.js";
// Surface-desirability score for the generic fresh-surface hunt: prioritize
// hard-to-fuzz stateful parsers of untrusted input that are NOT recently swept
// (where source review beats fuzzing). Opt-in; default OFF = size-only ranking.
export {
  applySurfaceRanking,
} from "./stages/surface-desirability.js";
// Threat-model planner stage — pre-candidate-selection trust-boundary lanes.
export { runThreatModelPlanner, parseThreatLaneJson, allocateCandidatesAcrossLanes, matchesLane } from "./stages/threat-lanes.js";
export type { ThreatLane } from "./stages/threat-lanes.js";
export {
  extractSpecInvariants,
  runSpecdriftPlan,
  runSpecdriftScan,
} from "./specdrift/index.js";
export type {
  HuntCandidate,
  HuntBrief,
  HuntVerifier,
  HuntScanOptions,
  HuntScanResult,
  HuntFindingRecord,
  FinderLens,
  VerifyLens,
} from "./stages/hunt-scan.js";
export type {
  CraftPocEvaluator,
  CraftScanOptions,
  CraftScanResult,
} from "./stages/craft-scan.js";
export type {
  CraftEvidenceRecord,
} from "./stages/craft-evidence-ledger.js";
// Cross-task learning memory (the 5-tier "Crystalline-style" moat).
export { CraftMemoryStore, preseedMemory, consolidateMemory } from "./craft-memory/index.js";
export type {
  Memory,
} from "./craft-memory/index.js";

// Unified pipeline: prepare + static analysis
export {
  prepare,
} from "./prepare.js";
export {
  expandHomePath,
  isExistingLocalTargetPath,
  isExplicitLocalTargetPath,
} from "./path-resolution.js";


// Unified pipeline
export {
  runPipeline,
} from "./unified-pipeline.js";
export type {
  PipelineOptions,
} from "./unified-pipeline.js";
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
} from "./agent/mcp-host.js";
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
export {
  raceStrategies,
  DEFAULT_STRATEGIES,
} from "./racing.js";
export type { AttackStrategy, RaceConfig, RaceResult, StrategyResult } from "./racing.js";

// Per-host rate limiter (#214)
export {
  RateLimiter,
  parseRateLimitFlag,
} from "./scope/rate-limit.js";
export type {
  HostRateConfig,
  RateLimiterConfig,
} from "./scope/rate-limit.js";

// http_audit enforcement (path allowlist + counters + kill switch)
export { PathPolicy, EnforcementTracker } from "./scope/enforcement.js";
export type {
  EnforcementSummary,
} from "./scope/enforcement.js";



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
export {
  verify,
  runStructuredVerify,
  runSelfConsistencyVerify,
  tallyConsensus,
} from "./triage/structured-verify.js";
// Unified verify funnel — one verdict contract + one disclosure predicate.
export { isDisclosureWorthy, evidenceKindForFinding } from "./triage/verify-verdict.js";
export type {
  VerifyOutcome,
  VerifyEvidenceKind,
} from "./triage/verify-verdict.js";
// #659 / #1278 — the pov_oracle bucketing (which categories delegate to the
// out-of-band OAST-callback oracle). Consumed by `0 verify` to decide when
// a finding's PoV provenance is an OAST callback.
export { oracleForCategory } from "./triage/pov-gate.js";
export { parseImpactAssessment } from "./triage/impact-assessment.js";

export type {
  ReachabilityTier,
} from "./triage/auto-triage.js";

// Triage memories (Semgrep-style persistent FP learning)
export { MemoryStore, scoreMemory, inferPackage } from "./triage/memories.js";

export type {
  NoveltyResult,
} from "./triage/publishability-sources.js";

// PoV (Proof-of-Vulnerability) gate
export {
  generatePov,
  judgePovEvidence,
  isReproducedMemCorruption,
  memCorruptionVerdict,
} from "./triage/pov-gate.js";

// (shared memsafety-types are re-exported above, beside the Track B fuzz-loop exports)

// Handcrafted feature extractor (45-element vector for triage classifiers)
export { extractFeatures, FEATURE_NAMES } from "./triage/feature-extractor.js";

// Per-finding triage provenance — which FP-moat layers actually ran, derived
// from the recorded `layerVerdicts` rather than the current env. See
// `triage/provenance.ts` for why that distinction is load-bearing.
export {
  summarizeTriageProvenance,
  formatTriageProvenance,
  UNINSTRUMENTED_LAYERS,
} from "./triage/provenance.js";

export type {
  Remediation,
} from "./remediation.js";

// Adversarial eval runner (fast AI safety scorecard)
export { runEval, getEvalCategories } from "./eval-runner.js";
export type {
  EvalScorecard,
  EvalCategoryResult,
  EvalVerdict,
} from "./eval-runner.js";



// Action-level durable action log: the per-invocation `tool_calls` payload
// shape, its redacted args preview, the `tool_calls` ↔ `tool_artifact`
// correlation id, and a reader that tolerates pre-upgrade (turn-level) rows.
export {
  readToolCallNames,
} from "./agent/action-log.js";


// Kernel crash ingest (crash report → Finding pipeline)
export {
  ingestArtifactsFromDirectory,
  ingestArtifactsFromFile,
  reviewKernelCrashSubsystems,
} from "./ingest/index.js";

// Kernel advisory variant hunting (foxguard SARIF → 0 findings)
export {
  runKernelVariantHunt,
} from "./kernel/index.js";
export type {
  KernelVariantHuntReport,
} from "./kernel/index.js";


// Syzbot invalid / auto-closed queue mining (LPE-hunt upgrade #0) — a net-new
// bug-supply channel that mines syzbot's DISCARDED reports (invalid / no-repro /
// moderation) into ranked hunt candidates. Ingestion + candidate-mapping only;
// the dynamic repro is handed to the existing (bench-gated) kernel-vm path.
export {
  toHuntCandidates,
  defaultSyzbotFetcher,
  mineSyzbotQueue,
  generateSyzChoiceWeights,
  syzChoiceWeightsFromPlan,
} from "./kernel/index.js";

// Weaponization pipeline — engine bricks (ADR-055 Phase 1). Escalation ladder,
// primitive strategy library + C templates, deterministic success oracle,
// kernel-VM harness, and the control-demo probe that backs `attemptControlDemo`.
// P2 (0cloud dispatch) / P3 (autonomy) build on this surface.
export {
  ratchet,
  adjudicate,
  emitWeaponizationC,
  getStrategy,
  runWeaponization,
  kernelVmArtifactsReady,
  bootedCacheKey,
  makeKernelVmProbe,
  runKernelExploitChain,
} from "./kernel/index.js";
export {
  selectSprayPlans,
  introspectExploitConfig,
} from "./kernel/exploit/index.js";
// Autonomous LLM-composed weaponization climb (feat/autonomous-climb-loop).
export {
  autonomousClimb,
} from "./kernel/exploit/index.js";
export type {
  AutonomousClimbBug,
} from "./kernel/exploit/index.js";

// kernelCTF patch-gap 1day monitor (upstream-fixed CVE feed → target-tree
// presence check → kernelCTF reachability gate → ranked candidates). See
// 0/packages/engine/src/kernel/patch-gap.ts.
export {
  loadVulnsFeedFromDir,
} from "./kernel/index.js";
export { scanForPatchGapCandidates } from "./kernel/index.js";
export type {
  PatchGapCandidate,
} from "./kernel/index.js";
export type {
  EscalationRung,
  ExploitTemplateParams,
  KernelVmRunner,
  StrategyAttempt,
  ChainRunStep,
  KernelExploitContext,
} from "./kernel/index.js";

// Bug-to-primitive classifier (the input to the weaponization harness).
export {
  classifyKernelPrimitive,
  classifyPrimitiveFromDmesg,
  describeKernelPrimitive,
} from "./triage/kernel-primitive.js";
export type {
  KernelPrimitive,
  ControlDemoStep,
} from "./triage/kernel-primitive.js";

// Execution-verified exploitability-upgrade oracle — the PROVE stage (#1119).
export {
  makeExploitabilityGate,
} from "./triage/exploitability-upgrade.js";
// Per-finding PROVE stage — the adapter that makes the kernel-VM exploitability
// oracle reachable as `runHuntScan`'s `opts.exploitability` (see the module
// header for why the gate must be built per finding, not once per hunt).
export {
  makeHuntProveStage,
} from "./triage/hunt-prove-stage.js";

export type {
  ImpactCeiling,
} from "./triage/escalation-gate.js";



// Kernel crash verification oracle
export {
  verifyKernelCrash,
  verifyStandaloneKernelReproducer,
} from "./triage/kernel-oracle.js";
export type {
  KernelOracleResult,
  ReproducerResult,
} from "./triage/kernel-oracle.js";
export {
  prepareKernelVmArtifacts,
  writeProofFileReadOnly,
  defaultDmesgOutPath,
} from "./triage/kernel-vm-runner.js";
export type {
  KernelVmArtifacts,
} from "./triage/kernel-vm-runner.js";



// Tier 2 kernel-finding verification (#271). Agent-driven loop that takes a
// static `hypothesis: true, confidence: 0.4` kernel-review Finding and drives
// a constrained reproducer-generation loop until the Tier 1 oracle confirms
// (or the attempt/wall-clock budget is exhausted).
export {
  verifyStaticKernelFinding,
  applyVerificationToFinding,
  defaultKernelVerifyRunner,
} from "./verify/index.js";
export type {
  KernelVerifyOracleResult,
} from "./verify/index.js";

// Autonomous CVE PoC adaptation (issue #272 v0 part 2). The scraper that
// produces `CveArtifacts` lives on a sibling branch and is wired in at
// merge time via the typed `CveArtifactProvider` seam.
export {
  adaptAndVerify,
} from "./cve/index.js";
export type {
  AdaptationResult,
  AdaptationStatus,
  CveArtifactProvider,
  CveArtifacts,
} from "./cve/index.js";

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
// Persistent cross-session hunt memory: a redacted, crash-safe findings/pattern
// store so one target's learnings inform the next.
export * from "./memory/index.js";
// Plugin manifest + capability model. Capabilities translate into the SAME
// gate maps the built-in tools use, so a plugin tool cannot acquire a
// second, weaker authorization path. Fail-closed: an undeclared or unknown
// capability set yields the most restrictive treatment, never read-only.
export {
  validatePluginManifest,
  gateFlagsFor,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginManifest,
  type ValidationResult,
} from "./plugins/manifest.js";
// Monotonic, deny-only guard layer beneath the name-keyed gates. Guards can
// only ever narrow what is permitted: there is no value a guard can return
// that means "allow", so composing more guards cannot loosen policy and a
// plugin cannot suppress the authorization chain.
export {
  BUILTIN_GUARDS,
} from "./plugins/guards.js";
// Model-authored session extensions. A contribution carries tool
// definitions and DENY-ONLY guards and nothing else — no hook, interceptor
// or listener is expressible, so it cannot suppress the authorization chain
// the way dsh's pre-execute waterfall can. Off by default.
export {
  SelfExtensionRegistry,
  MAX_MANIFEST_BYTES,
} from "./plugins/self-extension.js";
export { ExecutablePluginManager } from "./plugins/executable.js";
export {
  LiveHarnessHost,
} from "./plugins/live-harness.js";
// ── Third-party plugin lifecycle (install → enable → run → hot-swap) ──────────
// These are the primitives the `0 plugin` CLI surface drives. They are the
// SAME modules the console loads plugins through, so the CLI never duplicates
// loader/registry/enablement logic — it imports it. Every security invariant
// (install ≠ enablement, the single capability→gate translation, the re-approval
// rule on a widened capability set, the subprocess boundary) lives in these
// modules and is not re-implemented at the CLI layer.
//
// Per-project enablement store. `enable`/`disable` write ONE json record and
// spawn nothing; `reconcile` + `loadableIds` enforce the re-approval rule so a
// plugin whose on-disk capabilities widened past what the operator approved is
// never handed to the loader.
export {
  emptyEnablement,
  aggregateCapabilities,
  isEnabled,
  enable,
  disable,
  reconcile,
  loadableIds,
  readEnablement,
  writeEnablement,
} from "./plugins/enablement.js";
export type {
  EnablementRecord,
  InstalledPluginView,
} from "./plugins/enablement.js";
// Loader / host. `PluginHost` is the ONLY module that spawns a plugin; it runs
// every contributed tool through `gateFlagsFor` and refuses any id absent from
// the caller-supplied `enabled` set. `reload()` is a genuine kill+respawn that
// is refused while a call is in flight — hot-swap without dropping a turn.
export {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_ENTRY_FILE,
  PLUGIN_DIR_MODE,
  PLUGIN_FILE_MODE,
  isSafePluginId,
  pluginsRootDir,
  ensurePluginsRoot,
  listInstalledPluginIds,
  readInstalledPlugin,
  PluginHost,
} from "./plugins/loader.js";
// Marketplace registry client. Fetches + validates an index (HTTPS only) and
// applies the signature policy; the index is DATA, never code — nothing here
// executes anything. The community plugin registry index ships as the default
// (`DEFAULT_REGISTRY_URL`); an operator can override or disable it.
export {
  DEFAULT_REGISTRY_URL,
  unconfiguredVerifier,
  fetchRegistryIndex,
  searchInstallable,
  findInstallable,
} from "./plugins/registry-client.js";
export type {
  RegistryResult,
} from "./plugins/registry-client.js";
// Plugin wire protocol (pure). Message shapes + total decoders shared by the
// host, tests, and any third-party plugin SDK.
export {
  PROTOCOL_VERSION,
} from "./plugins/protocol.js";
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
export { runSourceFix, verifySourceFixCandidate, applySourceFixCandidate, planSourceFixPublication, publishSourceFixDraftPR } from "./fix/index.js";
export { resolveSourceFixRepository, loadSourceFixProjectInputs, saveSourceFixProjectInputs } from "./fix/index.js";
export type {
  SourceFixPublicationPlan,
  SourceFixResult,
  SourceFixStatus,
  SourceFixTestResult,
} from "./fix/index.js";

// Deterministic replay runner. Consumes a finding's `pocSteps`, sequentially
// executes them through local, SmolVM, Docker, or QEMU isolation, and emits a canonical
// `VerificationResult` payload matching `@0/engine/shared/verification`. Cloud's
// worker-controller can call this directly in-process without shelling out to
// the CLI.
//
// Names that would collide with existing exports (StepResult,
// DEFAULT_STEP_TIMEOUT_MS) are re-exported under prefixed aliases so
// callers can pick a side without ambiguity.
export {
  runDeterministicReplay,
  LocalShellRunner,
  SmolvmRunner,
  createSmolvmPocTargetRunner,
  runSmolvmPocSteps,
  DockerRunner,
  QemuRunner,
  assertionFromStepExpect,
  evaluateAssertion,
} from "./verify/index.js";
export {
  createReproductionBundle,
  runReproductionBundle,
} from "./verify/reproduction-bundle.js";
export type {
  BundlePlan,
  ReproductionBundleResult,
} from "./verify/reproduction-bundle.js";
// in the cli package; this surface is the programmatic entry point.
export {
  loadH1Credentials,
  H1AuthMissingError,
  H1Client,
  H1Error,
  H1AuthError,
  H1ForbiddenError,
  H1RateLimitError,
  H1NetworkError,
  listPrograms,
  getProgram,
  getStructuredScopes,
  automationVerdict,
  summariseScopes,
  toScopeFile,
} from "./h1/index.js";
export type {
  H1Program,
} from "./h1/index.js";

// Cloud credentials and the independent Windows evidence-worker transport.
export {
  loadCloudCredentials,
} from "./cloud/index.js";

// CVE artifact scraping (#272 v0 part 1). Finds public PoC artifacts,
// write-ups, and affected-version metadata for a given CVE id by hitting
// NVD, GHSA, OSV, distro trackers, and GitHub search. Building/running
// the PoC is the next slice (depends on #271 Tier-1 plumbing).
export {
  findCveArtifacts,
  normaliseCveId,
} from "./cve/index.js";
export type {
  ScrapedCveArtifacts,
} from "./cve/index.js";

// Disclosure bundle assembly (finding → GHSA-ready advisory markdown)
export {
  suggestCwesForCategory,
  suggestCvss,
  renderAdvisoryMarkdown,
  EmptyPocError,
  redactSensitiveHeaders,
  renderExploitScreenshot,
  isFreezeAvailable,
  verifyAgainstRef,
  detectVersionRange,
  extractSiblingFix,
  executePocSteps,
  setRuntimeDeps,
  MAX_CAPTURE_BYTES,
  decideFilingState,
  assembleBundleIndex,
  formatDroppedReason,
  droppedFilename,
  dropSlug,
} from "./disclose/index.js";
export type {
  AdvisoryContext,
  AdvisoryScreenshot,
  PatchStatus,
  ReverifyResult,
  VersionRangeResult,
  PocExecutionTarget,
  PocExecutionReport,
  PocStepResult,
  PocOverallVerdict,
  BundleEntry,
} from "./disclose/index.js";

// #928 — disclosure-process tracking (status state machine + timeline) and the
// evidence-pack assembler (finding → vendor-notification draft). DRAFT-only,
// never sends.
export {
  DISCLOSURE_STATUSES,
  createDisclosureRecord,
  transition,
  assembleEvidencePack,
  renderVendorNotificationMarkdown,
  UnreproducedFindingError,
} from "./disclose/index.js";
export type {
  DisclosureStatus,
  DisclosureRecord,
  EvidencePackOptions,
} from "./disclose/index.js";

// PR-shaped finding output (0#377). `emitFindingsAsPRs` turns reproduced
// findings into one GitHub PR each (repro + suggested patch from a fix-template
// registry); non-reproduced findings roll up into a single hypotheses.md.
export {
  emitFindingsAsPRs,
  isReproduced,
} from "./emit/index.js";
export type {
  EvidenceArtifact,
} from "./emit/index.js";

// ── Scan-level pass@k bench harness (0#556) ──
// Turns the per-finding verify oracles into a scan-level scorecard
// (success rate, FP rate vs known-negatives, cost-per-success) + CI gate.
export * from "./bench/index.js";

// ── Interactive operator console: unified conversational front-end that drives
// the full tool registry through the real ToolExecutor + LlmApiRuntime. ──
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
  ConsoleEngagementSelection,
  ConsoleSessionCheckpoint,
  ConsoleSessionConfig,
  ConsoleRenderCallbacks,
  ConsoleTurnOutcome,
  ConsoleAutonomyMode,
  ConsoleScopeRequest,
  ConsoleUsageReport,
  AutoTitleInput,
  AutoTitleResult,
  ConversationTitleSource,
} from "./console/index.js";

// ── Recon mode: domain surface enumeration (0#769) ──
// Given a domain, probes well-known OpenAPI/Swagger + MCP endpoints and emits
// a deduped, structured asset inventory consumable as discovered_assets.
export {
  runRecon,
} from "./recon/recon.js";
export type {
  ReconAsset,
  ReconResult,
  ReconOptions,
} from "./recon/recon.js";
// Active subdomain brute-force (0#924) — OFF by default, scope-gated +
// time-boxed; merges into runRecon's subdomain assets when enabled.
export {
  DEFAULT_CONCURRENCY,
} from "./recon/active-subdomains.js";

// Target-neutral research control plane. Existing engines remain native and
// opt in through adapters; the common runner owns stage order and evidence.
export * from "./research/index.js";
// JS-driven endpoint + secret discovery (0#927) — scope-gated,
// deny-by-default; mines a site's JS bundles for endpoints + redacted secrets.
export {
  runJsRecon,
} from "./recon/js-recon.js";
export type {
  JsReconResult,
} from "./recon/js-recon.js";
export type {
  FetchTextResult,
} from "./recon/js-artifacts.js";
// Extract JS chunk URLs from a page's HTML (resolves relative, dedupes,
// .js/.mjs only) — feeds runJsRecon's scriptUrls from a single page fetch.
export { enumerateJsChunkUrls } from "./recon/stack-fingerprint.js";
// Live cloud-surface probes (0#925) — read-only, gated behind the
// ZERO_FEATURE_CLOUD_SURFACE flag AND an engagement ScopePolicy.
export {
  probeS3Bucket,
  classifyTakeover,
  bucketInScope,
  validateAwsCredentials,
} from "./agent/cloud-surface.js";
export type {
  BucketProbeResult,
  TakeoverVerdict,
  CredentialValidationResult,
} from "./agent/cloud-surface.js";

// Protocol-conformance capability (issue #972) — Tier-1 HTTP spec-vs-impl
// differential: LLM hypothesizes divergences, a deterministic oracle confirms.
export {
  runHttpConformanceCheck,
  createLiveHttpSender,
} from "./protocol/index.js";
export type {
  HttpConformanceResult,
  ConformanceAttempt,
} from "./protocol/index.js";

// xnu-fuzz — IOKit user-client fuzzer (dynamic sibling to the xnu-re review
// profile). See docs/0-iokit-fuzzer.md and src/xnu-fuzz/.
export * from "./xnu-fuzz/index.js";
export * from "./adgraph/index.js";
export * from "./identity/index.js";
export * from "./attack/index.js";

// Local, redacted reproducibility manifests for verified findings.
export {
  assembleReproducibilityManifest,
  renderReproducibilityManifest,
  UnverifiedFindingError,
  IncompleteEvidenceError,
} from "./disclose/reproducibility-manifest.js";

// Improvement-plane promotion policy. This evaluates sealed benchmark
// receipts and appends tamper-evident decision records; it never executes or
// deploys a candidate into an active engagement worker.
export {
  DEFAULT_IMPROVEMENT_PROMOTION_POLICY,
  appendImprovementLedgerEntry,
  evaluateImprovementPromotion,
  verifyImprovementLedger,
} from "./bench/improvement-promotion.js";
export type {
  ImprovementCandidate,
  ImprovementLedgerEntry,
  ImprovementPromotionDecision,
} from "./bench/improvement-promotion.js";

// Isolated, evaluated self-rewriting candidates and pinned future workers.
export * from "./improvement/index.js";

// Self-securing software lifecycle: prepare → investigate → behavioral repair
// → independent verification → patch/PR delivery, with persisted resume state.
export { runSecureProject } from "./secure/project.js";
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

export { connectServicePlugins, testServicePluginConnection } from "./agent/service-plugins.js";

// Transport-independent workflow execution and owned lifecycle.
export * from "./workflow-runner.js";
export * from "./workflow-service.js";
export * from "./engine-service.js";
export {
  executeAssessment,
  executeAssessmentRun,
} from "./assessment.js";
export { budgetNativeRuntime } from "./scan-plan.js";
export * from "./learning-service.js";
export { HuntMemoryStore } from "./memory/hunt-memory.js";

export * from "./report-export.js";


export {
  qualifyTaskRouting,
  parseRoutingQualificationPlan,
  taskRoutingFixtureRuntime,
  recommendQualifiedRouting,
} from "./bench/task-routing.js";

export { createLocalOllamaRoutingRuntime } from "./bench/local-ollama-routing.js";
export { listBrowserViews, subscribeBrowserView } from "./agent/browser-live.js";

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
