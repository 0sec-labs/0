/** @jsxImportSource @opentui/react */
import React, { type MutableRefObject, useMemo } from "react";
import type { PresentationTranscriptDocument } from "@0/shared"
import type { Theme } from "../theme-context.js";
import { useSymbols } from "../symbol-context.js";
import {
  compileTranscriptReview,
  reviewRule,
  type TranscriptReviewDocument,
} from "../transcript-review.js";
import { operatorIcon } from "../operator-icons.js";
import { sanitizeTuiText } from "../text.js";
import "../transcript-review-renderable.js";
import type { TranscriptReviewRenderable } from "../transcript-review-renderable.js";
import type { TranscriptDetail } from "../transcript-style.js";
import type { CompactionRecap } from "./types.js";

export interface TranscriptReviewProps {
  transcript: PresentationTranscriptDocument;
  width: number;
  detail: TranscriptDetail;
  expandedTurns: ReadonlySet<number>;
  theme: Theme;
  renderableRef: MutableRefObject<TranscriptReviewRenderable | null>;
  /**
   * When a context compaction has retained history, the recap the overlay shows
   * ABOVE the live transcript: its summary plus the pre-compaction messages that
   * were rewritten away. Absent when no compaction has happened this session, in
   * which case the overlay behaves exactly as it always has.
   */
  recap?: CompactionRecap;
}

/**
 * Flatten a retained pre-compaction history into readable, bounded review text.
 * Each content block becomes one labelled line; tool calls and results are
 * truncated so a large history still renders (the review scrolls). Never throws.
 */
function formatRecapMessages(recap: CompactionRecap): string {
  const lines: string[] = [];
  for (const message of recap.preCompactionMessages) {
    const who = message.role === "user" ? "▸ user" : "◂ assistant";
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) lines.push(`${who}: ${text}`);
      } else if (block.type === "tool_use") {
        let args = "";
        try {
          args = JSON.stringify(block.input);
        } catch {
          args = "{…}";
        }
        lines.push(`  ⚙ ${block.name}(${args.length > 200 ? `${args.slice(0, 200)}…` : args})`);
      } else if (block.type === "tool_result") {
        const raw = typeof block.content === "string" ? block.content : String(block.content ?? "");
        const body = raw.trim();
        if (body) lines.push(`  ↳ ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`);
      }
    }
  }
  return lines.join("\n\n");
}

export function TranscriptReview({
  transcript,
  width,
  detail,
  expandedTurns,
  theme,
  renderableRef,
  recap,
}: TranscriptReviewProps) {
  const symbols = useSymbols();
  const document = useMemo<TranscriptReviewDocument>(
    () => compileTranscriptReview(transcript, { width, detail, expandedTurns }),
    [detail, expandedTurns, transcript, width],
  );
  // Title + footer-style hint row + a rule, in the dialog language but drawn
  // with repeated characters — this is one flat text buffer, so a rule is the
  // only chrome available and `reviewRule` is the codebase's proven idiom.
  //
  // The entry count is the real length of the transcript we were handed; the
  // one-entry case is spelled correctly rather than reading "1 entries", and an
  // empty transcript says so instead of printing "0 entries" under a heading.
  const count = transcript.entries.length;
  // The registered `replay` glyph, always beside its label — never glyph-only.
  const title = `${operatorIcon("replay", symbols)} TRANSCRIPT REVIEW`;
  const hints = "Esc / Ctrl+O live · PgUp/PgDn scroll · Ctrl+Home/Ctrl+End jump";
  const rule = reviewRule(width);
  const baseContent = document.text
    ? [
        `${title} · ${count} ${count === 1 ? "entry" : "entries"}`,
        hints,
        rule,
        "",
        document.text,
      ].join("\n")
    : [
        title,
        hints,
        rule,
        "",
        "No transcript entries yet.",
      ].join("\n");
  // A retained recap sits ABOVE the live transcript: the summary the model
  // rewrote the middle history into, then the retained messages themselves, so
  // the operator can read exactly what was folded away. A degraded compaction
  // kept its history but produced no usable summary, so it says so plainly.
  const recapText = recap
    ? sanitizeTuiText(
        [
          `${operatorIcon("replay", symbols)} PRE-COMPACTION RECAP · ${recap.tokensBefore}→${recap.tokensAfter ?? "?"} tok`,
          rule,
          "",
          recap.degraded
            ? "Summary unavailable — this compaction degraded to a hard trim."
            : `Summary:\n${recap.summaryText.trim() || "(empty)"}`,
          "",
          `Retained history · ${recap.preCompactionMessages.length} ${recap.preCompactionMessages.length === 1 ? "message" : "messages"}:`,
          "",
          formatRecapMessages(recap) || "(no textual content)",
          "",
          rule,
          "",
        ].join("\n"),
      )
    : null;
  const content = recapText ? `${recapText}\n${baseContent}` : baseContent;

  return (
    <box flexGrow={1} minHeight={0} width="100%" minWidth={0} backgroundColor={theme.PANEL}>
      <transcript-review
        ref={renderableRef}
        content={content}
        fg={theme.TEXT}
        bg={theme.PANEL}
        wrapMode="word"
        selectable
        height="100%"
        width="100%"
      />
    </box>
  );
}
