/** @jsxImportSource @opentui/react */
import React from "react";
import { TextAttributes } from "@opentui/core";
import { MODEL_PRICING, type ModelRates } from "@0sec/shared";
import { fitTuiText, sanitizeTuiText } from "../text.js";
import { ShimmerText } from "./shimmer.js";
import { renderMarkdown } from "../markdown.js";
import { formatElapsed } from "../animation.js";
import { repeatSuffix } from "../transcript.js";
import { panelColumns } from "../panels.js";
import { MessageCard } from "./MessageCard.js";
import { messageCardFromPeerEntry } from "./message-card-layout.js";
import {
  foldSummary,
  roleLabelText,
  roundedCardFrame,
  speechFrame,
  toolCompactLine,
  toolDetailWidth,
  toolFrame,
  type TranscriptPlanItem,
} from "../transcript-style.js";
import { renderMarkdownBlocks } from "./markdown-blocks.js";
import type { Theme } from "../theme-context.js";
import type { ChatEntry, EntryDisplay } from "./types.js";
import { ToolCard } from "./ToolCard.js";
import { ImageCard } from "./ImageCard.js";
import { toolActionTitle, toolState, toolStateLabel } from "./card-layout.js";

/**
 * Mouse affordances for a clickable transcript row (a collapsed fold, or a
 * collapsible step inside an expanded turn). Entirely optional: when omitted,
 * the row renders exactly as before with no handlers, so keyboard-only use and
 * restored transcripts are untouched. Chat-screen supplies these only for the
 * rows that participate in per-turn expand/collapse.
 */
export interface TranscriptRowInteraction {
  /** Explicit per-turn expansion overrides the default transcript detail. */
  expanded?: boolean;
  /** True when this row's turn is currently hover-highlighted. */
  hovered?: boolean;
  /** Toggle this turn between folded and fully expanded. */
  onToggle?: () => void;
  /** Report pointer enter (true) / leave (false) for this row's turn. */
  onHover?: (hovering: boolean) => void;
}

/**
 * Normalize a reasoning stream for display.
 *
 * Reasoning summaries arrive as a sequence of bold headers with no
 * separator between them, so the raw text reads `**A****B****C**`. Four
 * adjacent asterisks are never a single intended run — it is always one
 * bold closing and the next opening — so split them onto their own lines.
 */
function normalizeReasoning(text: string): string {
  return text.replace(/\*\*\*\*/g, "**\n\n**");
}


/** Compact relative age, e.g. "12s" / "4m" / "2h". */
function relativeAge(at: number | undefined, now: number): string {
  // Restored entries carry no timestamp; return empty so the caller can omit
  // the separator entirely rather than rendering a dangling "0sec ·".
  if (!at) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}


/**
 * Priced rate rows by lower-cased model id, mirroring status-bar.ts. "default"
 * is excluded on purpose: it is shared's fallback for an UNKNOWN model, and
 * pricing an unrecognised id at it would put a fabricated figure on screen.
 * Kept local (rather than importing status-bar's private map) so the footer's
 * cost estimate never routes through shared's `estimateCost`, which
 * `console.warn`s on an unknown id — forbidden inside a TUI that owns stdout.
 */
const FOOTER_RATES_BY_LOWER: ReadonlyMap<string, ModelRates> = new Map(
  Object.entries(MODEL_PRICING)
    .filter(([key]) => key !== "default")
    .map(([key, rates]) => [key.toLowerCase(), rates]),
);

const FOOTER_VENDOR_PREFIXES = [
  "openai/", "anthropic/", "google/", "deepseek/", "meta/", "mistral/",
  "z-ai/", "zai/", "kimi/", "moonshot/", "openrouter/", "xai/", "x-ai/",
];

function footerRates(model: string): ModelRates | undefined {
  const lower = model.toLowerCase();
  const direct = FOOTER_RATES_BY_LOWER.get(lower);
  if (direct) return direct;
  for (const prefix of FOOTER_VENDOR_PREFIXES) {
    if (lower.startsWith(prefix)) return FOOTER_RATES_BY_LOWER.get(lower.slice(prefix.length));
  }
  return undefined;
}

