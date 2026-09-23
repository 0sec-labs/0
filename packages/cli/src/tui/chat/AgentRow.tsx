/** @jsxImportSource @opentui/react */
import React from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../theme-context.js";
import { useSymbols, type SymbolTable } from "../symbol-context.js";
import { fitTuiText } from "../text.js";
import { sidebarBadgeCells } from "./todos-sidebar-layout.js";

/**
 * ONE agent-row look, shared by the inline ACTIVE SUBAGENTS list below the
 * composer and the RIGHT sidebar's fleet view, so the herd reads identically
 * wherever it appears. The two callers hold different records (the inline list
 * a `SubagentLifecyclePayload`, the sidebar a `HerdSubagentRecord`); each
 * normalises into this flat view so neither reimplements the styling.
 *
 * The visual hierarchy mirrors oh-my-posh's segment lists: a small status
 * bullet, a BOLD accent NAME, then the muted task. Red is spent ONLY on a
 * failed row's glyph — never on a label — so the "red = errors/findings"
 * invariant holds. Selection is an obvious full-width highlight BAR (a
 * PANEL_ALT background across the row) plus a leading accent marker, not a
 * subtle weight change.
 */
export interface AgentRowView {
  id: string;
  /** Short, bold-rendered identifier for the agent. */
  name: string;
  /** One-line task/description, rendered muted and truncated to fit. */
  task: string;
  /** Actual assigned role, when reported by the producer. */
  role?: string;
  /** Current activity, separate from the assigned task. */
  activity?: string;
  /** Shared frame counter; omit when motion is disabled. */
  animationFrame?: number;
  /** Lifecycle status; drives the bullet glyph and its colour. */
  status: string;
  /** Optional right-aligned meta, e.g. "3/8" or "3/8 · 1f". */
  meta?: string;
  /**
   * Stable per-agent accent colour (from `agentAccent(id)`), used for the NAME so
   * the same agent reads in the same hue here and in the inter-agent chat log.
   * Falls back to the theme ACCENT when absent.
   */
  accent?: string;
}

/**
 * A short, bold-able name from an agent id. Strips the common `agent-` /
 * `subagent-` / `console-` prefixes, collapses a uuid-ish tail to its first
 * few hex digits, and caps the length so a long id cannot blow the column.
 */
export function shortAgentName(id: string): string {
  let n = (id ?? "").trim();
  n = n.replace(/^(agent|subagent|console)[-_]+/i, "");
  const uuid = n.match(/^([0-9a-f]{4,8})[-0-9a-f]*$/i);
  if (uuid?.[1]) n = uuid[1].slice(0, 6);
  if (n.length > 16) n = `${n.slice(0, 15)}…`;
  return n || "agent";
}

/** Lifecycle mark: only active work animates; settled outcomes remain distinct. */
function statusMark(
  status: string,
  theme: Theme,
  symbols: SymbolTable,
  animationFrame?: number,
): { glyph: string; color: string } {
  if (status === "failed") return { glyph: symbols.cross, color: theme.ERROR };
  if (status === "cancelled" || status === "canceled") return { glyph: symbols.stopped, color: theme.MUTED };
  if (status === "completed" || status === "done") return { glyph: symbols.check, color: theme.SUCCESS };
  if (status === "running" || status === "working") {
    // The animated quarter-block ring is motion-gated and single-cell; the
    // static fallback (no frame) follows the preset's "running" glyph.
    return { glyph: animationFrame === undefined ? symbols.running : "▖▘▝▗"[animationFrame % 4], color: theme.ACCENT };
  }
  // Parked: finished its task but still alive, ready to be revived.
  if (status === "parked") return { glyph: symbols.parked, color: theme.MUTED };
  return { glyph: symbols.queued, color: theme.MUTED };
}

/**
 * The status word as it is shown in the trailing badge: the producer's own
 * status, lowercased with underscores opened out ("in_progress" reads
 * "in progress"). Nothing is inferred or prettified beyond that — an unknown
 * status word is shown as the producer wrote it rather than remapped to a
 * status we would prefer it to be.
 */
export function agentStatusLabel(status: string): string {
  return String(status ?? "").toLowerCase().replace(/_/g, " ").trim();
}

/**
 * The one-line description beside/below the name: the agent's assigned role and
 * task, plus — only while it is genuinely active — what it is doing right now.
 * Every part is omitted when the producer did not supply it; nothing is
 * substituted. `compact` drops the "Latest activity" wording for the narrow
 * sidebar column, where the words would cost more cells than the value.
 */
