/** @jsxImportSource @opentui/react */
import React from "react";
import { TextAttributes } from "@opentui/core";

import { fitTuiText, sanitizeTuiText } from "../text.js";
import { commandCardFrame, toolCompactLine } from "../transcript-style.js";
import { projectToolPreview, type ToolPreview } from "../tool-format.js";
import { codeTokenStyle, highlightCode, parseDiffLine } from "../syntax-style.js";
import { resolveSyntaxColors } from "../themes.js";
import { agentAccentFor } from "../agent-color.js";
import type { Theme } from "../theme-context.js";
import { KEYBINDINGS } from "../keybindings.js";
import { ShimmerText } from "./shimmer.js";
import { renderMarkdownBlocks } from "./markdown-blocks.js";
import { ImageCard } from "./ImageCard.js";
import { TodoTree } from "./Todos.js";
import { buildTodoTreeRows } from "./todos-sidebar-layout.js";
import {
  EXPANDED_SUBREPORT_LIMIT,
  capTaskBodyLines,
  subReportRows,
  taskBodyLines,
  taskMarkdownSections,
  type TaskBodyLine,
} from "./task-card-layout.js";
import type { ChatEntry, ChatImageAttachment, EntryDisplay } from "./types.js";
import {
  MAX_OUTPUT_ROWS,
  badgeChip,
  formatDurationMs,
  pathExtension,
  statusColumns,
  toolActionTitle,
  toolBadgeLabel,
  toolInputSection,
  toolKindIdentity,
  toolResultLine,
  toolState,
  toolStateLabel,
  toolStatusRows,
  type ToolState,
} from "./card-layout.js";

/**
 * A tool call, drawn as a titled rounded card.
 *
 *   ╭ $ npm test -- --silent · SH · (1.24s) ─────╮
 *   │ COMMAND ─────────────────────────────────│
 *   │ npm test -- --silent      (highlighted)  │
 *   │ OUTPUT ──────────────────────────────────│
 *   │ …                                        │
 *   │ STATUS ──────────────────────────────────│
 *   │ State    complete                        │
 *   │ Exit     0                               │
 *   ╰──────────────────────────────────────────╯
 *
 * What the card is allowed to say:
 *
 *   - The top-border TITLE is the operation that actually ran — the command
 *     string, edited path, search provider, or tool name with its recorded
 *     argument summary, led by a kind glyph and closed by the execution time.
 *     Its language/kind chip comes from retained metadata. There is no generic
 *     stand-in title and no second heading in the body.
 *   - STATUS is derived, never assumed: a call with no recorded outcome reads
 *     "running", a non-zero exit or a wallclock kill reads "failed" in the
 *     error tone, and only `success === true` reads "complete". Finishing is
 *     not succeeding.
 *   - DURATION rides the TOP border (` · (<dur>)` after the title), OMP-style,
 *     and is printed only from a measured `wallMs` — an entry that carries no
 *     measurement gets no duration anywhere, never an estimate.
 *
 * Behaviour carried over unchanged from the previous inline implementation:
 * the collapsed/expanded line budget (10 vs 128 retained lines), the
 * `<scrollbox>` that lets an expanded body scroll inside a fixed height, the
 * expansion hint drawn from the actual keybinding registry, the
 * "Preview capped" notice, and the fact that every body line is a real
 * selectable `<text>` node so the transcript's copy-on-highlight
 * (`useSelectionCopy` in chat-screen) keeps working over the card.
 */

/** Retained-line budget: collapsed shows a taste, expanded shows the lot. */
const COLLAPSED_OUTPUT_LINES = 10;
const EXPANDED_OUTPUT_LINES = 128;

/** Lines of input we will print. An input longer than this is elided. */
const MAX_INPUT_ROWS = 8;

/** Images from one result that we will draw as cards beneath it. */
const MAX_CARD_IMAGES = 4;

const TOOL_EXPAND_KEY = KEYBINDINGS.find((binding) => binding.id === "view.transcript-detail")?.keys;

export interface ToolCardProps {
  entry: ChatEntry;
  /** Cell budget for the whole card. It never draws wider than this. */
  width: number;
  display: EntryDisplay;
  theme: Theme;
  /** True when the row is fully expanded (all retained output, scrollable). */
  expanded: boolean;
  /** True when a click can toggle this row, so the hint can say so. */
  toggleable?: boolean;
  /** Pre-formatted "(xN)" suffix for a collapsed run of identical entries. */
  repeat?: string;
}

/** Theme colour for a state. Failure is red; running is not green. */
function stateTone(state: ToolState, theme: Theme): string {
  if (state === "failed") return theme.ERROR;
  if (state === "running") return theme.PRIMARY;
  return theme.SUCCESS;
}

/** Border colour. Only a real failure repaints the whole outline. */
function stateBorder(state: ToolState, theme: Theme): string {
  if (state === "failed") return theme.ERROR;
  return theme.BORDER;
}

/**
 * Tone for a per-agent status word on a Task-card sub-report row. Mirrors OMP's
 * `iconColor`: red ONLY for a genuine failure, green on success, accent while
 * live, muted for everything else (queued / unknown / no status). Red is never
 * spent on a label that is not an actual failure — the same invariant as the
 * AGENTS rail.
 */
function agentStatusTone(status: string, theme: Theme): string {
  const s = status.toLowerCase();
  if (s === "failed" || s === "error" || s === "aborted") return theme.ERROR;
  if (s === "completed" || s === "done") return theme.SUCCESS;
  if (s === "running" || s === "working") return theme.ACCENT;
  return theme.MUTED;
}

