import type { ScanConfig } from "@0/shared";
import type { ScanListener } from "../scanner.js";
import type { NativeRuntime, RuntimeConfig } from "../runtime/types.js";
import { ScopePolicy } from "../scope/scope.js";
import { runMemSafetyScan } from "../stages/memsafety-scan.js";
import type { MemSafetyScanOptions } from "../stages/memsafety-scan.js";
import type { MemSafetyTarget } from "../triage/memsafety-types.js";
import { runCraftScan } from "../stages/craft-scan.js";
import type { CraftTarget, CraftScanOptions } from "../stages/craft-scan.js";

export interface AgenticScanOptions {
  config: ScanConfig;
  dbPath?: string;
  nativeRuntime?: NativeRuntime;
  provider?: RuntimeConfig["provider"];
  scope?: ScopePolicy;
  /**
   * Stable execution identity. Cloud workers supply their orchestrator scan id;
   * local callers may provide one to make run-local state resumable.
   */
  runId?: string;
  onEvent?: ScanListener;
  /** Poll for user-injected messages from the TUI at turn boundaries. */
  getPendingUserMessages?: () => string[];
  /** Optional hint/description for benchmark challenges */
  challengeHint?: string;
  /** Resume from a previous scan (uses persisted sessions) */
  resumeScanId?: string;
  /**
   * Suppress this invocation's scan_completed event when it is a child of a
   * higher-level fan-out. The parent owns one aggregated terminal event.
   */
  emitTerminalEvent?: boolean;
  /**
   * Userspace / Rust memory-safety scan role ("Monty-mode", 0#700). When
   * set, the scan dispatches to the focused `runMemSafetyScan` stage
   * (audit-playbook → closed fuzz loop → crash triage) and returns early,
   * BEFORE any of the live-target / DB / runtime machinery below runs. The
   * existing web/API/audit flows are byte-for-byte unaffected when this is
   * undefined. Optional knobs for the fuzz loop ride along in `memSafety`.
   */
  memSafetyTarget?: MemSafetyTarget;
  /** Optional fuzz-loop / logging knobs forwarded to `runMemSafetyScan`. */
  memSafety?: Omit<MemSafetyScanOptions, "target">;
  /**
   * Craft scan role — the agentic sibling of the memory-safety fuzz path. When
   * set, the agent reads the pre-patch source with read-only tools and crafts a
   * PoC input, testing each candidate against the injected `craft.evaluatePoc`
   * oracle (CyberGym differential for benchmarks; a local sanitizer runner for
   * real targets). Dispatches to `runCraftScan` and returns early, like the
   * memSafety path. Unaffected web/API/audit flows when undefined.
   */
  craftTarget?: CraftTarget;
  /** The PoC oracle + agent-loop knobs forwarded to `runCraftScan` (required when craftTarget is set). */
  craft?: Omit<CraftScanOptions, "target" | "runtime">;
}
