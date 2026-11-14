import { join } from "node:path";
import { type PreparedProjectContext, type ProposedProjectObservation } from "../secure/project-context.js";
import type { ScanDepth, OutputFormat, RuntimeMode, ScanMode, Finding, NpmAuditFinding, SeedFinding, ScanConfig, ReviewCheckResult, ScanPlan, ScanPlanExecution } from "../shared/index.js";
import { ScanCostLedger } from "../agent/cost-ledger.js";
import { type ScopePolicy } from "../scope/scope.js";
import type { NpmPackageRunner } from "../stages/npm-detectors/sandbox-probe.js";
import type { RuntimeConfig, NativeRuntime } from "../runtime/types.js";

export interface PipelineOptions extends Omit<ScanConfig, "costLedger"> {
  target: string;
  targetType?: "npm-package" | "pypi-package" | "cargo-package" | "oci-image" | "source-code" | "url" | "web-app";
  depth: ScanDepth;
  format: OutputFormat;
  runtime?: RuntimeMode;
  mode?: ScanMode;
  /** Optional bounded guided plan. */
  plan?: ScanPlan;
  /** Shared ledger for a multi-run plan. */
  costLedger?: ScanCostLedger;
  agentModels?: Readonly<Record<string, string>>;
  autoRoute?: boolean;
  singleModel?: boolean;
  nativeRuntime?: NativeRuntime;
  provider?: RuntimeConfig["provider"];
  signal?: AbortSignal;
  scope?: ScopePolicy;
  /** A parent plan emits one terminal event after every attempt settles. */
  emitTerminalEvent?: boolean;
  resumeScanId?: string;
  diffBase?: string;
  changedOnly?: boolean;
  onEvent?: (event: { type: string; stage?: string; message: string; data?: unknown; runIndex?: number }) => void;
  getPendingUserMessages?: () => string[];
  dbPath?: string;
  /** Stable local execution id. Fresh runs allocate one; cloud runs use scan id. */
  runId?: string;
  /**
   * Prior confirmed findings supplied to a new review. They are rendered as
   * untrusted evidence: investigate adjacent or variant paths, but do not
   * restate them without fresh evidence. This makes a fresh re-scan extend
   * earlier work instead of rediscovering the same cases.
   */
  priorFindings?: Array<{
    id: string;
    title: string;
    category: string;
    description?: string;
    location?: string;
  }>;
  /** Approved immutable project preferences, rendered as untrusted context. */
  projectContext?: PreparedProjectContext;
  onProjectObservations?: (observations: ProposedProjectObservation[]) => void;
  apiKey?: string;
  model?: string;
  timeout?: number;
  packageVersion?: string;
  costCeilingUsd?: number;
  /**
   * Review profile (only consulted when targetType === "source-code").
   * - `default`: web/JS/TS/Python application-layer review.
   * - `c-library`: foundational C/C++ libraries — memory safety, integer
   *   bugs, allocation paths. Pairs with the tier-1/2/3 harness scaffolder.
   * - `linux-kernel`: Linux kernel source review — syscall/ioctl/netlink
   *   surface, copy_from_user discipline, refcount races, skb cow/share
   *   violations (Dirty Frag class). Static-only; verification via #271/#272.
   */
  reviewProfile?: "default" | "c-library" | "linux-kernel" | "cardano-onchain" | "solana-onchain" | "evm-onchain" | "cairo-onchain" | "move-onchain" | "cardano-haskell" | "xnu-kernel" | "xnu-re";
  /**
   * Review the SOURCE of a published package. When set, `target` is a
   * package NAME (not a repo path / git URL): the pipeline installs the
   * package via the ecosystem installer (npm/pypi/cargo/oci), then reviews
   * its extracted source tree. Crucially `resolvedType` stays
   * `"source-code"` so the full review pipeline applies (profile prompt,
   * review report, "review" resume-session key) — unlike `targetType`
   * package kinds, which key the analysis to the audit path. Only consulted
   * when `targetType === "source-code"` (the `review` command sets both).
   * `packageVersion` pins the version; unset installs latest.
   */
  reviewPackageEcosystem?: "npm" | "pypi" | "cargo" | "oci";
  /**
   * Restrict the kernel-review agent to files under this subdirectory
   * (e.g. `crypto/`, `net/tcp/`). Only meaningful when
   * `reviewProfile === "linux-kernel"`. Injected into the agent prompt
   * as a hard scope restriction.
   */
  subsystem?: string;
  /**
   * Operator hypothesis to seed the agent with a specific research direction.
   * Injected at the top of the agent's system prompt as a priority investigation
   * target. Works with all review profiles (default, c-library, linux-kernel).
   * Modeled after Xint Code's operator prompt that found CVE-2026-31431.
   */
  hypothesis?: string;
  /**
   * PR/MR discussion thread (untrusted) to review against. The latest
   * author message drives this run and must be answered explicitly in
   * the final summary. When the agent is blocked on knowledge only the
   * team has, it may add questions to the report's top-level `questions` array.
   */
  conversation?: string;
  /**
   * External candidate vulnerable spans (e.g. from `gemmaforge scan`) to seed
   * the review agent's worklist alongside — or instead of — semgrep. Each
   * record carries its own source tag, so provenance survives into the agent
   * prompt and downstream reports. Closes 0#368.
   */
  seedFindings?: SeedFinding[];
  /**
   * Skip semgrep entirely and let `seedFindings` be the sole source of leads.
   * No-op when `seedFindings` is empty (the pipeline falls back to semgrep
   * automatically, since "no leads" is worse than "best-effort leads").
   */
  seedOnly?: boolean;
  /**
   * OPT-IN: run the npm dynamic-discovery detector sweep (SSPP fuzz /
   * validation read-stability / SSRF parser-diff) over the target package, in
   * addition to the static review agent. Only effective for npm-ecosystem
   * targets (`--ecosystem npm` package-source reviews or `npm-package` audits).
   * Off by default (extra install + untrusted-exec cost); also enabled by the
   * `ZERO_NPM_DYNAMIC_DISCOVERY` env toggle for cloud config. Confirmed leads
   * join `findings` so they flow into the same verify → disclosure path.
   */
  npmDynamicDiscovery?: boolean;
  /**
   * Test/worker seam: inject the per-package sandbox runner the dynamic-discovery
   * stage uses. Unset ⇒ the default local sandbox runner (fresh temp dir +
   * child-process harness). The cloud worker injects an e2b-backed runner.
   */
  npmDynamicRunner?: NpmPackageRunner;
}