/**
 * A section rule: the label, then a hairline to the right edge. Exactly
 * `width` cells, so it can never push the card's border outwards.
 */
function SectionRule({ label, width, theme }: { label: string; width: number; theme: Theme }) {
  const room = Math.max(0, Math.floor(width));
  if (room <= 0) return null;
  const shown = fitTuiText(label.toUpperCase(), room);
  const rule = room - shown.length - 1;
  return (
    <box flexDirection="row" width={room} height={1} flexShrink={0} minWidth={0}>
      <text flexShrink={0} fg={theme.MUTED} attributes={TextAttributes.BOLD}>{shown}</text>
      {rule > 0 ? <text flexShrink={0} fg={theme.BORDER}>{` ${"─".repeat(rule)}`}</text> : null}
    </box>
  );
}

/** One syntax-highlighted source line, pre-fitted so it cannot overrun. */
function CodeLine({
  line,
  language,
  width,
  theme,
  keyPrefix,
}: {
  line: string;
  language?: string;
  width: number;
  theme: Theme;
  keyPrefix: string;
}) {
  const fitted = fitTuiText(line, Math.max(1, width));
  const tokens = highlightCode(fitted, language);
  if (tokens.length === 0) {
    return <text width={width} height={1} wrapMode="none" truncate fg={theme.TEXT}> </text>;
  }
  return (
    <box flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0}>
      {tokens.map((token, index) => {
        const style = codeTokenStyle(token.kind, theme);
        let attributes = 0;
        if (style.bold) attributes |= TextAttributes.BOLD;
        if (style.italic) attributes |= TextAttributes.ITALIC;
        if (style.dim) attributes |= TextAttributes.DIM;
        return (
          <text
            key={`${keyPrefix}-${index}`}
            flexShrink={0}
            fg={style.fg}
            attributes={attributes === 0 ? undefined : attributes}
          >
            {token.text}
          </text>
        );
      })}
    </box>
  );
}

/**
 * One diff line, OMP-style: the changed lines keep a flat add/removed colour so
 * the edit reads unambiguously, and the unchanged CONTEXT lines are
 * syntax-highlighted in the edited file's own language so the surrounding code
 * is polychrome. Hunk headers and file markers are drawn dim. `language` is the
 * file's extension (e.g. "ts", "py") — `highlightCode` normalises it — and is
 * `undefined` when the diff carries no path, in which case context lines render
 * as plain text (still correct, just uncoloured).
 */
function DiffLine({
  line,
  language,
  width,
  theme,
  keyPrefix,
}: {
  line: string;
  language?: string;
  width: number;
  theme: Theme;
  keyPrefix: string;
}) {
  const w = Math.max(1, width);
  const fitted = fitTuiText(line, w);
  const parsed = parseDiffLine(fitted);
  const syntax = resolveSyntaxColors(theme);

  // Added / removed lines: one flat colour (green / red), gutter sign included.
  if (parsed.sign === "+") {
    return <text width={w} height={1} wrapMode="none" truncate fg={syntax.diffAdd}>{fitted}</text>;
  }
  if (parsed.sign === "-") {
    return <text width={w} height={1} wrapMode="none" truncate fg={syntax.diffDel}>{fitted}</text>;
  }
  // Hunk headers (@@) and file markers (--- / +++ / diff --git): dim chrome.
  if (parsed.sign === "@" || parsed.sign === "meta") {
    return (
      <text width={w} height={1} wrapMode="none" truncate fg={theme.MUTED} attributes={TextAttributes.DIM}>
        {fitted}
      </text>
    );
  }

  // Context line: draw the leading space gutter (when present) then the payload
  // tokenised in the file's language.
  const signChar = parsed.sign === " " ? " " : "";
  const tokens = highlightCode(parsed.content, language);
  if (tokens.length === 0) {
    return <text width={w} height={1} wrapMode="none" truncate fg={theme.TEXT}>{fitted}</text>;
  }
  return (
    <box flexDirection="row" width={w} height={1} flexShrink={0} minWidth={0}>
      {signChar ? <text flexShrink={0} fg={theme.MUTED}>{signChar}</text> : null}
      {tokens.map((token, index) => {
        const style = codeTokenStyle(token.kind, theme);
        let attributes = 0;
        if (style.bold) attributes |= TextAttributes.BOLD;
        if (style.italic) attributes |= TextAttributes.ITALIC;
        if (style.dim) attributes |= TextAttributes.DIM;
        return (
          <text
            key={`${keyPrefix}-${index}`}
            flexShrink={0}
            fg={style.fg}
            attributes={attributes === 0 ? undefined : attributes}
          >
            {token.text}
          </text>
        );
      })}
    </box>
  );
}

/**
 * Use rich retained metadata when available, otherwise the stored bounded
 * projection. Restored entries without either fall back to their detail text
 * through the same bounded, redacted projector.
 */
