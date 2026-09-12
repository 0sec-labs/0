/** @jsxImportSource @opentui/react */
import React, { type MutableRefObject, useMemo } from "react";
import type { PresentationTranscriptDocument } from "@0sec/shared";
import type { Theme } from "../theme-context.js";
import {
  compileTranscriptReview,
  reviewRule,
  type TranscriptReviewDocument,
} from "../transcript-review.js";
import { operatorIcon } from "../operator-icons.js";
import "../transcript-review-renderable.js";
import type { TranscriptReviewRenderable } from "../transcript-review-renderable.js";
import type { TranscriptDetail } from "../transcript-style.js";

export interface TranscriptReviewProps {
  transcript: PresentationTranscriptDocument;
  width: number;
  detail: TranscriptDetail;
  expandedTurns: ReadonlySet<number>;
  theme: Theme;
  renderableRef: MutableRefObject<TranscriptReviewRenderable | null>;
}

export function TranscriptReview({
  transcript,
  width,
  detail,
  expandedTurns,
  theme,
  renderableRef,
}: TranscriptReviewProps) {
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
  const title = `${operatorIcon("replay")} TRANSCRIPT REVIEW`;
  const hints = "Esc / Ctrl+O live · PgUp/PgDn scroll · Ctrl+Home/Ctrl+End jump";
  const rule = reviewRule(width);
  const content = document.text
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
