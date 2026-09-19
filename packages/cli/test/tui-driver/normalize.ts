/**
 * Frame normalization for stable TUI snapshots.
 *
 * A captured character frame carries a few things that change run-to-run even
 * when the UI is identical: an animating spinner cell, an elapsed-time label
 * that ticks, and the build version string. `normalizeFrame` masks exactly
 * those and nothing more, so a snapshot diff reflects a real UI change rather
 * than the clock. It is deliberately conservative — it does not touch prose,
 * so a scenario asserting on real content still sees that content verbatim.
 */

import { VERSION } from "@0sec/shared";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Match the build version, with or without a leading "v", so both `0.16.3` and
// `v0.16.3` collapse to a single stable token.
const VERSION_RE = new RegExp("v?" + escapeRegExp(VERSION), "g");

/**
 * Normalize a captured character frame for stable comparison.
 *
 * Order matters: the two-part elapsed label (`3m20s`) is collapsed before the
 * single-unit one (`20s`) so the minutes half is not eaten first.
 */
export function normalizeFrame(s: string): string {
  return s
    // Build version → vX.
    .replace(VERSION_RE, "vX")
    // Elapsed labels: `3m20s` then bare `20s`.
    .replace(/\b\d+m\d+s\b/g, "NmNs")
    .replace(/\b\d+s\b/g, "Ns")
    // Clock timestamps like 09:14 or 09:14:07.
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "HH:MM")
    // Spinner / rail braille cells (U+2800–U+28FF) → a single stable dot.
    .replace(/[⠀-⣿]/g, "·")
    // Trailing whitespace per line.
    .replace(/[ \t]+$/gm, "");
}