function previewFor(entry: ChatEntry, failed: boolean): ToolPreview {
  if (entry.metaKind === "command" && entry.commandOutput !== undefined) {
    return projectToolPreview({ name: "run_command" }, { success: !failed, output: entry.commandOutput });
  }
  if (entry.metaKind === "edit" && entry.editDiff !== undefined) {
    return projectToolPreview({ name: "apply_patch" }, { success: !failed, output: entry.editDiff });
  }
  if (entry.metaKind === "web" && (entry.webQuery || entry.webAnswer || entry.webSources)) {
    return projectToolPreview({ name: entry.text }, {
      success: !failed,
      output: {
        ...(entry.webQuery ? { query: entry.webQuery } : {}),
        ...(entry.webAnswer ? { answer: entry.webAnswer } : {}),
        ...(entry.webSources ? { sources: entry.webSources } : {}),
      },
    });
  }
  return entry.toolPreview ?? projectToolPreview({ name: entry.text }, { success: !failed, output: entry.detail });
}

/**
 * A subagent-launch "Task" card, mirroring OMP's `task/render.ts`: the
 * model-authored Goal / Constraints / Contract Markdown sections, then the
 * dispatched sub-report bullets (`• Name (agent): brief`), then the
 * phase/checkbox TODO tree — all inside the same bordered box + `SectionRule`
 * idiom as the command/edit/web cards, and honouring the same `expanded`
 * collapse affordance.
 */
