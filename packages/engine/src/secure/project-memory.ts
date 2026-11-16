// Learning loop for the secure lifecycle: recall what the folder's Memory says before investigation,
// write the outcome of each repair back after it. Recalled notes are untrusted hints, never evidence.
import { memoryContext, memoryDisabledByEnv, openMemory } from "../notes/index.js";
import type { Finding } from "../shared/index.js";
import type { BehavioralRepairResult } from "./types.js";

export interface RepairLearning {
  findingId: string;
  category: string;
  title: string;
  status: BehavioralRepairResult["status"];
  attempts: number;
  changedFiles: string[];
  model?: string;
}

/** The folder's notes (and global ones), rendered as untrusted hints for the investigation prompt. */
export function recallRepairLearnings(repoRoot: string): string[] {
  if (memoryDisabledByEnv()) return [];
  try {
    return memoryContext(openMemory(), repoRoot, 600).notes.map((note) => `[prior note, untrusted] ${note.text}`);
  } catch {
    return []; // Memory is an optimization, never a failure mode.
  }
}

/** Persist the outcome of one repair attempt as a folder note: a verified fix is a fix-decision, anything else is something to avoid. */
export function recordRepairLearning(
  repoRoot: string,
  _runId: string,
  finding: Finding,
  repair: BehavioralRepairResult,
): void {
  if (memoryDisabledByEnv()) return;
  if ((repair.changedFiles ?? []).length === 0) return;
  try {
    const verified = repair.status === "verified";
    const text = verified
      ? `Repair of "${finding.title}" (${finding.category}) was verified after ${repair.attempts} attempt(s); the pattern fixed the root cause and kept legitimate behavior.`
      : `Repair of "${finding.title}" (${finding.category}) ${repair.status} after ${repair.attempts} attempt(s): ${repair.reason ?? "no reason"}. Do not repeat the same approach without new evidence.`;
    openMemory().add({ text, scope: "folder", folder: repoRoot, kind: verified ? "fix-decision" : "avoid", source: "model", tainted: true }); // written from scan data: context for the model, never trusted by the verifier
  } catch {
    // A memory write failure must never block a verified repair.
  }
}
