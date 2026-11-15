/**
 * Approvals vocabulary and capability policy.
 *
 * Users meet exactly one choice: run commands automatically (`auto`, the
 * default) or ask first (`ask`). The persisted engine values stay
 * `standard | recon | copilot | yolo` so stored threads and checkpoints keep
 * working; this module is the one place that maps between the two vocabularies.
 *
 * `executionPolicy` separates what a mode ALLOWS from whether it ASKS. The
 * legacy auto mode also unlocks capabilities (public-network tools, full shell
 * syntax, automatic folder grants); those are explicit flags here so a rename
 * can never silently widen or narrow behaviour. The golden test in
 * approvals.test.ts pins the table.
 */
export type ApprovalsChoice = "ask" | "auto";
export type ApprovalsEngineMode = "standard" | "recon" | "copilot" | "yolo";

export const APPROVALS_CHOICES: readonly ApprovalsChoice[] = ["ask", "auto"];

/** Read a stored engine mode as a user-facing choice: yolo/copilot -> auto, standard/recon -> ask. */
export function approvalsFromMode(mode: string | undefined): ApprovalsChoice {
  return mode === "yolo" || mode === "copilot" ? "auto" : "ask";
}

/** The engine mode written for a user-facing choice. */
export function modeFromApprovals(choice: ApprovalsChoice): "standard" | "yolo" {
  return choice === "ask" ? "standard" : "yolo";
}

/** Parse a user-facing value; undefined when it is not `ask` or `auto`. */
export function parseApprovals(value: unknown): ApprovalsChoice | undefined {
  return value === "ask" || value === "auto" ? value : undefined;
}

/**
 * The mode a session actually runs in given the operator's "Ask before running
 * commands" setting. Ask-first only ever tightens: auto modes run `standard`,
 * recon (already refuses effectful tools) and standard are unchanged.
 */
export function effectiveEngineMode<M extends string>(mode: M, setting: ApprovalsChoice | undefined): M | "standard" {
  return setting === "ask" && (mode === "yolo" || mode === "copilot") ? "standard" : mode;
}

export interface ExecutionPolicy {
  /** Every effectful tool call is put to the operator before it runs. */
  readonly asksBeforeEffectfulTools: boolean;
  /** Effectful tools are refused outright (passive, read-only). */
  readonly refusesEffectfulTools: boolean;
  /** Public-network tools run without a mandatory launch target or per-host approval. */
  readonly publicNetwork: boolean;
  /** Commands use full shell syntax instead of tokenised commands and pipes. */
  readonly fullShell: boolean;
  /** The scoped source-audit allow-list is lifted inside the configured scope. */
  readonly liftsAuditAllowList: boolean;
  /** Console workers inherit the parent's advertised tools. */
  readonly inheritsConsoleTools: boolean;
  /** Any non-dangerous local path is granted without a prompt. */
  readonly autoGrantsLocalPaths: boolean;
  /** Builds a verification receipt from the finding ledger on save_finding. */
  readonly verificationReceipts: boolean;
  /** How the network scope grows: never, within the engagement, or around the target. */
  readonly scopeExpansion: "ask" | "engagement" | "target-related";
}

const POLICIES: Readonly<Record<ApprovalsEngineMode, ExecutionPolicy>> = {
  standard: { asksBeforeEffectfulTools: true, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" },
  recon: { asksBeforeEffectfulTools: false, refusesEffectfulTools: true, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" },
  copilot: { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "engagement" },
  yolo: { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: true, fullShell: true, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: true, verificationReceipts: true, scopeExpansion: "target-related" },
};

export function executionPolicy(mode: string | undefined): ExecutionPolicy {
  return POLICIES[mode !== undefined && Object.hasOwn(POLICIES, mode) ? (mode as ApprovalsEngineMode) : "standard"];
}