function TaskCard({
  entry,
  width,
  display,
  theme,
  expanded,
  toggleable,
  repeat,
}: ToolCardProps): React.ReactNode {
  const { TEXT, MUTED, ERROR, BRAND, PANEL, PANEL_ALT, CANVAS } = theme;
  const state = toolState(entry);
  const failed = state === "failed";
  const running = state === "running";
  const { glyph } = toolStateLabel(state);
  const tone = stateTone(state, theme);

  const frame = commandCardFrame(width);
  const useCard = frame.render && display.richToolCards !== false;
  const title = `Task${entry.taskLabel ? ` • ${entry.taskLabel}` : ""}`;

  if (!useCard) {
    const line = toolCompactLine(glyph, title, toolStateLabel(state).word, Math.max(1, width), formatDurationMs(entry.wallMs));
    return (
      <box flexDirection="column" width={Math.max(1, width)} flexShrink={0} minWidth={0} marginTop={display.spacing}>
        <text width={Math.max(1, width)} height={1} wrapMode="none" truncate fg={tone}>{line}{repeat}</text>
      </box>
    );
  }

  const inner = frame.innerWidth;
  // One cell is surrendered to the scrollbar when a body region can scroll.
  const bodyWidth = Math.max(1, inner - (expanded ? 1 : 0));

  const sections = taskMarkdownSections(entry);
  const { rows: subRows, hidden: hiddenAgents } = subReportRows(
    entry.subReports,
    expanded,
    EXPANDED_SUBREPORT_LIMIT,
  );
  const todos = entry.taskTodos ?? [];
  const expandHint = toggleable
    ? ` · click${TOOL_EXPAND_KEY ? ` or ${TOOL_EXPAND_KEY}` : ""} to expand`
    : "";
  const scrollbarOptions = {
    trackOptions: { backgroundColor: PANEL, foregroundColor: MUTED },
    arrowOptions: { foregroundColor: MUTED, backgroundColor: PANEL },
  };

  // ── context (Goal / Constraints / Contract / Assignment) ────────────────────
  // Flattened to one countable line list and bounded exactly like the normal
  // card's Output: a collapsed taste, the fuller lot inside a fixed-height,
  // CLIPPING <scrollbox> when expanded. This is what stops a 40-line Goal from
  // painting an 88-row card straight over the transcript below it.
  const allBodyLines = taskBodyLines(sections);
  const retainedBody = allBodyLines.slice(0, EXPANDED_OUTPUT_LINES);
  const { visible: visibleBody, hidden: hiddenBody } = capTaskBodyLines(
    retainedBody,
    expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES,
  );
  const bodyCapped = allBodyLines.length > retainedBody.length;
  const bodyScrollRows = Math.max(1, Math.min(MAX_OUTPUT_ROWS, visibleBody.length));
  const renderBodyLine = (line: TaskBodyLine, index: number): React.ReactNode =>
    line.kind === "rule" ? (
      <SectionRule key={`${entry.id}-body-${index}`} label={line.label} width={bodyWidth} theme={theme} />
    ) : (
      <text
        key={`${entry.id}-body-${index}`}
        width={bodyWidth}
        height={1}
        wrapMode="none"
        truncate
        fg={TEXT}
      >
        {fitTuiText(sanitizeTuiText(line.text.slice(0, 512)), bodyWidth)}
      </text>
    );

  // ── plan (reused TodoTree), capped to a deterministic row ceiling ───────────
  const planCap = expanded ? MAX_OUTPUT_ROWS : COLLAPSED_OUTPUT_LINES;
  const allTodoRows = buildTodoTreeRows(todos, inner);
  const todoRows = allTodoRows.slice(0, planCap);
  const hiddenTodo = allTodoRows.length - todoRows.length;

  // ── output (the actual worker findings / summary / errors) ──────────────────
  // spawn_agents returns the real result on the entry; surface it through the
  // shared previewFor + the same bounded-lines / scrollbox block the normal
  // card uses for its Output, so it is never dropped — a taste collapsed,
  // scrollable inside a fixed height when expanded.
  const preview = previewFor(entry, failed);
  const outRetained = preview.lines
    .slice(0, EXPANDED_OUTPUT_LINES)
    .map((line) => sanitizeTuiText(line.slice(0, 512)));
  const outVisible = outRetained.slice(0, expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES);
  const outHidden = outRetained.length - outVisible.length;
  const outCapped = preview.truncated || preview.lines.length > outRetained.length;
  const outBody = preview.kind === "code" && bodyWidth >= 3
    ? renderMarkdownBlocks(
        [{
          kind: "code",
          language: preview.language,
          lines: outVisible.map((line) => fitTuiText(line, Math.max(1, bodyWidth - 2))),
        }],
        `${entry.id}-task-output`,
        theme,
      )
    : outVisible.map((line, index) => (
        <text
          key={`${entry.id}-task-output-${index}`}
          width={bodyWidth}
          height={1}
          wrapMode="none"
          truncate
          fg={failed ? ERROR : TEXT}
        >
          {fitTuiText(line, bodyWidth)}
        </text>
      ));
  const outRows = Math.min(
    MAX_OUTPUT_ROWS,
    Math.max(1, outVisible.length + (preview.kind === "code" && preview.language ? 1 : 0)),
  );

  const headerGlyph = failed ? `${glyph} ` : "";
  // Execution time at the top, matching the tool card (OMP-style ` · (<dur>)`).
  // A subagent row's `wallMs` is stamped at settle time (see the chat-screen
  // WIRING TODO); absent it, no duration prints.
  const durText = formatDurationMs(entry.wallMs);
  const durSuffix = durText ? ` · (${durText})` : "";
  const headline = fitTuiText(`${headerGlyph}${title}${repeat ?? ""}${durSuffix}`, inner);
  const shimmer = running && typeof display.shimmerFrame === "number";

  return (
    <box
      flexDirection="column"
      width={frame.outerWidth}
      flexShrink={0}
      minWidth={0}
      marginTop={display.spacing}
      border
      borderStyle="rounded"
      borderColor={stateBorder(state, theme)}
      title={headline || undefined}
      titleColor={failed ? ERROR : BRAND}
      titleAlignment="left"
      backgroundColor={PANEL}
      paddingX={1}
    >
      {visibleBody.length > 0 ? (
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          {expanded ? (
            <scrollbox
              width={inner}
              height={bodyScrollRows}
              flexShrink={0}
              scrollX={false}
              verticalScrollbarOptions={scrollbarOptions}
            >
              <box width={bodyWidth} flexDirection="column" flexShrink={0} minWidth={0}>
                {visibleBody.map(renderBodyLine)}
              </box>
            </scrollbox>
          ) : (
            <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
              {visibleBody.map(renderBodyLine)}
            </box>
          )}
          {hiddenBody > 0 ? (
            <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
              {fitTuiText(`… ${hiddenBody} more line${hiddenBody === 1 ? "" : "s"}${expandHint}`, inner)}
            </text>
          ) : null}
          {bodyCapped ? (
            <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
              {fitTuiText("Context capped; additional lines are not retained here", inner)}
            </text>
          ) : null}
        </box>
      ) : null}

      {subRows.length > 0 ? (
        // The dispatched agents, as OMP-style per-agent status lines inside a
        // PANEL_ALT inset ("background difference" from the card's context /
        // output): each row carries a stable per-agent accent LEFT RAIL, a bold
        // accent name, the `(type)` badge, a `[status]` word tinted by outcome,
        // and a truthful ` · stat` tail (tokens / context / duration / model —
        // ONLY what the CLI actually has; cost / requests / tool-count are
        // deferred). A genuinely running agent draws a second `└ tool: note`
        // intent line. Height stays bounded: ≤ cap rows, each ≤ 2 lines.
        <box
          flexDirection="column"
          width={inner}
          flexShrink={0}
          minWidth={0}
          marginTop={1}
          backgroundColor={PANEL_ALT}
        >
          <SectionRule label="Agents" width={inner} theme={theme} />
          {subRows.map((row, index) => {
            const accent = agentAccentFor(row.accentId, CANVAS);
            const statusTone = agentStatusTone(row.status, theme);
            const statusText = row.status ? ` [${row.status}]` : "";
            const showIntent = row.running && row.intent.length > 0;
            const rowHeight = 1 + (showIntent ? 1 : 0);
            // Content column sits right of the 1-cell accent rail. Widths sum to
            // `cw` so the row can never overflow the card's inner width.
            const cw = Math.max(1, inner - 1);
            // Stats are the first thing to go when the row is narrow, so the
            // name + status word always survive rather than the row overflowing.
            const baseFixed = 2 + row.badge.length + row.isolated.length + statusText.length;
            const statsText =
              row.stats.length > 0 && baseFixed + row.stats.join(" · ").length + 9 <= cw
                ? ` · ${row.stats.join(" · ")}`
                : "";
            const trailing = statusText.length + statsText.length;
            const nonName = 2 + row.badge.length + row.isolated.length + trailing;
            let nameCells = Math.min(row.name.length, Math.max(4, Math.floor(cw * 0.4)));
            if (nonName + nameCells > cw) nameCells = Math.max(1, cw - nonName);
            const briefCells = Math.max(0, cw - nonName - nameCells);
            return (
              <box
                key={`${entry.id}-agent-${index}`}
                flexDirection="row"
                width={inner}
                height={rowHeight}
                flexShrink={0}
                minWidth={0}
                backgroundColor={PANEL_ALT}
              >
                <box width={1} height={rowHeight} flexShrink={0} backgroundColor={accent} />
                <box flexDirection="column" width={cw} height={rowHeight} flexShrink={0} minWidth={0} backgroundColor={PANEL_ALT}>
                  <box flexDirection="row" width={cw} height={1} flexShrink={0} minWidth={0} backgroundColor={PANEL_ALT}>
                    <text width={2} height={1} flexShrink={0} wrapMode="none" truncate fg={statusTone} bg={PANEL_ALT}>{"• "}</text>
                    <text width={nameCells} height={1} flexShrink={0} wrapMode="none" truncate fg={accent} attributes={TextAttributes.BOLD} bg={PANEL_ALT}>{fitTuiText(row.name, nameCells)}</text>
                    {row.badge ? <text width={row.badge.length} height={1} flexShrink={0} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>{row.badge}</text> : null}
                    {briefCells > 0 && row.brief ? <text width={briefCells} height={1} flexShrink={0} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>{fitTuiText(row.brief, briefCells)}</text> : null}
                    {row.isolated ? <text width={row.isolated.length} height={1} flexShrink={0} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>{row.isolated}</text> : null}
                    {statusText ? <text width={statusText.length} height={1} flexShrink={0} wrapMode="none" truncate fg={statusTone} bg={PANEL_ALT}>{statusText}</text> : null}
                    {statsText ? <text width={statsText.length} height={1} flexShrink={0} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>{statsText}</text> : null}
                  </box>
                  {showIntent ? (
                    <box flexDirection="row" width={cw} height={1} flexShrink={0} minWidth={0} backgroundColor={PANEL_ALT}>
                      <text width={cw} height={1} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>{fitTuiText(`└ ${row.intent}`, cw)}</text>
                    </box>
                  ) : null}
                </box>
              </box>
            );
          })}
          {hiddenAgents > 0 ? (
            <text width={inner} height={1} wrapMode="none" truncate fg={MUTED} bg={PANEL_ALT}>
              {fitTuiText(`… ${hiddenAgents} more agent${hiddenAgents === 1 ? "" : "s"}${expandHint}`, inner)}
            </text>
          ) : null}
        </box>
      ) : null}

      {todoRows.length > 0 ? (
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          <SectionRule label="Plan" width={inner} theme={theme} />
          <TodoTree rows={todoRows} width={inner} theme={theme} />
          {hiddenTodo > 0 ? (
            <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
              {fitTuiText(`… ${hiddenTodo} more plan line${hiddenTodo === 1 ? "" : "s"}${expandHint}`, inner)}
            </text>
          ) : null}
        </box>
      ) : null}

      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label="Output" width={inner} theme={theme} />
        {outVisible.length > 0 ? (
          expanded ? (
            <scrollbox
              width={inner}
              height={Math.max(1, outRows)}
              flexShrink={0}
              scrollX={false}
              verticalScrollbarOptions={scrollbarOptions}
            >
              <box width={bodyWidth} flexDirection="column" flexShrink={0} minWidth={0}>{outBody}</box>
            </scrollbox>
          ) : (
            <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>{outBody}</box>
          )
        ) : (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(running ? "Awaiting output" : "No output retained", inner)}
          </text>
        )}
        {outHidden > 0 ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(`${outHidden} more preview line${outHidden === 1 ? "" : "s"}${expandHint}`, inner)}
          </text>
        ) : null}
        {outCapped ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText("Preview capped; additional output is not retained here", inner)}
          </text>
        ) : null}
      </box>

      {running ? (
        shimmer ? <ShimmerText label={`${glyph} running`} frame={display.shimmerFrame!} base={MUTED} peak={TEXT} />
          : <text fg={MUTED}>{`${glyph} running`}</text>
      ) : null}
    </box>
  );
}

