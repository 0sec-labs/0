import type { ChatEntry } from "./types.js";

/**
 * Pure layout helpers for the subagent-launch "Task" card.
 *
 * OMP's Goal / Constraints / Contract are NOT structured fields — they are
 * model-authored Markdown `# H1` headings inside one freeform `context` string,
 * pinned by the tool prompt (see `spawn_agents`' `context` description). We
 * mirror that: the producer stores the freeform blob on `taskContext`, and this
 * module splits it back into labelled sections at render time. A producer that
 * already parsed the headings out can instead set `taskGoal` / `taskConstraints`
 * / `taskContract`, which win over re-parsing.
 *
 * No React / theme here so the mapping is unit-testable in isolation.
 */

/** The three canonical batch-context headings, in render order. */
const CONTEXT_HEADINGS = ["Goal", "Constraints", "Contract"] as const;
type ContextHeading = (typeof CONTEXT_HEADINGS)[number];

/** A markdown H1 line that opens one of the canonical sections (`# Goal`, …). */
const CONTEXT_HEADING_RE = /^#\s+(Goal|Constraints|Contract)\b.*$/i;

export interface SplitTaskContext {
  goal?: string;
  constraints?: string;
  contract?: string;
  /** Any leading prose before the first recognised heading. */
  rest?: string;
}

/**
 * Split a batch `context` blob on its `# Goal` / `# Constraints` / `# Contract`
 * H1 headings. Content before the first recognised heading (if any) is returned
 * as `rest`; unrecognised trailing headings stay inside the section they follow,
 * so nothing the model wrote is dropped. The heading line itself is removed —
 * the card redraws it as a `SectionRule` label.
 */
export function splitTaskContext(md: string | undefined): SplitTaskContext {
  const text = (md ?? "").trim();
  if (!text) return {};
  const lines = text.split("\n");
  const out: SplitTaskContext = {};
  let current: ContextHeading | "rest" = "rest";
  const buffers: Record<ContextHeading | "rest", string[]> = {
    Goal: [],
    Constraints: [],
    Contract: [],
    rest: [],
  };
  for (const line of lines) {
    const match = CONTEXT_HEADING_RE.exec(line.trim());
    if (match) {
      // Normalise to the canonical capitalisation of the matched heading.
      const canonical = CONTEXT_HEADINGS.find(
        (h) => h.toLowerCase() === match[1].toLowerCase(),
      );
      if (canonical) {
        current = canonical;
        continue;
      }
    }
    buffers[current].push(line);
  }
  const rest = buffers.rest.join("\n").trim();
  if (rest) out.rest = rest;
  for (const heading of CONTEXT_HEADINGS) {
    const body = buffers[heading].join("\n").trim();
    if (body) out[heading.toLowerCase() as Lowercase<ContextHeading>] = body;
  }
  return out;
}

export interface TaskMarkdownSection {
  /** Section-rule label (already human-cased; the rule upper-cases it). */
  label: string;
  /** Markdown body for the section. */
  text: string;
}

/**
 * The ordered markdown sections a Task card draws above its sub-report bullets.
 *
 * Precedence, mirroring OMP's `renderCall`:
 *   1. Pre-split `taskGoal` / `taskConstraints` / `taskContract` if a producer
 *      supplied them.
 *   2. Otherwise split `taskContext` on its `# Goal/# Constraints/# Contract`
 *      headings; any leading prose falls under a single `Context` section.
 *   3. A single-agent `taskAssignment` brief always draws last, under
 *      `Assignment`.
 */
export function taskMarkdownSections(entry: ChatEntry): TaskMarkdownSection[] {
  const sections: TaskMarkdownSection[] = [];
  const preSplit = entry.taskGoal || entry.taskConstraints || entry.taskContract;
  if (preSplit) {
    if (entry.taskGoal?.trim()) sections.push({ label: "Goal", text: entry.taskGoal.trim() });
    if (entry.taskConstraints?.trim())
      sections.push({ label: "Constraints", text: entry.taskConstraints.trim() });
    if (entry.taskContract?.trim())
      sections.push({ label: "Contract", text: entry.taskContract.trim() });
  } else if (entry.taskContext?.trim()) {
    const split = splitTaskContext(entry.taskContext);
    if (split.rest) sections.push({ label: "Context", text: split.rest });
    if (split.goal) sections.push({ label: "Goal", text: split.goal });
    if (split.constraints) sections.push({ label: "Constraints", text: split.constraints });
    if (split.contract) sections.push({ label: "Contract", text: split.contract });
  }
  if (entry.taskAssignment?.trim())
    sections.push({ label: "Assignment", text: entry.taskAssignment.trim() });
  return sections;
}