/**
 * A quiet per-turn cost string for the AI footer, or "$—" when the model's rate
 * is unknown (never a figure at a rate the model was not billed). Mirrors the
 * status-bar's arithmetic and formatting.
 */
function formatTurnCost(model: string, inputTokens: number, outputTokens: number): string {
  const rates = model ? footerRates(model) : undefined;
  if (!rates) return "$—";
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * rates.input +
    (Math.max(0, outputTokens) / 1_000_000) * rates.output;
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function renderEntry(
  entry: ChatEntry,
  maxWidthOuter: number,
  display: EntryDisplay,
  theme: Theme,
  interaction?: TranscriptRowInteraction,
) {
  const { ACCENT, PRIMARY, TEXT, MUTED, ERROR, SUCCESS, BORDER, PANEL_ALT, BRAND } = theme;
  // Interaction is only ever handed to the collapsible kinds (tool / subagent /
  // reasoning) of an EXPANDED turn. When present we reserve a two-cell
  // disclosure gutter and shrink the content budget so the wrapped row still
  // fits its column — the 80-col invariant holds exactly as the fold's does.
  const interactive = Boolean(interaction);
  const fullDetails = interaction?.expanded ?? display.transcriptDetail === "expanded";
  const maxWidth = interactive ? Math.max(8, maxWidthOuter - 2) : maxWidthOuter;
  const finish = (node: React.ReactNode): React.ReactNode => {
    if (!interaction) return node;
    return (
      <box
        key={entry.id}
        flexDirection="row"
        flexShrink={0}
        minWidth={0}
        backgroundColor={interaction.hovered ? PANEL_ALT : undefined}
        onMouseDown={interaction.onToggle}
        onMouseOver={interaction.onHover ? () => interaction.onHover?.(true) : undefined}
        onMouseOut={interaction.onHover ? () => interaction.onHover?.(false) : undefined}
      >
        <box width={2} flexShrink={0} minWidth={0} marginTop={display.spacing}>
          <text fg={MUTED}>{fullDetails ? "▾ " : "▸ "}</text>
        </box>
        <box flexDirection="column" flexGrow={1} minWidth={0}>
          {node}
        </box>
      </box>
    );
  };
  const detailWidth = Math.max(20, maxWidth - 8);
  const { transcriptStyle, roleLabelStyle, toolCardStyle } = display;
  // A row that stands for several collapsed repeats says so. The count is
  // appended at render time and never written into `entry.text`, so the next
  // repeat still compares equal and keeps collapsing.
  const repeat = repeatSuffix(entry.repeat);

  if (entry.kind === "user" || entry.kind === "assistant") {
    const isUser = entry.kind === "user";
    // Keep speaker labels distinct without tinting the message body.
    const tone = isUser ? ACCENT : PRIMARY;
    const labelTone = isUser ? ACCENT : BRAND;
    const messageWidth = transcriptStyle === "bubble" && isUser && maxWidth >= 32
      ? Math.floor(maxWidth * 0.85)
      : maxWidth;
    const frame = speechFrame(transcriptStyle, entry.kind, messageWidth);
    const marginTop = display.spacing + frame.extraMarginTop;
    const age = display.showTimestamps ? relativeAge(entry.at, display.now) : "";
    const label = roleLabelText(isUser ? "user" : "assistant", roleLabelStyle, age);
    const card = roundedCardFrame(maxWidth);
    const bordered = card.render && (frame.bordered || transcriptStyle === "rail");
    const bodyWidth = bordered ? card.innerWidth : Math.max(1, maxWidth);
    // Body: raw text for the operator, rendered markdown for the model.
    const body = isUser
      ? <text fg={TEXT} wrapMode="word">{sanitizeTuiText(entry.text)}</text>
      : renderMarkdownBlocks(renderMarkdown(entry.text, bodyWidth), entry.id, theme);
    const footerParts: string[] = [];
    if (!isUser) {
      if (display.modelInFooter && display.model) footerParts.push(display.model);
      if (display.showTokenUsage && entry.usageInput !== undefined) {
        footerParts.push(`${entry.usageInput}→${entry.usageOutput ?? 0} tok`);
      }
      if (display.showCost && entry.usageInput !== undefined) {
        footerParts.push(formatTurnCost(display.model, entry.usageInput, entry.usageOutput ?? 0));
      }
      if (entry.durationMs) footerParts.push(formatElapsed(entry.durationMs));
    }
    const restFitted = footerParts.length ? fitTuiText(footerParts.join(" · "), bodyWidth) : "";

    if (frame.bordered) {
      // Bubble cards: the speaker label rides on the top-left of the rounded
      // card border as a title, not as a separate heading row. The operator's
      // own messages right-align and take ~85% of the pane width (matching
      // iMessage / chat app convention); AI answers sit flush left and fill the
      // pane. The user's card gets a subtle panel fill so it reads as "yours".
      return (
        <box key={entry.id} width={maxWidth} flexDirection="row" justifyContent={isUser ? "flex-end" : "flex-start"} flexShrink={0} minWidth={0} marginTop={marginTop}>
          <box flexDirection="column" width={messageWidth} flexShrink={0} minWidth={0} border borderStyle="rounded" borderColor={tone} backgroundColor={isUser ? PANEL_ALT : undefined} paddingX={1}
            title={label ? ` ${label} ` : undefined}
            titleColor={labelTone}
            titleAlignment="left"
          >
            {body}
            {restFitted ? <text fg={MUTED}>{restFitted}</text> : null}
          </box>
        </box>
      );
    }

    // Rail remains the opt-in left-spine layout rather than a bubble card.
    if (transcriptStyle === "rail") {
      // BOTH voices are marked the same way — a thin left SPINE plus a bold label,
      // the body sitting flat on the canvas (no panel fill). An earlier version
      // filled each turn with PANEL_ALT so it read as a card, but with every turn
      // carded the transcript became a stack of heavy grey rectangles ("too much
      // card"); OpenCode's answer is a faint left bar + label, which demarcates a
      // turn without the weight. The SPINE TONE tells the two apart: the operator
      // turn takes the neutral ACCENT (it reads like the composer that produced
      // it), the AI turn takes the BRAND purple (the "0sec" voice) and carries a
      // small brand label so the answer announces itself.
      const spine = isUser ? ACCENT : BRAND;
      // The AI turn's footer is quiet provenance only — the per-turn telemetry
      // the operator opted into: the model when `modelDisplay` routes it here
      // (otherwise it lives in the bottom bar), tokens under `showTokenUsage`,
      // cost under `showCost`, and the elapsed. The AUTONOMY MODE is NOT repeated
      // here — it is session-wide state already shown in the masthead and status
      // bar, so tagging every answer with "YOLO"/"Co-pilot" was redundant noise.
      return (
        <box key={entry.id} flexDirection="column" width={maxWidth} flexShrink={0} minWidth={0} marginTop={marginTop}>
          {/* External label row: 0sec at upper-left, You at upper-right */}
          {label ? (
            isUser ? (
              // Operator: "You" right-aligned at top edge
              <box flexDirection="row" minWidth={0}>
                <box flexGrow={1} />
                <text height={1} wrapMode="none" truncate fg={labelTone} attributes={TextAttributes.BOLD}>{fitTuiText(label, maxWidth)}</text>
              </box>
            ) : (
              // Assistant: "0sec" left-aligned at top edge
              <box flexDirection="row" minWidth={0}>
                <text height={1} wrapMode="none" truncate fg={labelTone} attributes={TextAttributes.BOLD}>{fitTuiText(label, maxWidth)}</text>
                <box flexGrow={1} />
              </box>
            )
          ) : null}
          {bordered ? (
            <box width={card.outerWidth} flexDirection="column" flexShrink={0} minWidth={0} border borderStyle="rounded" borderColor={tone} backgroundColor={PANEL_ALT} paddingX={1}>
              {body}
            </box>
          ) : body}
          {restFitted ? (
            <box flexDirection="row" minWidth={0} marginTop={1}>
              <box width={2} flexShrink={0} minWidth={0}>
                <text fg={ERROR}>▪ </text>
              </box>
              <box flexGrow={1} minWidth={0} flexDirection="row">
                <text fg={MUTED}>{restFitted}</text>
              </box>
            </box>
          ) : null}
        </box>
      );
    }

    // compact inlines a one-line operator message next to its label.
    if (!frame.labelOwnRow && isUser) {
      return (
        <box key={entry.id} flexDirection="row" marginTop={marginTop} minWidth={0}>
          {label ? <box flexShrink={0}><text fg={labelTone}>{label}</text></box> : null}
          <box flexGrow={1} minWidth={0} marginLeft={label ? 1 : 0}>
            {body}
          </box>
        </box>
      );
    }

    // The default separation, OpenCode-style: consecutive turns are set apart
    // by whitespace (marginTop) and a compact coloured speaker label on its own
    // row — NOT a full-height rail down the left of every message. The body
    // then takes every cell of the pane, flush left.
    return (
      <box key={entry.id} flexDirection="column" marginTop={marginTop} minWidth={0}>
        {label ? <text fg={labelTone}>{label}</text> : null}
        {body}
      </box>
    );
  }

  if (entry.kind === "tool") {
    // State is DERIVED from what the record actually holds (see `toolState`):
    // a missing outcome is "running", a non-zero exit or a wallclock kill is a
    // failure regardless of an optimistic success flag, and nothing else is
    // allowed to read as a success. The three tool-card styles that are not
    // the rich card keep their previous rendering exactly.
    const state = toolState(entry);
    const failed = state === "failed";
    const running = state === "running";
    const { glyph, word } = toolStateLabel(state);
    const tone = failed ? ERROR : running ? PRIMARY : MUTED;
    if (toolCardStyle === "hidden" && !failed && !running) return null;
    if (toolCardStyle === "compact") return finish(
      <box key={entry.id} width={maxWidth} flexShrink={0} minWidth={0} marginTop={display.spacing}>
        <text width={maxWidth} height={1} wrapMode="none" truncate fg={tone}>{toolCompactLine(glyph, toolActionTitle(entry), word, maxWidth)}{repeat}</text>
      </box>,
    );
    // The rich card. It owns its own geometry, sections and degradation (down
    // to a single line when the width cannot pay for a frame, or when
    // `richToolCards` is off), so nothing about it is decided here.
    return finish(
      <ToolCard
        key={entry.id}
        entry={entry}
        width={maxWidth}
        display={display}
        theme={theme}
        expanded={fullDetails}
        toggleable={Boolean(interaction?.onToggle)}
        repeat={repeat}
      />,
    );
  }

  if (entry.kind === "subagent") {
    // A subagent still in flight (no recorded outcome) reads as RUNNING — a
    // shimmering label over the muted base — rather than being defaulted to a
    // red "failed" it never was. Terminal records keep their rendering.
    const running = entry.subagentOutcome === undefined;
    const ok = entry.subagentOutcome === "completed";
    const failed = entry.subagentOutcome === "failed";
    const tone = running ? PRIMARY : ok ? SUCCESS : ERROR;
    const glyph = running ? "◌" : ok ? "✓" : "×";
    const stateWord = running ? "running" : ok ? "completed" : "failed";
    const shimmerRunning = running && typeof display.shimmerFrame === "number";
    const frame = toolFrame(toolCardStyle, maxWidth, running ? undefined : ok);
    if (!frame.render) return null;
    const subDetailWidth = toolDetailWidth(frame.contentWidth, maxWidth);
    const statusParts: string[] = [];
    if (entry.subagentTurns !== undefined) statusParts.push(`turns ${entry.subagentTurns}`);
    if (entry.subagentFindings !== undefined) statusParts.push(`findings ${entry.subagentFindings}`);
    const statusLine = statusParts.length > 0 ? statusParts.join(" · ") : null;

    if (frame.singleLine) {
      const compactLine = toolCompactLine(glyph, "subagent", stateWord, frame.contentWidth);
      return finish(
        <box key={entry.id} flexDirection="column" marginTop={display.spacing} minWidth={0}>
          {shimmerRunning ? (
            <ShimmerText label={compactLine} frame={display.shimmerFrame!} base={MUTED} peak={TEXT}  />
          ) : (
            <text fg={tone} attributes={failed ? TextAttributes.BOLD : undefined}>{compactLine}</text>
          )}
          {frame.showDetail && entry.subagentError ? (
            <text fg={ERROR} wrapMode="word">{fitTuiText(entry.subagentError, frame.contentWidth)}</text>
          ) : null}
        </box>,
      );
    }

    return finish(
      <box key={entry.id} flexDirection="row" marginTop={display.spacing} marginLeft={frame.outerMarginLeft} minWidth={0}>
        {frame.railKind === "solid" ? <box width={1} alignSelf="stretch" backgroundColor={tone} /> : null}
        <box flexDirection="column" flexGrow={1} minWidth={0} marginLeft={frame.contentGap}>
          <box flexDirection="row" minWidth={0}>
            <text fg={tone} attributes={failed ? TextAttributes.BOLD : undefined}>{glyph}</text>
            <text fg={MUTED}> </text>
            {shimmerRunning ? (
              <ShimmerText label="evidence / subagent" frame={display.shimmerFrame!} base={MUTED} peak={TEXT}  />
            ) : (
              <text fg={BRAND}>evidence / subagent</text>
            )}
            <text fg={MUTED}> · {stateWord}</text>
          </box>
          {frame.showDetail && statusLine ? <text fg={MUTED}>{fitTuiText(statusLine, subDetailWidth)}</text> : null}
          {frame.showDetail && entry.subagentSummary ? <text fg={TEXT} wrapMode="word">{fitTuiText(entry.subagentSummary, subDetailWidth)}</text> : null}
          {entry.subagentError ? <text fg={ERROR} wrapMode="word">{fitTuiText(entry.subagentError, subDetailWidth)}</text> : null}
        </box>
      </box>,
    );
  }

  if (entry.kind === "error") {
    // Failures get the same rail treatment as speech, in the error tone: an
    // operator must be able to see at a glance that the turn did not produce an
    // answer, and why. Messenger frames it as a bordered ERROR block instead.
    const frame = speechFrame(transcriptStyle, "error", maxWidth);
    const marginTop = display.spacing + frame.extraMarginTop;
    if (frame.bordered) {
      return (
        <box key={entry.id} flexDirection="column" width={maxWidth} flexShrink={0} minWidth={0} marginTop={marginTop} border borderColor={ERROR} paddingX={1}>
          <text fg={ERROR}>{fitTuiText(`${entry.text}${repeat}`, frame.contentWidth)}</text>
          {entry.detail ? <text fg={MUTED} wrapMode="word">{sanitizeTuiText(entry.detail)}</text> : null}
        </box>
      );
    }
    // A failed turn reads as speech in the error tone: a compact red marker and
    // label, the body beneath it, and the same whitespace separation as any
    // other turn — no full-height bar.
    return (
      <box key={entry.id} flexDirection="column" marginTop={marginTop} minWidth={0}>
        <text fg={ERROR}>{fitTuiText(`▌ ${entry.text}${repeat}`, Math.max(1, maxWidth))}</text>
        {entry.detail ? (
          <text fg={MUTED} wrapMode="word">{sanitizeTuiText(entry.detail)}</text>
        ) : null}
      </box>
    );
  }

  if (entry.kind === "reasoning") {
    // Thinking is deliberately quieter than the answer: a dotted rail and
    // muted text, so it reads as working-out rather than a conclusion. While the
    // reasoning belongs to the turn STILL IN FLIGHT the "thinking" label shimmers
    // (a bright sweep over the muted base) so a working turn always reads as
    // alive — even when its answer hasn't started streaming yet; the instant the
    // turn settles (or on a past turn's reasoning) it renders static/muted.
    // Gated on BOTH `activeTurn` matching and a numeric `shimmerFrame`, so
    // reduceMotion / settled turns keep the flat label.
    // Only the LIVE TAIL reasoning shimmers — not every past thinking block in
    // the working turn — so a turn shows one shimmering "thinking", not many.
    const shimmerThinking =
      entry.id === display.activeEntryId && typeof display.shimmerFrame === "number";
    return finish(
      <box key={entry.id} flexDirection="row" marginTop={display.spacing} minWidth={0}>
        <box width={1} flexShrink={0} alignSelf="stretch">
          <text fg={MUTED}>┊</text>
        </box>
        <box flexDirection="column" flexGrow={1} minWidth={0} marginLeft={1}>
          {shimmerThinking ? (
            <ShimmerText label="thinking" frame={display.shimmerFrame!} base={MUTED} peak={TEXT}  />
          ) : (
            <text fg={MUTED}>thinking</text>
          )}
          {renderMarkdownBlocks(
            renderMarkdown(normalizeReasoning(entry.text), Math.max(8, maxWidth - 2)),
            entry.id,
            theme,
            MUTED,
          )}
        </box>
      </box>,
    );
  }

  if (entry.kind === "panel" && entry.panel) {
    // Command output is not dialogue, so it gets a bordered block with
    // aligned columns instead of one muted bullet per line. Column widths
    // come from panelColumns so the two columns can never overspend the
    // panel and paint into each other.
    const panel = entry.panel;
    // Two border cells plus one padding cell on each side.
    const innerWidth = Math.max(1, maxWidth - 4);
    const columns = panelColumns(panel.rows, innerWidth);
    return (
      <box key={entry.id} flexDirection="column" width="100%" minWidth={0} flexShrink={0} marginTop={display.spacing} border borderColor={BORDER} paddingX={1}>
        <box flexDirection="row" width="100%" minWidth={0}>
          <text fg={PRIMARY}>{fitTuiText(panel.title, innerWidth)}</text>
        </box>
        {panel.subtitle ? (
          <text fg={MUTED}>{fitTuiText(panel.subtitle, innerWidth)}</text>
        ) : null}
        {panel.rows.map((row, index) => {
          if (row.heading) {
            return (
              <text key={`h-${index}`} fg={ACCENT}>{fitTuiText(row.value, innerWidth)}</text>
            );
          }
          if (!row.label || columns.labelWidth === 0) {
            return (
              <text key={`r-${index}`} fg={TEXT} wrapMode="word">{fitTuiText(row.value, innerWidth)}</text>
            );
          }
          return (
            <box key={`r-${index}`} flexDirection="row" width="100%" minWidth={0} gap={columns.gap}>
              <box width={columns.labelWidth} flexShrink={0} minWidth={0}>
                <text fg={TEXT}>{fitTuiText(row.label, columns.labelWidth)}</text>
              </box>
              <box width={columns.valueWidth} flexShrink={0} minWidth={0}>
                <text fg={MUTED}>{fitTuiText(row.value, columns.valueWidth)}</text>
              </box>
            </box>
          );
        })}
      </box>
    );
  }

  if (entry.kind === "peer") {
    // An inter-agent (IRC) message, drawn as an OMP-style directional card:
    // `» from → to` with each name in its stable agent accent, meta chips (kind ·
    // reply · age), and a bounded/collapsible body. Degrades to a single line
    // when the column is too narrow for a card.
    return (
      <MessageCard
        key={entry.id}
        data={messageCardFromPeerEntry(entry, { now: display.now })}
        width={maxWidth}
        theme={theme}
        spacing={display.spacing}
        expanded={fullDetails}
        toggleable={interactive}
      />
    );
  }

  // An entry that carries inline images (and is not a tool call, which draws
  // its own) renders them as standalone image cards under its line. Numbered
  // by the attachment's own index, with the real pixel size on the bottom
  // border when — and only when — the payload told us what it is.
  const attachments = entry.images ?? [];

  return (
    <box key={entry.id} flexDirection="column" minWidth={0}>
      <box flexDirection="row" marginTop={display.spacing} minWidth={0}>
        <text fg={MUTED}>·</text>
        <box flexDirection="column" flexGrow={1} minWidth={0} marginLeft={1}>
          <text fg={MUTED} wrapMode="word">{fitTuiText(`${entry.text}${repeat}`, maxWidth - 2)}</text>
          {entry.detail ? <text fg={MUTED} wrapMode="word">{fitTuiText(entry.detail, maxWidth - 2)}</text> : null}
        </box>
      </box>
      {attachments.map((image, index) => (
        <ImageCard
          key={`${entry.id}-image-${image.index ?? index}`}
          image={image}
          width={maxWidth}
          theme={theme}
          marginTop={1}
        />
      ))}
    </box>
  );
}

/**
 * A folded run of collapsed detail: one quiet line, a ▸ disclosure glyph then
 * the summary. The planner never folds a failure into a run, so the muted tone
 * is always correct — every entry behind this line succeeded (or is reasoning).
 * Expanding the transcript (Ctrl+R) restores the full cards.
 */
export function renderFold(
  item: Extract<TranscriptPlanItem<ChatEntry>, { type: "fold" }>,
  maxWidth: number,
  display: EntryDisplay,
  theme: Theme,
  interaction?: TranscriptRowInteraction,
) {
  const { MUTED, TEXT, PANEL_ALT, ERROR } = theme;
  const key = `fold-${item.entries[0]?.id ?? item.turn}`;
  // `toolCardStyle: "hidden"` means "don't show me successful tool activity";
  // honour it inside a fold too by dropping the tool/subagent steps from the
  // summary (reasoning still folds). A fold left with nothing renders nothing.
  const shown =
    display.toolCardStyle === "hidden"
      ? item.entries.filter((entry) => entry.kind !== "tool" && entry.kind !== "subagent")
      : item.entries;
  if (shown.length === 0) return null;
  const summary = shown.length === item.entries.length ? item.summary : foldSummary(shown);
  // A fold standing for the turn STILL IN FLIGHT must read as active even though
  // its steps are collapsed to one line: shimmer the summary (bright sweep over
  // the muted base) so a working-but-collapsed turn — e.g. "▸ 12 steps ·
  // thinking, run_command" — still signals "running". A completed/past fold
  // (its turn is not `activeTurn`) stays static muted, exactly as before. Gated
  // on BOTH the turn match and a numeric `shimmerFrame`, so reduceMotion /
  // settled turns keep the flat summary.
  const summaryFitted = fitTuiText(`${summary} · ${interaction?.onToggle ? "click or " : ""}ctrl+r to expand`, Math.max(1, maxWidth - 2));
  const shimmerFold =
    item.turn === display.activeTurn && typeof display.shimmerFrame === "number";
  // A collapsed fold is clickable: mousing down toggles its turn into the
  // expanded set (chat-screen owns that state), and hovering tints the row so
  // the disclosure reads as interactive. Handlers are wired only when
  // chat-screen supplies `interaction`; keyboard-only use (Ctrl+R) is
  // unaffected. The ▸ glyph is the "collapsed" affordance; an expanded turn
  // instead renders its steps with the ▾ affordance (see renderEntry).
  return (
    <box
      key={key}
      flexDirection="row"
      marginTop={display.spacing}
      minWidth={0}
      backgroundColor={interaction?.hovered ? PANEL_ALT : undefined}
      onMouseDown={interaction?.onToggle}
      onMouseOver={interaction?.onHover ? () => interaction.onHover?.(true) : undefined}
      onMouseOut={interaction?.onHover ? () => interaction.onHover?.(false) : undefined}
    >
      <box width={2} flexShrink={0} minWidth={0}>
        <text fg={MUTED}>▸ </text>
      </box>
      <box flexGrow={1} minWidth={0}>
        {shimmerFold ? (
          <ShimmerText label={summaryFitted} frame={display.shimmerFrame!} base={MUTED} peak={TEXT}  />
        ) : (
          <text fg={MUTED}>{summaryFitted}</text>
        )}
      </box>
    </box>
  );
}