export function agentTaskLabel(view: AgentRowView, compact: boolean): string {
  const isActive = view.status === "running" || view.status === "working";
  const activity = isActive && view.activity
    ? (compact ? `now ${view.activity}` : `Latest activity: ${view.activity}`)
    : undefined;
  return [view.role, view.task, activity].filter(Boolean).join(" · ");
}

function treeConnector(
  ancestorContinues: readonly boolean[],
  isLast: boolean,
  selected: boolean,
  maxCells: number,
): string {
  const branch = selected ? "▸ " : isLast ? "└─" : "├─";
  const ancestryBudget = Math.max(0, maxCells - branch.length);
  const fullCells = ancestorContinues.length * 2;
  if (fullCells <= ancestryBudget) {
    return `${ancestorContinues.map((continues) => continues ? "│ " : "  ").join("")}${branch}`;
  }

  const showOmission = ancestryBudget >= 2;
  const visibleDepth = Math.floor((ancestryBudget - (showOmission ? 2 : 0)) / 2);
  const visibleAncestors = visibleDepth > 0 ? ancestorContinues.slice(-visibleDepth) : [];
  const ancestry = `${showOmission ? "… " : ""}${visibleAncestors
    .map((continues) => continues ? "│ " : "  ")
    .join("")}`;
  return `${ancestry}${branch}`;
}

/**
 * The inline (below-composer) variant: a single tree row with a left connector
 * (`├─`, `└─` for the last), then `bullet name: task` and optional right meta.
 * When selected the connector is replaced by an accent `▸` marker and the whole
 * row wears a highlight bar. All widths are explicit and sum to `width`, so the
 * row can never overflow or fuse (the chat-layout row invariant).
 */
export function AgentTreeRow({
  view,
  width,
  theme,
  selected,
  isLast,
  ancestorContinues = [],
  onSelect,
}: {
  view: AgentRowView;
  width: number;
  theme: Theme;
  selected: boolean;
  isLast: boolean;
  ancestorContinues?: readonly boolean[];
  onSelect?: () => void;
}) {
  const symbols = useSymbols();
  const { MUTED, ACCENT, PANEL_ALT } = theme;
  const mark = statusMark(view.status, theme, symbols, view.animationFrame);
  const bg = selected ? PANEL_ALT : undefined;
  const meta = agentStatusLabel(view.status);
  // The status badge is budgeted by the SAME arithmetic as the FINDINGS
  // severity badge, so the two sections keep one trailing-badge rhythm; the
  // inline row additionally caps it at 30% so the wide row keeps its task.
  const metaCells = Math.min(sidebarBadgeCells(meta, width), Math.max(0, Math.floor(width * 0.3)));
  const connectorBudget = Math.max(2, width - 8 - metaCells - (metaCells > 0 ? 1 : 0));
  const connector = treeConnector(ancestorContinues, isLast, selected, connectorBudget);
  const connectorCells = connector.length;
  // connector + gap + bullet + gap + [name + task] + [gap + meta].
  const reserved = connectorCells + 1 + 1 + 1 + (metaCells > 0 ? metaCells + 1 : 0);
  const bodyWidth = Math.max(1, width - reserved);
  const nameCells = Math.min(view.name.length, Math.max(4, Math.floor(bodyWidth * 0.45)));
  const taskCells = Math.max(0, bodyWidth - nameCells);
  const nameFg = view.accent ?? ACCENT;

  const taskLabel = agentTaskLabel(view, false);
  // Colour carries the same meaning here as in FINDINGS: the status word wears
  // its own tone (red only for a real failure), never a decorative one.
  const metaFg = selected ? MUTED : mark.color;

  return (
    <box
      flexDirection="row"
      width={width}
      height={1}
      flexShrink={0}
      minWidth={0}
      backgroundColor={bg}
      onMouseDown={onSelect ? (() => onSelect()) : undefined}
    >
      <text width={connectorCells} height={1} flexShrink={0} wrapMode="none" truncate fg={selected ? ACCENT : MUTED} bg={bg}>{connector}</text>
      <text width={1} height={1} flexShrink={0} marginLeft={1} wrapMode="none" truncate fg={mark.color} bg={bg}>{mark.glyph}</text>
      <box width={nameCells} height={1} flexShrink={0} minWidth={0} marginLeft={1} backgroundColor={bg}>
        <text width={nameCells} height={1} wrapMode="none" truncate fg={nameFg} attributes={TextAttributes.BOLD} bg={bg}>{fitTuiText(view.name, nameCells)}</text>
      </box>
      {taskCells > 0 ? (
        <box width={taskCells} height={1} flexShrink={0} minWidth={0} backgroundColor={bg}>
          <text width={taskCells} height={1} wrapMode="none" truncate fg={MUTED} bg={bg}>{fitTuiText(taskLabel ? `: ${taskLabel}` : "", taskCells)}</text>
        </box>
      ) : null}
      {metaCells > 0 ? (
        <box width={metaCells} height={1} flexShrink={0} minWidth={0} marginLeft={1} backgroundColor={bg}>
          <text width={metaCells} height={1} wrapMode="none" truncate fg={metaFg} bg={bg}>{fitTuiText(meta, metaCells)}</text>
        </box>
      ) : null}
    </box>
  );
}

