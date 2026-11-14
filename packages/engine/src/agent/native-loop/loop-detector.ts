import type { NativeMessage } from "../../runtime/types.js";

// ── Loop / Oscillation Detection ──
// Inspired by BoxPwnr (97.1% on XBOW): when the agent gets stuck repeating the
// same commands, inject a warning to break the cycle.

interface ToolCallFingerprint {
  name: string;
  argPrefix: string; // first 100 chars of JSON-stringified arguments
}

export class LoopDetector {
  private history: ToolCallFingerprint[] = [];
  private readonly windowSize = 6;
  /** Track which pattern signatures already fired so we don't spam. */
  private firedPatterns = new Set<string>();

  /** Record one or more tool calls from a single turn. */
  record(calls: Array<{ name: string; arguments: unknown }>): void {
    for (const c of calls) {
      const argStr = typeof c.arguments === "string"
        ? c.arguments
        : JSON.stringify(c.arguments ?? "");
      this.history.push({
        name: c.name,
        argPrefix: argStr.slice(0, 100),
      });
    }
    // Keep bounded
    if (this.history.length > this.windowSize * 2) {
      this.history = this.history.slice(-this.windowSize * 2);
    }
  }

  /** Returns a warning string if a loop is detected, or null otherwise. */
  detect(): string | null {
    const h = this.history;
    if (h.length < 3) return null;

    const fp = (e: ToolCallFingerprint) => `${e.name}:${e.argPrefix}`;

    // Pattern 1: Same exact command repeated 3+ times in a row
    if (h.length >= 3) {
      const last = fp(h[h.length - 1]!);
      const prev1 = fp(h[h.length - 2]!);
      const prev2 = fp(h[h.length - 3]!);
      if (last === prev1 && last === prev2) {
        const sig = `repeat:${last}`;
        if (!this.firedPatterns.has(sig)) {
          this.firedPatterns.add(sig);
          return LOOP_WARNING;
        }
      }
    }

    // Pattern 2: A-B-A-B alternating pattern (2+ full cycles = 4 entries)
    if (h.length >= 4) {
      const a1 = fp(h[h.length - 4]!);
      const b1 = fp(h[h.length - 3]!);
      const a2 = fp(h[h.length - 2]!);
      const b2 = fp(h[h.length - 1]!);
      if (a1 !== b1 && a1 === a2 && b1 === b2) {
        const sig = `alt:${a1}|${b1}`;
        if (!this.firedPatterns.has(sig)) {
          this.firedPatterns.add(sig);
          return LOOP_WARNING;
        }
      }
    }

    return null;
  }
}

/**
 * Header of the dynamic-playbook block, used as a presence marker so the loop
 * can tell whether the methodology is still in the live message window or was
 * removed by a compaction pass. Must stay in sync with the header emitted by
 * `buildPlaybookInjection` (agent/playbooks.ts) — `sop-flags.test.ts` asserts
 * that they match, so a rename there fails loudly here rather than silently
 * disabling the restore.
 */
export const PLAYBOOK_MARKER = "## Dynamic Playbook Injection";

/**
 * Whether any message in the window contains `needle`.
 *
 * Bounded and cheap: the window is the loop's own conversation array (kept
 * small by compaction) and the scan short-circuits on the first hit. Deliberately
 * a substring test on serialized text rather than structural matching, because
 * the block can come back in two shapes — as the original standalone user
 * message, or folded into a compaction summary by
 * `features.preserveCriticalMessages` (playbook text is full of "password" /
 * "admin" / "token", so it frequently trips the critical-message regex). Either
 * shape means the methodology is still in front of the model, and neither
 * warrants re-injecting it.
 */
export function messagesContainText(messages: NativeMessage[], needle: string): boolean {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text.includes(needle)) return true;
      if (block.type === "tool_result" && block.content.includes(needle)) return true;
    }
  }
  return false;
}

const LOOP_WARNING =
  "⚠ You appear stuck in a loop repeating the same commands. " +
  "Try a COMPLETELY DIFFERENT approach — different tool, different endpoint, different payload.";

// ── Two-stage budget warnings (Strix-inspired, 0#408) ──
//
// Distinct from the existing `buildContinuePrompt` checkpoints (which only
// fire when the model emits zero tool calls and the loop has to nudge it):
// these warnings fire on a normal tool-call turn — once at ~85% of the
// turn budget so the model has time to pivot to a clean handoff, and once
// at `maxTurns − 3` as a final shove. Each one fires at most once per run;
// the flag pair `budgetWarningsFired` lives on the loop's closure.
//
// 85% uses Math.ceil so a 20-turn budget warns on turn 17, matching the
// issue spec (PR #406 §11 Strix comparison). For small budgets where the
// two thresholds coincide (e.g. maxTurns=20 → soft=17, hard=17), we fire
// BOTH messages in order — the soft warning first, then the hard one. The
// alternative (suppress the soft when they collide) would silently change
// the at-most-once invariant on a per-warning basis, and the test bar in
// #408 explicitly asserts two distinct warning strings appear.

/** Soft warning injected at ~85% of the turn budget. */
export const BUDGET_WARNING_SOFT =
  "[0 budget] Preserve credible findings with `save_finding` and retain the evidence and current plan for a clean handoff.";

/** Hard warning injected at `maxTurns − 3`. */
export const BUDGET_WARNING_HARD =
  "[0 budget] The configured execution allowance is nearly exhausted. Preserve verified findings and summarize unfinished work.";

/**
 * Compute the two budget-warning turn thresholds for a given `maxTurns`.
 *
 * - `soft`: `ceil(maxTurns * 0.85)` — fired the first turn where
 *   `turnCount >= soft`.
 * - `hard`: `max(1, maxTurns - 3)` — fired the first turn where
 *   `turnCount >= hard`.
 *
 * Both clamp to at least 1 so degenerate `maxTurns <= 3` runs still get
 * a hard warning on turn 1 instead of `-2`. Exported so the legacy loop
 * (`loop.ts`) and unit tests share the same math.
 */
export function computeBudgetWarningTurns(maxTurns: number): { soft: number; hard: number } {
  const soft = Math.max(1, Math.ceil(maxTurns * 0.85));
  const hard = Math.max(1, maxTurns - 3);
  return { soft, hard };
}