export interface PipelineReport extends ScanPlanExecution {
  target: string;
  targetType: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  summary: {
    totalAttacks: number;
    totalFindings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  findings: Finding[];
  warnings: Array<{ stage: string; message: string }>;
  /** Results of approved per-repository checks, evaluated during the same review run. */
  reviewChecks?: ReviewCheckResult[];
  /** Primary research failed; report findings are partial and not a clean verdict. */
  researchFailed?: boolean;
  /**
   * True when the run terminated early because the shared per-scan cost
   * ceiling (`--cost-ceiling` / ZERO_COST_CEILING_USD) was reached —
   * research tripped it or the verify wave was skipped/truncated on budget.
   * The CLI maps this to exit code 4 and the cloud lands the scan
   * `cost_exceeded` (never a clean pass). Absent on normal completions.
   */
  costCeilingExceeded?: boolean;
  /** Terminal reason; mirrors the agentic-scanner report contract. */
  exitReason?: "completed" | "failed" | "cost_ceiling_exceeded" | "time_cap_exceeded" | "cancelled" | "partial";
  // Extras for backwards compat
  package?: string;
  version?: string;
  repo?: string;
  semgrepFindings?: number;
  npmAuditFindings?: NpmAuditFinding[];
}

// ── Internal helpers ──
