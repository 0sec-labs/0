/**
 * Claim gate (pure). Decides what a Thread may say when it finishes. Only a
 * harness-produced `pass` earns the word "Verified"; the model's own prose
 * never does.
 */
import { formatDuration, type VerifierResult } from "./result.js";

const REASONS: Record<string, string> = {
  "no-container-runtime": "no container runtime is available",
  "detector-did-not-run": "detector did not run",
  "not-a-git-repo": "the folder is not a Git repository",
  "no-baseline": "the tree before the change could not be captured",
  timeout: "the check timed out",
};

/** One plain line for the UI and the reply. */
export function verificationLine(result: VerifierResult): string {
  if (result.status === "pass" && result.isolation === "container") {
    const delta = result.baseline ? `, ${result.baseline.before} to ${result.baseline.after} findings` : "";
    return `Verified by: ${result.command} passed${delta} (${formatDuration(result.durationMs)})`;
  }
  if (result.status === "pass") return `Not verified: ${result.command} passed on this machine without isolation`;
  const why = REASONS[result.reason] ?? result.reason.replace(/-/g, " ");
  if (result.status === "fail") return `Not verified: ${result.command} failed (${why})`;
  if (result.status === "not-run") return `Not verified: ${why}`;
  return `Not verified: ${why}`;
}

export function isVerified(result: VerifierResult | undefined): boolean {
  return result?.status === "pass" && result.isolation === "container";
}

const CLAIM = /\b(fixed|resolved|remediated|hardened|verified|merge[- ]ready|all (checks|tests) pass(ed)?|clean)\b/i;
const NEGATED = /\b(not|never|no|n't|unable to|could not|couldn't|cannot|can't)\b[^.\n]{0,24}\b(fixed|resolved|remediated|hardened|verified)\b/i;

/** True when the reply claims the work is fixed or verified. */
export function claimsFixed(text: string): boolean {
  return CLAIM.test(text) && !NEGATED.test(text);
}

export interface GateInput {
  /** The skill declared a verifier. */
  declared: boolean;
  claim: string;
  result: VerifierResult | undefined;
}

export interface GateDecision {
  /** False when the claim must not stand as written. */
  allowed: boolean;
  line: string | undefined;
  /** The final message: the claim plus the recorded line, or the claim marked not verified. */
  message: string;
}

/**
 * `done(claim)` for a skill that declares verify: a fixed or verified claim
 * stands only when the harness verifier passed. Without a declared verifier
 * the claim is passed through untouched.
 */
export function gateDone(input: GateInput): GateDecision {
  if (!input.declared) return { allowed: true, line: undefined, message: input.claim };
  const result = input.result;
  const line = result ? verificationLine(result) : "Not verified: the check was not run";
  const verified = isVerified(result);
  const allowed = verified || !claimsFixed(input.claim);
  const body = input.claim.trimEnd();
  const message = verified ? `${body}\n\n${line}` : `${body}\n\n${line}${claimsFixed(input.claim) ? "\nThe claim above is not backed by a passing check." : ""}`;
  return { allowed, line, message };
}