/**
 * A `js_eval` / `python_eval` "Code" card, mirroring oh-my-pi's eval card: the
 * syntax-highlighted source that ran, then its captured Output — both inside the
 * same bordered box + `SectionRule` idiom as the command card, with the
 * execution time riding the TOP border (OMP-style `· (<dur>)`) and the same
 * collapsed/expanded line budget + `<scrollbox>` as the normal Output block.
 */
function CodeCard({
  entry,
  width,
  display,
  theme,
  expanded,
  toggleable,
  repeat,
}: ToolCardProps): React.ReactNode {
  const { TEXT, MUTED, ERROR, BRAND, PANEL } = theme;
  const state = toolState(entry);
  const failed = state === "failed";
  const running = state === "running";
  const { glyph } = toolStateLabel(state);
  const tone = stateTone(state, theme);

  const language = entry.codeLanguage ?? "javascript";
  const langLabel = language === "python" ? "Python" : "JS";
  const title = langLabel;

  const frame = commandCardFrame(width);
  const useCard = frame.render && display.richToolCards !== false;
  if (!useCard) {
    const line = toolCompactLine(glyph, title, toolStateLabel(state).word, Math.max(1, width), formatDurationMs(entry.wallMs));
    return (
      <box flexDirection="column" width={Math.max(1, width)} flexShrink={0} minWidth={0} marginTop={display.spacing}>
        <text width={Math.max(1, width)} height={1} wrapMode="none" truncate fg={tone}>{line}{repeat}</text>
      </box>
    );
  }

  const inner = frame.innerWidth;
  const bodyWidth = Math.max(1, inner - (expanded ? 1 : 0));
  const expandHint = toggleable
    ? ` · click${TOOL_EXPAND_KEY ? ` or ${TOOL_EXPAND_KEY}` : ""} to expand`
    : "";
  const scrollbarOptions = {
    trackOptions: { backgroundColor: PANEL, foregroundColor: MUTED },
    arrowOptions: { foregroundColor: MUTED, backgroundColor: PANEL },
  };

  // ── code (the source that ran) — syntax-highlighted, bounded, collapsible ──
  const codeLinesAll = (entry.codeSource ?? "").split("\n");
  const codeRetained = codeLinesAll.slice(0, EXPANDED_OUTPUT_LINES);
  const codeVisible = codeRetained.slice(0, expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES);
  const codeHidden = codeRetained.length - codeVisible.length;
  const codeCapped = codeLinesAll.length > codeRetained.length;
  const codeRows = Math.max(1, Math.min(MAX_OUTPUT_ROWS, codeVisible.length));

  // ── output (captured stdout/stderr) — same bounded/scrollbox idiom ──
  const outLinesAll = (entry.codeOutput ?? "")
    .split("\n")
    .map((line) => sanitizeTuiText(line.slice(0, 512)));
  const outRetained = outLinesAll.slice(0, EXPANDED_OUTPUT_LINES);
  const outVisible = outRetained.slice(0, expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES);
  const outHidden = outRetained.length - outVisible.length;
  const outCapped = outLinesAll.length > outRetained.length;
  const hasOutput = (entry.codeOutput ?? "").length > 0;
  const outRows = Math.max(1, Math.min(MAX_OUTPUT_ROWS, outVisible.length));

  const statusRows = toolStatusRows(entry, state, outRetained.length, outCapped);
  const columns = statusColumns(statusRows, inner);

  const durText = formatDurationMs(entry.wallMs);
  const durSuffix = durText ? ` · (${durText})` : "";
  const headerGlyph = failed ? `${glyph} ` : "";
  const headline = fitTuiText(`${headerGlyph}${title}${repeat ?? ""}${durSuffix}`, inner);
  const shimmer = running && typeof display.shimmerFrame === "number";

  const codeBody = codeVisible.map((line, index) => (
    <CodeLine
      key={`${entry.id}-code-${index}`}
      line={line}
      language={language}
      width={bodyWidth}
      theme={theme}
      keyPrefix={`${entry.id}-code-${index}`}
    />
  ));

  return (
    <box
      flexDirection="column"
      width={frame.outerWidth}
      flexShrink={0}
      minWidth={0}
      marginTop={display.spacing}
      border
      borderStyle="rounded"
      borderColor={stateBorder(state, theme)}
      title={headline || undefined}
      titleColor={failed ? ERROR : BRAND}
      titleAlignment="left"
      backgroundColor={PANEL}
      paddingX={1}
    >
      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label={langLabel} width={inner} theme={theme} />
        {codeVisible.length > 0 ? (
          expanded ? (
            <scrollbox width={inner} height={Math.max(1, codeRows)} flexShrink={0} scrollX={false} verticalScrollbarOptions={scrollbarOptions}>
              <box width={bodyWidth} flexDirection="column" flexShrink={0} minWidth={0}>{codeBody}</box>
            </scrollbox>
          ) : (
            <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>{codeBody}</box>
          )
        ) : (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>{fitTuiText("(no source)", inner)}</text>
        )}
        {codeHidden > 0 ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(`… ${codeHidden} more line${codeHidden === 1 ? "" : "s"}${expandHint}`, inner)}
          </text>
        ) : null}
        {codeCapped ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText("Source capped; additional lines are not retained here", inner)}
          </text>
        ) : null}
      </box>

      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label="Output" width={inner} theme={theme} />
        {hasOutput && outVisible.length > 0 ? (
          expanded ? (
            <scrollbox width={inner} height={Math.max(1, outRows)} flexShrink={0} scrollX={false} verticalScrollbarOptions={scrollbarOptions}>
              <box width={bodyWidth} flexDirection="column" flexShrink={0} minWidth={0}>
                {outVisible.map((line, index) => (
                  <text key={`${entry.id}-out-${index}`} width={bodyWidth} height={1} wrapMode="none" truncate fg={failed ? ERROR : TEXT}>
                    {fitTuiText(line, bodyWidth)}
                  </text>
                ))}
              </box>
            </scrollbox>
          ) : (
            <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>
              {outVisible.map((line, index) => (
                <text key={`${entry.id}-out-${index}`} width={bodyWidth} height={1} wrapMode="none" truncate fg={failed ? ERROR : TEXT}>
                  {fitTuiText(line, bodyWidth)}
                </text>
              ))}
            </box>
          )
        ) : (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(running ? "Awaiting output" : "No output", inner)}
          </text>
        )}
        {outHidden > 0 ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(`${outHidden} more preview line${outHidden === 1 ? "" : "s"}${expandHint}`, inner)}
          </text>
        ) : null}
        {outCapped ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText("Preview capped; additional output is not retained here", inner)}
          </text>
        ) : null}
      </box>

      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label="Status" width={inner} theme={theme} />
        {statusRows.map((row, index) =>
          columns.labelWidth > 0 ? (
            <box key={`${entry.id}-status-${index}`} flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0} gap={columns.gap}>
              <box width={columns.labelWidth} flexShrink={0} minWidth={0}>
                <text width={columns.labelWidth} height={1} wrapMode="none" truncate fg={MUTED}>{fitTuiText(row.label, columns.labelWidth)}</text>
              </box>
              <box width={columns.valueWidth} flexShrink={0} minWidth={0}>
                <text width={columns.valueWidth} height={1} wrapMode="none" truncate fg={row.tone === "error" ? ERROR : row.tone === "state" ? tone : MUTED} attributes={row.tone === "error" ? TextAttributes.BOLD : undefined}>
                  {fitTuiText(row.value, columns.valueWidth)}
                </text>
              </box>
            </box>
          ) : (
            <text key={`${entry.id}-status-${index}`} width={inner} height={1} wrapMode="none" truncate fg={row.tone === "error" ? ERROR : MUTED}>
              {fitTuiText(`${row.label} ${row.value}`, inner)}
            </text>
          ),
        )}
      </box>

      {running ? (
        shimmer ? <ShimmerText label={`${glyph} running`} frame={display.shimmerFrame!} base={MUTED} peak={TEXT} />
          : <text fg={MUTED}>{`${glyph} running`}</text>
      ) : null}
    </box>
  );
}