/**
 * One flattened body row for the Task card's bounded context region.
 *
 * The Goal / Constraints / Contract / Assignment sections are collapsed into a
 * single interleaved list of height-1 rows — a `rule` row per section label,
 * then one `text` row per source line — so the card can bound the WHOLE lot to
 * a line budget exactly the way the normal ToolCard bounds its Output. Keeping
 * this a flat, countable list (rather than nested Markdown blocks of unknown
 * height) is what lets the card cap its rendered rows deterministically instead
 * of painting an over-tall body over the transcript below it.
 */
export type TaskBodyLine =
  | { readonly kind: "rule"; readonly label: string }
  | { readonly kind: "text"; readonly text: string };

/**
 * Flatten the ordered Markdown sections into one interleaved line list: a
 * `rule` row carrying each section's label, followed by one `text` row per
 * line of that section's body. Pure and width-free — the renderer fits each
 * text row to its column — so the mapping is unit-testable in isolation.
 */
export function taskBodyLines(sections: readonly TaskMarkdownSection[]): TaskBodyLine[] {
  const out: TaskBodyLine[] = [];
  for (const section of sections) {
    out.push({ kind: "rule", label: section.label });
    for (const line of section.text.split("\n")) out.push({ kind: "text", text: line });
  }
  return out;
}

/**
 * Cap a flattened body-line list to a row budget, reporting how many rows were
 * folded away. Mirrors the normal card's `visible = retained.slice(0, limit)`
 * + `hidden = retained.length - visible.length` so the collapsed taste and the
 * `… N more lines` hint share one arithmetic.
 */
export function capTaskBodyLines(
  lines: readonly TaskBodyLine[],
  limit: number,
): { visible: TaskBodyLine[]; hidden: number } {
  const cap = Math.max(0, Math.floor(limit));
  const visible = lines.slice(0, cap);
  return { visible, hidden: Math.max(0, lines.length - visible.length) };
}

/**
 * Agent rows shown before the rest fold into a single `… N more agents`
 * summary line — matches OMP's `COLLAPSED_AGENT_LIMIT`.
 */
export const COLLAPSED_SUBREPORT_LIMIT = 4;

/**
 * Hard cap on agent rows even when expanded, so a huge batch can never grow the
 * card without bound. Expanding reveals far more than the collapsed taste but
 * still stops at a deterministic ceiling.
 */
export const EXPANDED_SUBREPORT_LIMIT = 32;

export interface SubReportRow {
  /** Bold-accent identifier, e.g. `ExtensionReadiness`. */
  name: string;
  /** `(scout)`-style badge suffix, empty for the generic worker. */
  badge: string;
  /** Muted task first line, empty when none. */
  brief: string;
  /** ` [isolated]` suffix, empty otherwise. */
  isolated: string;
}

/**
 * Project the sub-report bullets a collapsed/expanded card draws, plus the count
 * of agents folded into the overflow line. `expanded` uncaps the list.
 */
export function subReportRows(
  subReports: ChatEntry["subReports"],
  expanded: boolean,
  expandedLimit: number = Number.MAX_SAFE_INTEGER,
): { rows: SubReportRow[]; hidden: number } {
  const list = subReports ?? [];
  if (list.length === 0) return { rows: [], hidden: 0 };
  const cap = expanded
    ? Math.min(list.length, Math.max(0, Math.floor(expandedLimit)))
    : Math.min(list.length, COLLAPSED_SUBREPORT_LIMIT);
  const rows = list.slice(0, cap).map((sr) => ({
    name: sr.name?.trim() || "agent",
    badge: sr.agent?.trim() ? ` (${sr.agent.trim()})` : "",
    brief: sr.brief?.trim() ? `: ${sr.brief.trim()}` : "",
    isolated: sr.isolated ? " [isolated]" : "",
  }));
  return { rows, hidden: list.length - cap };
}
