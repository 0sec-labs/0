import { features } from "@0/engine";

/**
 * Read-only catalogue of the engine's `ZERO_FEATURE_*` flags. The engine resolves them from the
 * process environment on every read (see engine/src/agent/features.ts), so none can be changed
 * at runtime: this page can only report them. A test pins this list against the engine source so
 * a new flag cannot ship without a label here.
 */
export interface FeatureFlagDefinition { id: keyof typeof features; env: string; label: string; description: string; default: boolean }
export type FeatureFlagSource = "env" | "preset" | "default";
export interface FeatureFlagRow { id: string; env: string; label: string; description: string; default: boolean; value: boolean; source: FeatureFlagSource; tier: "stable" | "experimental"; settable: false }
export interface FeatureFlagsResponse { flags: FeatureFlagRow[]; preset: string | null; settable: false }

const def = (id: keyof typeof features, env: string, label: string, description: string, defaultValue: boolean): FeatureFlagDefinition => ({ id, env: `ZERO_FEATURE_${env}`, label, description, default: defaultValue });

export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  def("loopDetection", "LOOP_DETECTION", "Loop detection", "Warns the agent when it repeats the same tool calls (A-A-A or A-B-A-B).", true),
  def("contextCompaction", "CONTEXT_COMPACTION", "Context compaction", "Compresses the middle of a long conversation when the context grows large.", true),
  def("retainedReasoning", "RETAINED_REASONING", "Retained reasoning", "Re-sends the model's opaque reasoning items on the next turn. Turn off only for matched A/B runs.", true),
  def("progressHandoff", "PROGRESS_HANDOFF", "Progress handoff", "Carries earlier attempts' findings into a retry.", true),
  def("webSearch", "WEB_SEARCH", "Web search", "Lets the agent look up CVE details, docs and technique references.", true),
  def("wpFingerprint", "WP_FINGERPRINT", "WordPress fingerprinting", "Adds a WordPress plugin and theme fingerprinter with CVE lookup.", true),
  def("mongoObjectIdForge", "MONGO_OBJECTID_FORGE", "MongoDB ObjectID forge", "Adds a tool that computes ObjectIds with chosen timestamps, for IDOR checks.", true),
  def("decoyDetection", "DECOY_DETECTION", "Decoy flag detection", "Rejects proposed flags that look like honeypot decoys, once, with a hint to keep exploring.", true),
  def("holdingItWrong", "HOLDING_IT_WRONG", "Holding-it-wrong filter", "Rejects findings that only describe a function doing its documented job.", true),
  def("evidenceGate", "EVIDENCE_GATE", "Evidence gate", "Drops findings that lack cross-source evidence (request, response, analysis).", true),
  def("preReconCve", "PRE_RECON_CVE", "Pre-recon dependency audit", "Runs a dependency audit on white-box scans and tells the agent about serious advisories.", true),
  def("webRecon", "WEB_RECON", "Web recon pre-pass", "Cheap, non-destructive HTTP and DNS probes before the agent's first turn.", true),
  def("targetHistoryPreseed", "TARGET_HISTORY_PRESEED", "Target history pre-seed", "Looks up prior vulnerabilities for a source review and adds a short summary to the prompt.", true),
  def("preserveCriticalMessages", "PRESERVE_CRITICAL_MESSAGES", "Keep critical messages", "Keeps credential and exploit-bearing messages verbatim when the conversation is compacted.", true),
  def("budgetWarnings", "BUDGET_WARNINGS", "Budget warnings", "Warns the agent as it nears its turn budget so it can wrap up cleanly.", true),
  def("perItemOrchestration", "PER_ITEM_ORCHESTRATION", "Per-file orchestration", "Research and audit stages call the agent once per source file.", true),
  def("lootLedger", "LOOT_LEDGER", "Loot ledger", "Tracks credentials, tokens and endpoints found so later steps can chain them.", true),
  def("promptCache", "PROMPT_CACHE", "Prompt caching", "Caches the stable request prefix with Anthropic models. Turn off only to isolate a provider caching bug.", true),
  def("earlyStopRetry", "EARLY_STOP", "Early stop and retry", "At half the budget with no findings, stops and retries with another strategy. Meant for benchmarks.", false),
  def("dynamicPlaybooks", "DYNAMIC_PLAYBOOKS", "Dynamic playbooks", "Injects vulnerability playbooks after the recon phase.", false),
  def("ruleInjection", "RULE_INJECTION", "Rule injection", "Injects short do and don't rules when a matching tool action runs.", false),
  def("externalMemory", "EXTERNAL_MEMORY", "External memory", "The agent writes its plan and credentials to disk and re-reads them at checkpoints.", false),
  def("ptySession", "PTY_SESSION", "Interactive terminals", "Interactive PTY sessions for reverse shells, database clients and SSH.", false),
  def("pythonExec", "PYTHON_EXEC", "Python REPL", "A persistent, compute-only Python kernel; networking is blocked during an engagement.", false),
  def("zeroverse", "ZEROVERSE", "Binary analysis bridge", "Lets a model request long-running binary analysis through 0verse.", false),
  def("specialistRouting", "SPECIALIST_ROUTING", "Specialist routing", "Runs search branches with a vulnerability-class specialist prompt and tools.", false),
  def("selfConsistencyVerify", "CONSENSUS_VERIFY", "Consensus verification", "Runs structured verification several times and takes the majority vote.", false),
  def("multiModalAgreement", "MULTIMODAL", "Multi-modal agreement", "Cross-checks findings against the foxguard pattern scanner.", false),
  def("reachabilityGate", "REACHABILITY_GATE", "Reachability gate", "Rejects findings whose vulnerable code cannot be reached.", false),
  def("publishabilityGate", "PUBLISHABILITY_GATE", "Publishability gate", "Decides whether a finding is worth disclosing: threat-model exclusions, duplicates, fixed versions.", false),
  def("povGate", "POV_GATE", "Proof-of-vulnerability gate", "Requires a working proof before a finding is accepted.", false),
  def("semanticDedupe", "SEMANTIC_DEDUPE", "Semantic dedupe", "Clusters duplicate findings with a model after the scan. Costs model calls.", false),
  def("llmRemediation", "LLM_REMEDIATION", "Model-written remediation", "Writes finding-specific remediation instead of static advice. One extra model call per finding.", false),
  def("incrementalRank", "INCREMENTAL_RANK", "Incremental ranking", "Orders the report by exploitability, impact and evidence with model calls.", false),
  def("pocGenStatic", "POC_GEN_STATIC", "PoC generation for static findings", "Builds and runs a minimal proof of concept for findings that ship without one.", false),
  def("inlineValidation", "INLINE_VALIDATION", "Inline validation", "Runs a fast deterministic check as soon as a high or critical finding is saved.", false),
  def("cloudSurface", "CLOUD_SURFACE", "Cloud surface testing", "Probes S3 buckets and validates harvested AWS credentials, read-only.", false),
  def("memsafetyFuzz", "MEMSAFETY", "Memory-safety fuzzing", "Builds and fuzzes a source tree. Runs untrusted build scripts and native code.", false),
  def("npmDynamicDiscovery", "NPM_DISCOVERY", "npm dynamic discovery", "Installs and runs untrusted npm packages under instrumentation.", false),
  def("kernelWeaponize", "KERNEL_WEAPONIZE", "Kernel weaponization", "Kernel-exploit ladder; only inside a disposable kernel VM and within an engagement scope.", false),
  def("cveAdapt", "CVE_ADAPT", "CVE PoC adaptation", "Adapts a public CVE proof of concept to the target and runs it.", false),
  def("learnedRouter", "LEARNED_ROUTER", "Learned triage router", "Scores findings with rules distilled from a trained triage model.", false),
  def("dynamicTriageRouting", "DYNAMIC_TRIAGE", "Dynamic triage routing", "Chooses which triage layers to run for each finding.", false),
  def("jitSkills", "JIT_SKILLS", "Skill discovery hints", "Extra prompting about skills. Defaults on only when a skills manifest is assigned.", false),
  def("executionJournal", "EXECUTION_JOURNAL", "Execution journal", "Writes an append-only journal of tool calls and results for each run.", false),
  def("journalRehydrate", "JOURNAL_REHYDRATE", "Journal rehydration", "Seeds the agent's context from the on-disk execution journal.", false),
  def("agentPlan", "AGENT_PLAN", "Agent plan ledger", "Gives the agent a typed task list that is re-shown as it works.", false),
  def("driftDetection", "DRIFT_DETECTION", "Drift detection", "Re-anchors the agent when its activity drifts away from the objective.", false),
  def("oastCollaborator", "OAST", "Out-of-band collaborator", "Confirms blind SSRF, XSS and RCE through a hosted DNS and HTTP callback.", false),
];

const isEnabledByPreset = (key: string, env: NodeJS.ProcessEnv): boolean => Boolean(env["ZERO_FEATURE_PRESET"]) && env[key] === undefined;

/** Pure view of the flags. `read` supplies the engine's current value so env parsing stays in one place. */
export function describeFeatureFlags(env: NodeJS.ProcessEnv, read: (id: keyof typeof features) => boolean): FeatureFlagsResponse {
  const preset = env["ZERO_FEATURE_PRESET"]?.trim() || null;
  const flags = FEATURE_FLAG_DEFINITIONS.map((flag): FeatureFlagRow => {
    const value = read(flag.id);
    const source: FeatureFlagSource = env[flag.env] !== undefined ? "env" : value && !flag.default && isEnabledByPreset(flag.env, env) ? "preset" : "default";
    return { id: flag.id, env: flag.env, label: flag.label, description: flag.description, default: flag.default, value, source, tier: flag.default ? "stable" : "experimental", settable: false };
  });
  return { flags, preset, settable: false };
}

export const featureFlagsSnapshot = (): FeatureFlagsResponse => describeFeatureFlags(process.env, id => Boolean(features[id]));
