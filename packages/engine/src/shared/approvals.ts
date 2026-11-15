/**
 * Access and approvals vocabulary, and the capability policy.
 *
 * Users meet exactly two access states everywhere: Read-only and Can make changes
 * (`read-only | changes`). Whether commands run automatically or are put to the
 * operator first is NOT a third state: it is only the global operator setting
 * "Ask before running commands" (`ask`, or `auto` which is the default), applied
 * on top of `changes`.
 *
 * Older stored values stay readable forever so old databases, threads, checkpoints
 * and saved automations load: observe, recon -> read-only; act, run, yolo, copilot,
 * propose, standard -> changes. New writes use only the two values; nothing is
 * rewritten eagerly. {@link legacyAskedFirst} tells which old values used to ask
 * before every action, for the one-time upgrade notice.
 *
 * `executionPolicy` lists what each state ALLOWS as explicit flags, so a rename can
 * never silently widen or narrow behaviour. The golden test in approvals.test.ts
 * pins the table.
 */
export type ConsoleAccess = "read-only" | "changes";
export const CONSOLE_ACCESS_VALUES: readonly ConsoleAccess[] = ["read-only", "changes"];
/** Stored values from before access collapsed to two states. Read, never written. */
export type LegacyAutonomyMode = "standard" | "recon" | "copilot" | "yolo" | "observe" | "propose" | "run" | "act";
export const DEFAULT_CONSOLE_ACCESS: ConsoleAccess = "changes";

const LEGACY_READ_ONLY: ReadonlySet<string> = new Set(["read-only", "recon", "observe"]);
const LEGACY_CHANGES: ReadonlySet<string> = new Set(["changes", "standard", "copilot", "yolo", "propose", "run", "act", "commands", "pull-requests"]);

/** Parse a current or older value; undefined when it is neither. */
export function parseAccess(value: unknown): ConsoleAccess | undefined {
  return typeof value !== "string" ? undefined : LEGACY_READ_ONLY.has(value) ? "read-only" : LEGACY_CHANGES.has(value) ? "changes" : undefined;
}
/** Read any stored value as one of the two states; anything unknown is Read-only (the safe side). */
export function normalizeAccess(value: unknown, fallback: ConsoleAccess = "read-only"): ConsoleAccess {
  return value === undefined || value === null ? fallback : parseAccess(value) ?? "read-only";
}
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

const READ_ONLY_POLICY: ExecutionPolicy = { asksBeforeEffectfulTools: false, refusesEffectfulTools: true, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" };
const CHANGES_POLICY: ExecutionPolicy = { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: true, fullShell: true, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: true, verificationReceipts: true, scopeExpansion: "target-related" };

/** Can make changes with the global "Ask before running commands" setting on: the former standard capability set. */
const ASK_FIRST_POLICY: ExecutionPolicy = { asksBeforeEffectfulTools: true, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" };

/**
 * What a state allows. Read-only has the capability set of the former recon mode; changes has the former yolo set.
 * `ask` (the global "Ask before running commands" setting) puts every effectful tool call to the operator and keeps
 * the narrower capability set the setting always had (no public-network shortcut, tokenised commands, folder and
 * network scope grants behind a prompt); it never grants anything and has no effect on Read-only, which refuses
 * effectful tools outright.
 * An unknown or missing access is Read-only.
 */
export function executionPolicy(access: string | undefined, approvals?: ApprovalsChoice | boolean): ExecutionPolicy {
  if (normalizeAccess(access) === "read-only") return READ_ONLY_POLICY;
  // An older "standard" value handed straight to the engine still asks first.
  return approvals === "ask" || approvals === true || legacyAskedFirst(access) ? ASK_FIRST_POLICY : CHANGES_POLICY;
}
