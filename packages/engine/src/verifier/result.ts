/**
 * Typed verifier result (pure). Stored additively on the Finding or fix
 * record; old records without it stay valid. Only harness code builds one.
 */

export type VerifyStatus = "pass" | "fail" | "not-run" | "error";
export type CanaryState = "ok" | "missing" | "n/a";

export interface VerifierResult {
  schemaVersion: 1;
  status: VerifyStatus;
  /** Short machine-readable cause, for example criteria-met, no-container-runtime, detector-did-not-run. */
  reason: string;
  command: string;
  /** sha256 digest of the pinned image, when the run used one. */
  imageDigest?: string;
  isolation: "container" | "host";
  durationMs: number;
  /** Last 2 KB of combined step output, secrets redacted. */
  logTail: string;
  /** Exit code of the first failing step, 0 when every step exited 0, null when no step finished. */
  exitCode?: number | null;
  canary: CanaryState;
  baseline?: { before: number; after: number };
  /** Skill that declared the verifier, when there was one. */
  skillId?: string;
}

export const LOG_TAIL_BYTES = 2048;

export function tailOf(text: string, max = LOG_TAIL_BYTES): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** Format seconds like the doc examples: 14.2s. */
export function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}
