/**
 * Approvals vocabulary and the capability policy.
 *
 * There is one mode: the agent has shell access. Nothing is selected per Thread, Agent
 * or automation. What limits a run is the target scope (hosts and paths), the budget
 * (cost ceiling, time cap), the optional sandbox executor and the global operator setting
 * "Ask before running commands" (`ask`, or `auto` which is the default).
 *
 * Older stored access values (observe, recon, read-only, act, run, copilot, propose,
 * standard, changes, commands, pull-requests) stay readable forever so old databases,
 * threads, checkpoints and saved automations load without error; they all mean the single
 * mode. Nothing is rewritten eagerly. {@link legacyAskedFirst} tells which old values used
 * to ask before every action, so an upgraded thread keeps asking first.
 *
 * The golden test in approvals.test.ts pins the table.
 */
/** Every value an older release stored or accepted for thread/Agent access. All mean the one mode. */
export const LEGACY_ACCESS_VALUES: readonly string[] = ["standard", "recon", "copilot", "yolo", "observe", "propose", "run", "act", "read-only", "changes", "commands", "pull-requests"];
/** Stored or supplied value from before there was one mode. Read, never written, never acted on. */
export type LegacyAutonomyMode = "standard" | "recon" | "copilot" | "yolo" | "observe" | "propose" | "run" | "act" | "read-only" | "changes";

/** True for older values that asked before every action: standard threads and propose Agents. */
export function legacyAskedFirst(value: unknown): boolean {
  return value === "standard" || value === "propose";
}

export type ApprovalsChoice = "ask" | "auto";
export const APPROVALS_CHOICES: readonly ApprovalsChoice[] = ["ask", "auto"];

/** Parse a user-facing value; undefined when it is not `ask` or `auto`. */
export function parseApprovals(value: unknown): ApprovalsChoice | undefined {
  return value === "ask" || value === "auto" ? value : undefined;
}

export interface ExecutionPolicy {
  /** Every effectful tool call is put to the operator before it runs. */
  readonly asksBeforeEffectfulTools: boolean;
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

const AUTO_POLICY: ExecutionPolicy = { asksBeforeEffectfulTools: false, publicNetwork: true, fullShell: true, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: true, verificationReceipts: true, scopeExpansion: "target-related" };

/** The global "Ask before running commands" setting on: every effectful call is put to the operator, scope grants wait for a prompt. */
const ASK_FIRST_POLICY: ExecutionPolicy = { asksBeforeEffectfulTools: true, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" };

/**
 * What the one mode allows. `ask` (the global "Ask before running commands" setting) puts every effectful tool
 * call to the operator and keeps the narrower capability set the setting always had (no public-network shortcut,
 * tokenised commands, folder and network scope grants behind a prompt); it never grants anything.
 * A legacy access value handed straight to the engine only matters when it used to ask first.
 */
export function executionPolicy(approvals?: ApprovalsChoice | boolean, legacyAccess?: unknown): ExecutionPolicy {
  return approvals === "ask" || approvals === true || legacyAskedFirst(legacyAccess) ? ASK_FIRST_POLICY : AUTO_POLICY;
}