/** Rows the sidebar variant paints per agent (a name line + a task line). */
export const AGENT_SIDEBAR_ROWS = 2;

/**
 * The sidebar variant: two lines in a narrow column — a compact tree connector
 * and status/name/meta over an indented, muted, truncated task. It keeps the
 * bold-name hierarchy and selection bar while allowing very deep ancestry to
 * collapse to a bounded connector. Widths sum to `width` on each line.
 */
export function AgentSidebarRow({
  view,
  width,
  theme,
  selected,
  isLast,
  ancestorContinues = [],
  onSelect,
}: {
  view: AgentRowView;
  width: number;
  theme: Theme;
  selected: boolean;
  isLast: boolean;
  ancestorContinues?: readonly boolean[];
  onSelect?: () => void;
}) {
  const symbols = useSymbols();
  const { MUTED, ACCENT, PANEL_ALT } = theme;
  const mark = statusMark(view.status, theme, symbols, view.animationFrame);
  const bg = selected ? PANEL_ALT : undefined;
  const meta = agentStatusLabel(view.status);
  const metaCells = sidebarBadgeCells(meta, width);
  const connectorBudget = Math.max(2, width - 3 - metaCells - (metaCells > 0 ? 1 : 0));
  const connector = treeConnector(ancestorContinues, isLast, selected, connectorBudget);
  const connectorCells = connector.length;
  const nameCells = Math.max(1, width - connectorCells - 2 - (metaCells > 0 ? metaCells + 1 : 0));
  const taskIndent = connectorCells + 2;
  const taskCells = Math.max(1, width - taskIndent);
  const nameFg = view.accent ?? ACCENT;
  const metaFg = selected ? MUTED : mark.color;

  const taskLabel = agentTaskLabel(view, true);

  return (
    <box
      flexDirection="column"
      width={width}
      height={AGENT_SIDEBAR_ROWS}
      flexShrink={0}
      minWidth={0}
      backgroundColor={bg}
      onMouseDown={onSelect ? (() => onSelect()) : undefined}
    >
      <box flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0}>
        <text width={connectorCells} height={1} flexShrink={0} wrapMode="none" truncate fg={selected ? ACCENT : MUTED} bg={bg}>{connector}</text>
        <text width={1} height={1} flexShrink={0} wrapMode="none" truncate fg={mark.color} bg={bg}>{mark.glyph}</text>
        <box width={nameCells} height={1} flexShrink={0} minWidth={0} marginLeft={1} backgroundColor={bg}>
          <text width={nameCells} height={1} wrapMode="none" truncate fg={nameFg} attributes={TextAttributes.BOLD} bg={bg}>{fitTuiText(view.name, nameCells)}</text>
        </box>
        {metaCells > 0 ? (
          <box width={metaCells} height={1} flexShrink={0} minWidth={0} marginLeft={1} backgroundColor={bg}>
            <text width={metaCells} height={1} wrapMode="none" truncate fg={metaFg} bg={bg}>{fitTuiText(meta, metaCells)}</text>
          </box>
        ) : null}
      </box>
      <box flexDirection="row" width={width} height={1} flexShrink={0} minWidth={0}>
        <box width={taskCells} height={1} flexShrink={0} minWidth={0} marginLeft={taskIndent} backgroundColor={bg}>
          <text width={taskCells} height={1} wrapMode="none" truncate fg={MUTED} bg={bg}>{fitTuiText(taskLabel, taskCells)}</text>
        </box>
      </box>
    </box>
  );
}