export function ToolCard({
  entry,
  width,
  display,
  theme,
  expanded,
  toggleable = false,
  repeat = "",
}: ToolCardProps): React.ReactNode {
  if (entry.metaKind === "code") {
    return (
      <CodeCard
        entry={entry}
        width={width}
        display={display}
        theme={theme}
        expanded={expanded}
        toggleable={toggleable}
        repeat={repeat}
      />
    );
  }
  if (entry.metaKind === "task") {
    return (
      <TaskCard
        entry={entry}
        width={width}
        display={display}
        theme={theme}
        expanded={expanded}
        toggleable={toggleable}
        repeat={repeat}
      />
    );
  }
  const { TEXT, MUTED, ERROR, BRAND, PANEL } = theme;
  const state = toolState(entry);
  const failed = state === "failed";
  const running = state === "running";
  const { glyph } = toolStateLabel(state);
  const tone = stateTone(state, theme);

  const preview = previewFor(entry, failed);
  const title = toolActionTitle(entry);
  const badge = toolBadgeLabel(entry, preview);
  // The RESULT summary (OMP-style): the "what it found" line a settled call
  // carries. Absent while running, and for the metaKind cards that render their
  // own result region. See `toolResultLine`.
  const resultLine = toolResultLine(entry);

  const frame = commandCardFrame(width);
  const useCard = frame.render && display.richToolCards !== false;

  // Below the chrome budget (or with rich cards switched off) the row degrades
  // to the single honest line it always had — never a half-drawn frame. The
  // result summary rides where the state word used to (glyph + colour already
  // carry the state), falling back to the state word while a call runs.
  if (!useCard) {
    const line = toolCompactLine(glyph, title, resultLine ?? toolStateLabel(state).word, Math.max(1, width), formatDurationMs(entry.wallMs));
    return (
      <box flexDirection="column" width={Math.max(1, width)} flexShrink={0} minWidth={0} marginTop={display.spacing}>
        <text width={Math.max(1, width)} height={1} wrapMode="none" truncate fg={tone}>{line}{repeat}</text>
      </box>
    );
  }

  const inner = frame.innerWidth;
  // One cell is surrendered to the scrollbar when the body can scroll.
  const bodyWidth = Math.max(1, inner - (expanded ? 1 : 0));

  // ── output ────────────────────────────────────────────────────────────────
  const retained = preview.lines
    .slice(0, EXPANDED_OUTPUT_LINES)
    .map((line) => sanitizeTuiText(line.slice(0, 512)));
  const visible = retained.slice(0, expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES);
  const hiddenLines = retained.length - visible.length;
  const capped = preview.truncated || preview.lines.length > retained.length;

  // A diff body (edit card, or any preview the projector tagged `diff`) is
  // rendered through `DiffLine`: flat green/red on changed lines plus
  // syntax-highlighted context lines in the edited file's language.
  const isDiff = entry.metaKind === "edit" || preview.language === "diff";
  const diffLang = entry.metaKind === "edit" ? (pathExtension(entry.editPath) || undefined) : undefined;

  const outputBody = preview.kind === "code" && bodyWidth >= 3
    ? renderMarkdownBlocks(
        [{
          kind: "code",
          language: preview.language,
          lines: visible.map((line) => fitTuiText(line, Math.max(1, bodyWidth - 2))),
        }],
        `${entry.id}-preview`,
        theme,
      )
    : visible.map((line, index) =>
        isDiff ? (
          <DiffLine
            key={`${entry.id}-output-${index}`}
            line={line}
            language={diffLang}
            width={bodyWidth}
            theme={theme}
            keyPrefix={`${entry.id}-diff-${index}`}
          />
        ) : (
          <text
            key={`${entry.id}-output-${index}`}
            width={bodyWidth}
            height={1}
            wrapMode="none"
            truncate
            fg={TEXT}
          >
            {fitTuiText(line, bodyWidth)}
          </text>
        ),
      );

  const outputRows = Math.min(
    MAX_OUTPUT_ROWS,
    visible.length + (preview.kind === "code" && preview.language ? 1 : 0),
  );

  // ── input ─────────────────────────────────────────────────────────────────
  const input = toolInputSection(entry, MAX_INPUT_ROWS);

  // ── status ────────────────────────────────────────────────────────────────
  const statusRows = toolStatusRows(entry, state, retained.length, capped);
  const columns = statusColumns(statusRows, inner);

  const allImages: readonly ChatImageAttachment[] = entry.toolPreview?.images ?? preview.images ?? entry.images ?? [];
  const images = allImages.slice(0, MAX_CARD_IMAGES);

  // The headline glyph is kind-aware: a failure always shows ×; otherwise each
  // kind carries its own identity glyph (edit ✎, web ⌕, or the per-tool glyph
  // from TOOL_IDENTITY). A command title already begins with "$ ", so its glyph
  // is left empty to avoid doubling the marker.
  const kindGlyph =
    entry.metaKind === "command" ? ""
      : entry.metaKind === "edit" ? "✎"
        : entry.metaKind === "web" ? "⌕"
          : entry.metaKind === "image" ? "❏"
            : toolKindIdentity(entry.text)?.glyph ?? "";
  const headerGlyph = failed ? `${glyph} ` : running ? "" : kindGlyph ? `${kindGlyph} ` : "";
  // Execution time rides the TOP of the card, OMP-style: ` · (<dur>)` appended
  // to the headline. Only a measured `wallMs` prints — never an estimate. The
  // old bottom "Duration" STATUS row is gone (see `toolStatusRows`).
  const durText = formatDurationMs(entry.wallMs);
  const durSuffix = durText ? ` · (${durText})` : "";
  // OMP row shape: `<glyph> <Verb inputs> · <result summary> · <badge> · (dur)`.
  // The summary sits right after the title so the headline reads as a complete
  // sentence — what ran, then what it found — before the language/kind chip.
  const summarySuffix = resultLine ? ` · ${resultLine}` : "";
  const headline = fitTuiText(
    `${headerGlyph}${title}${repeat}${summarySuffix}${badge ? ` · ${badgeChip(badge, inner)}` : ""}${durSuffix}`,
    inner,
  );
  const shimmer = running && typeof display.shimmerFrame === "number";

  return (
    <box
      flexDirection="column"
      width={frame.outerWidth}
      flexShrink={0}
      minWidth={0}
      marginTop={display.spacing}
      border
      borderStyle="rounded"
      borderColor={stateBorder(state, theme)}
      title={headline || undefined}
      titleColor={failed ? ERROR : BRAND}
      titleAlignment="left"
      backgroundColor={PANEL}
      paddingX={1}
    >

      {input ? (
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          <SectionRule label={input.label} width={inner} theme={theme} />
          {input.lines.map((line, index) => (
            <CodeLine
              key={`${entry.id}-input-${index}`}
              line={line}
              language={input.language}
              width={inner}
              theme={theme}
              keyPrefix={`${entry.id}-input-${index}`}
            />
          ))}
        </box>
      ) : null}

      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label="Output" width={inner} theme={theme} />
        {visible.length > 0 ? (
          expanded ? (
            <scrollbox
              width={inner}
              height={Math.max(1, outputRows)}
              flexShrink={0}
              scrollX={false}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.PANEL,
                  foregroundColor: theme.MUTED,
                },
                arrowOptions: {
                  foregroundColor: theme.MUTED,
                  backgroundColor: theme.PANEL,
                },
              }}
            >
              <box width={bodyWidth} flexDirection="column" flexShrink={0} minWidth={0}>{outputBody}</box>
            </scrollbox>
          ) : (
            <box width={inner} flexDirection="column" flexShrink={0} minWidth={0}>{outputBody}</box>
          )
        ) : (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(running ? "Awaiting output" : "No output retained", inner)}
          </text>
        )}
        {hiddenLines > 0 ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText(`${hiddenLines} more preview lines${toggleable ? ` · click${TOOL_EXPAND_KEY ? ` or ${TOOL_EXPAND_KEY}` : ""} to expand` : ""}`, inner)}
          </text>
        ) : null}
        {capped ? (
          <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
            {fitTuiText("Preview capped; additional output is not retained here", inner)}
          </text>
        ) : null}
      </box>

      <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
        <SectionRule label="Status" width={inner} theme={theme} />
        {statusRows.map((row, index) =>
          columns.labelWidth > 0 ? (
            <box
              key={`${entry.id}-status-${index}`}
              flexDirection="row"
              width={inner}
              height={1}
              flexShrink={0}
              minWidth={0}
              gap={columns.gap}
            >
              <box width={columns.labelWidth} flexShrink={0} minWidth={0}>
                <text width={columns.labelWidth} height={1} wrapMode="none" truncate fg={MUTED}>
                  {fitTuiText(row.label, columns.labelWidth)}
                </text>
              </box>
              <box width={columns.valueWidth} flexShrink={0} minWidth={0}>
                <text
                  width={columns.valueWidth}
                  height={1}
                  wrapMode="none"
                  truncate
                  fg={row.tone === "error" ? ERROR : row.tone === "state" ? tone : MUTED}
                  attributes={row.tone === "error" ? TextAttributes.BOLD : undefined}
                >
                  {fitTuiText(row.value, columns.valueWidth)}
                </text>
              </box>
            </box>
          ) : (
            <text
              key={`${entry.id}-status-${index}`}
              width={inner}
              height={1}
              wrapMode="none"
              truncate
              fg={row.tone === "error" ? ERROR : MUTED}
            >
              {fitTuiText(`${row.label} ${row.value}`, inner)}
            </text>
          ),
        )}
      </box>

      {images.map((image, index) => (
        <ImageCard
          key={`${entry.id}-image-${image.index ?? index}`}
          image={image}
          width={inner}
          theme={theme}
          marginTop={1}
        />
      ))}
      {running ? (
        shimmer ? <ShimmerText label={`${glyph} running`} frame={display.shimmerFrame!} base={MUTED} peak={TEXT} />
          : <text fg={MUTED}>{`${glyph} running`}</text>
      ) : null}
    </box>
  );
}

export default ToolCard;
