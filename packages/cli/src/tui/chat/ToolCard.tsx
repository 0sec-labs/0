/** @jsxImportSource @opentui/react */
import React from "react";
import { TextAttributes } from "@opentui/core";

import { fitTuiText, sanitizeTuiText } from "../text.js";
import { commandCardFrame, toolCompactLine } from "../transcript-style.js";
import { projectToolPreview, type ToolPreview } from "../tool-format.js";
import { codeTokenStyle, highlightCode } from "../syntax-style.js";
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
  statusColumns,
  toolActionTitle,
  toolBadgeLabel,
  toolInputSection,
  toolState,
  toolStateLabel,
  toolStatusRows,
  type ToolState,
} from "./card-layout.js";

/**
 * A tool call, drawn as a titled rounded card.
 *
 *   ╭ $ npm test -- --silent · SH ──────────────╮
 *   │ COMMAND ─────────────────────────────────│
 *   │ npm test -- --silent      (highlighted)  │
 *   │ OUTPUT ──────────────────────────────────│
 *   │ …                                        │
 *   │ STATUS ──────────────────────────────────│
 *   │ State    complete                        │
 *   │ Exit     0                               │
 *   │ Duration 1.24s                           │
 *   ╰──────────────────────────────────────────╯
 *
 * What the card is allowed to say:
 *
 *   - The top-border TITLE is the operation that actually ran — the command
 *     string, edited path, search provider, or tool name with its recorded
 *     argument summary. Its language/kind chip comes from retained metadata.
 *     There is no generic stand-in title and no second heading in the body.
 *   - STATUS is derived, never assumed: a call with no recorded outcome reads
 *     "running", a non-zero exit or a wallclock kill reads "failed" in the
 *     error tone, and only `success === true` reads "complete". Finishing is
 *     not succeeding.
 *   - DURATION is printed only from a measured `wallMs`. An entry that carries
 *     no measurement gets no Duration row — never an estimate.
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
  const { TEXT, MUTED, ERROR, BRAND, ACCENT, PANEL } = theme;
  const state = toolState(entry);
  const failed = state === "failed";
  const running = state === "running";
  const { glyph } = toolStateLabel(state);
  const tone = stateTone(state, theme);

  const frame = commandCardFrame(width);
  const useCard = frame.render && display.richToolCards !== false;
  const title = `Task${entry.taskLabel ? ` • ${entry.taskLabel}` : ""}`;

  if (!useCard) {
    const line = toolCompactLine(glyph, title, toolStateLabel(state).word, Math.max(1, width));
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
  const headline = fitTuiText(`${headerGlyph}${title}${repeat ?? ""}`, inner);
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
        <box flexDirection="column" width={inner} flexShrink={0} minWidth={0} marginTop={1}>
          <SectionRule label="Agents" width={inner} theme={theme} />
          {subRows.map((row, index) => (
            <box key={`${entry.id}-agent-${index}`} flexDirection="row" width={inner} height={1} flexShrink={0} minWidth={0}>
              <text flexShrink={0} fg={MUTED}>{"• "}</text>
              <text flexShrink={0} fg={ACCENT} attributes={TextAttributes.BOLD} wrapMode="none">{row.name}</text>
              {row.badge ? <text flexShrink={0} fg={MUTED} wrapMode="none">{row.badge}</text> : null}
              {row.brief ? <text flexShrink={1} fg={MUTED} wrapMode="none" truncate>{fitTuiText(row.brief, Math.max(1, inner - 2 - row.name.length - row.badge.length - row.isolated.length))}</text> : null}
              {row.isolated ? <text flexShrink={0} fg={MUTED} wrapMode="none">{row.isolated}</text> : null}
            </box>
          ))}
          {hiddenAgents > 0 ? (
            <text width={inner} height={1} wrapMode="none" truncate fg={MUTED}>
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

export function ToolCard({
  entry,
  width,
  display,
  theme,
  expanded,
  toggleable = false,
  repeat = "",
}: ToolCardProps): React.ReactNode {
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
  const { TEXT, MUTED, ERROR, SUCCESS, BRAND, PANEL } = theme;
  const state = toolState(entry);
  const failed = state === "failed";
  const running = state === "running";
  const { glyph } = toolStateLabel(state);
  const tone = stateTone(state, theme);

  const preview = previewFor(entry, failed);
  const title = toolActionTitle(entry);
  const badge = toolBadgeLabel(entry, preview);

  const frame = commandCardFrame(width);
  const useCard = frame.render && display.richToolCards !== false;

  // Below the chrome budget (or with rich cards switched off) the row degrades
  // to the single honest line it always had — never a half-drawn frame.
  if (!useCard) {
    const line = toolCompactLine(glyph, title, toolStateLabel(state).word, Math.max(1, width));
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
    : visible.map((line, index) => (
        <text
          key={`${entry.id}-output-${index}`}
          width={bodyWidth}
          height={1}
          wrapMode="none"
          truncate
          fg={
            (entry.metaKind === "edit" || preview.language === "diff") && line.startsWith("+") ? SUCCESS
              : (entry.metaKind === "edit" || preview.language === "diff") && line.startsWith("-") ? ERROR
                : TEXT
          }
        >
          {fitTuiText(line, bodyWidth)}
        </text>
      ));

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

  const headerGlyph = failed ? `${glyph} ` : !running && entry.metaKind === "edit" ? "✎ " : "";
  const headline = fitTuiText(`${headerGlyph}${title}${repeat}${badge ? ` · ${badgeChip(badge, inner)}` : ""}`, inner);
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
