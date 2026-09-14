import type {
  PresentationTranscriptDocument,
  PresentationTranscriptEntry,
} from "@0sec/shared";
import {
  renderMarkdown,
  spansToText,
} from "./markdown.js";
import { repeatSuffix } from "./transcript.js";
import {
  planTranscript,
  type TranscriptDetail,
} from "./transcript-style.js";
import { sanitizeTuiText } from "./text.js";

export type TranscriptReviewTone =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "failure"
  | "notice"
  | "fold";

export interface TranscriptReviewLine {
  text: string;
  tone: TranscriptReviewTone;
  turn: number;
  entryId?: string;
}

export interface TranscriptReviewDocument {
  lines: TranscriptReviewLine[];
  text: string;
}

export interface TranscriptReviewOptions {
  width: number;
  detail: TranscriptDetail;
  expandedTurns?: ReadonlySet<number>;
}

/**
 * A horizontal rule, `width` cells wide, clamped to a readable 3..80.
 *
 * Repeated characters are the proven rule idiom in this codebase; per-edge
 * border arrays are not, and the review document is a single flat text buffer
 * that has no borders to speak of in any case. Exported so the review's own
 * chrome (`chat/TranscriptReview.tsx`) draws the same rule as a markdown `---`
 * inside the transcript, rather than a second, slightly different one.
 */
export function reviewRule(width: number): string {
  const cells = Number.isFinite(width) ? Math.floor(width) : 0;
  return "─".repeat(Math.max(3, Math.min(cells, 80)));
}

/**
 * The gutter glyph that opens an entry's header line.
 *
 * The review is one native text buffer with a single foreground colour, so the
 * per-line `tone` cannot be painted — the hierarchy has to live in the
 * characters. These are the SAME glyphs the live chat uses for the same
 * meanings (`✓` done, `×` failed, `▶` running, `·` quiet, `▸` folded), so an
 * operator does not learn a second vocabulary to read the review.
 */
const GUTTER = {
  speaker: "▌",
  quiet: "·",
  running: "▶",
  done: "✓",
  failed: "×",
} as const;

function markdownLines(source: string, width: number): string[] {
  const lines: string[] = [];
  const blockWidth = Math.max(8, width);

  for (const block of renderMarkdown(source, blockWidth)) {
    if (block.kind === "rule") {
      lines.push(reviewRule(blockWidth));
      continue;
    }

    if (block.kind === "code") {
      for (const line of block.lines) lines.push(`  ${line}`);
      continue;
    }

    if (block.kind === "table") {
      lines.push(block.header.map(spansToText).join(" │ "));
      for (const row of block.rows) lines.push(row.map(spansToText).join(" │ "));
      continue;
    }

    if (block.kind === "listItem") {
      for (const [index, line] of block.lines.entries()) {
        const prefix = index === 0
          ? `${" ".repeat(block.indent)}${block.marker} `
          : " ".repeat(block.indent + block.marker.length + 1);
        lines.push(`${prefix}${spansToText(line)}`);
      }
      continue;
    }

    const prefix = block.kind === "heading"
      ? `${"#".repeat(block.level)} `
      : block.kind === "quote"
        ? "│ "
        : "";
    for (const line of block.lines) lines.push(`${prefix}${spansToText(line)}`);
  }

  return lines;
}

function detailLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => sanitizeTuiText(line))
    .filter(Boolean);
}

function reviewDetail(entry: PresentationTranscriptEntry, detail: TranscriptDetail): string[] {
  if (detail === "expanded") {
    const rich = entry.commandOutput ?? entry.editDiff ?? entry.webAnswer;
    if (rich) return detailLines(rich);
  }
  return detailLines(entry.detail);
}

function pushLines(
  document: TranscriptReviewLine[],
  lines: readonly string[],
  tone: TranscriptReviewTone,
  entry: PresentationTranscriptEntry,
  indent: string = "",
): void {
  for (const text of lines) {
    if (!text) continue;
    document.push({ text: `${indent}${text}`, tone, turn: entry.turn, entryId: entry.id });
  }
}

function compileEntry(
  document: TranscriptReviewLine[],
  entry: PresentationTranscriptEntry,
  options: TranscriptReviewOptions,
): void {
  const width = Math.max(8, options.width - 2);
  const repeat = repeatSuffix(entry.repeat);

  if (entry.kind === "user" || entry.kind === "assistant") {
    const tone = entry.kind === "user" ? "user" : "assistant";
    document.push({
      text: `${GUTTER.speaker} ${entry.kind === "user" ? "OPERATOR" : "0SEC"}${repeat}`,
      tone,
      turn: entry.turn,
      entryId: entry.id,
    });
    pushLines(document, markdownLines(entry.text, width), tone, entry, "  ");
    return;
  }

  if (entry.kind === "reasoning") {
    document.push({ text: `${GUTTER.quiet} THINKING${repeat}`, tone: "reasoning", turn: entry.turn, entryId: entry.id });
    pushLines(document, markdownLines(entry.text, width), "reasoning", entry, "  ");
    return;
  }

  if (entry.kind === "tool" || entry.kind === "subagent") {
    const failed = entry.success === false || entry.subagentOutcome === "failed";
    const tone = failed ? "failure" : "tool";
    const state = failed ? "failed" : entry.success === undefined && entry.subagentOutcome === undefined ? "running" : "done";
    const label = entry.kind === "subagent" ? "AGENT" : "TOOL";
    const args = entry.toolArgs ? ` · ${entry.toolArgs}` : "";
    // The glyph restates the state the words already give, because the words
    // scroll past at a glance and the gutter does not. Never guessed: it is
    // derived from the same `state` the label prints.
    const glyph = state === "failed" ? GUTTER.failed : state === "running" ? GUTTER.running : GUTTER.done;
    document.push({ text: `${glyph} ${label} ${state} · ${entry.text}${args}${repeat}`, tone, turn: entry.turn, entryId: entry.id });
    pushLines(document, reviewDetail(entry, options.detail), tone, entry, "  ");
    if (entry.subagentSummary) pushLines(document, detailLines(entry.subagentSummary), tone, entry, "  ");
    if (entry.subagentError) pushLines(document, detailLines(entry.subagentError), "failure", entry, "  ");
    return;
  }

  const tone = entry.kind === "error" ? "failure" : "notice";
  const glyph = tone === "failure" ? GUTTER.failed : GUTTER.quiet;
  document.push({ text: `${glyph} ${entry.text}${repeat}`, tone, turn: entry.turn, entryId: entry.id });
  pushLines(document, detailLines(entry.detail), tone, entry, "  ");
}

/**
 * Compile the shared transcript document into a deterministic, line-oriented
 * review projection. Native TextBufferView owns final terminal wrapping and
 * scrolling.
 */
export function compileTranscriptReview(
  transcript: PresentationTranscriptDocument,
  options: TranscriptReviewOptions,
): TranscriptReviewDocument {
  const lines: TranscriptReviewLine[] = [];
  const plan = planTranscript(transcript.entries, options.detail, options.expandedTurns);

  for (const item of plan) {
    if (item.type === "fold") {
      lines.push({ text: `▸ ${item.summary}`, tone: "fold", turn: item.turn });
      continue;
    }

    compileEntry(lines, item.entry, options);
    lines.push({ text: "", tone: "notice", turn: item.entry.turn, entryId: item.entry.id });
  }

  while (lines.at(-1)?.text === "") lines.pop();
  return { lines, text: lines.map((line) => line.text).join("\n") };
}
