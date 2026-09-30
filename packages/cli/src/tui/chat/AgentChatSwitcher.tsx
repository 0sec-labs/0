/** @jsxImportSource @opentui/react */
import React, { useMemo, useState } from "react";
import stringWidth from "string-width";
import { TextAttributes } from "@opentui/core";
import type { HerdSubagentMap, SubagentStatus } from "../herd-layout.js";
import type { Theme } from "../theme-context.js";
import { truncateGhostText } from "./Composer.js";
import { sanitizeTuiText } from "../text.js";
import {
  agentChatWorkItems,
  computeAgentWorkListLayout,
  nextHiddenAgentChatWorkItemId,
  type AgentWorkRowLayout,
} from "./agent-chat-switcher-layout.js";

export interface AgentWorkListProps {
  agents: Readonly<HerdSubagentMap>;
  selectedAgentId: string | null;
  width: number;
  height: number;
  theme: Theme;
  interactive: boolean;
  runningGlyph: string;
  onSelect: (id: string | null) => void;
  /** Original task/goal, extracted without a display-only character or word cap. */
  mainTask?: string;
  /** Real live Main activity only; absent means no extra activity row. */
  mainActivity?: string;
}

function fitCells(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitizeTuiText(value);
  if (stringWidth(text) <= width) return text;
  const suffix = width >= 3 ? "…" : "";
  return `${truncateGhostText(text, width - stringWidth(suffix))}${suffix}`;
}

function workStatusGlyph(status: SubagentStatus, runningGlyph: string): string {
  switch (status) {
    case "queued": return "◷";
    case "running": return runningGlyph;
    case "completed": return "✓";
    case "failed": return "×";
    case "parked": return "Ⅱ";
  }
}

function workStatusColor(status: SubagentStatus, theme: Theme): string {
  switch (status) {
    case "queued": return theme.WARNING;
    case "running": return theme.ACCENT;
    case "completed": return theme.SUCCESS;
    case "failed": return theme.ERROR;
    case "parked": return theme.MUTED;
  }
}

function AgentWorkRow({
  row,
  width,
  status,
  selected,
  theme,
  interactive,
  runningGlyph,
  onPress,
}: {
  row: AgentWorkRowLayout;
  width: number;
  status?: SubagentStatus;
  selected: boolean;
  theme: Theme;
  interactive: boolean;
  runningGlyph: string;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  if (width <= 0 || row.height <= 0) return null;
  const background = selected ? theme.PRIMARY : hovered && interactive ? theme.PANEL_ALT : theme.CANVAS;
  const foreground = selected ? theme.CANVAS : theme.MUTED;
  const { markerWidth, glyphWidth, timerWidth, elapsed, titleWidth, activityWidth } = row;
  const marker = selected ? "▶ " : "  ";
  const glyph = status ? workStatusGlyph(status, runningGlyph) : "›";
  const statusColor = selected ? theme.CANVAS : status ? workStatusColor(status, theme) : theme.MUTED;
  const compact = row.activityLines.length === 0 && status !== undefined;
  return (
    <box width={width} height={row.height} flexShrink={0} minWidth={0} minHeight={0} flexDirection="column"
      overflow="hidden" backgroundColor={background}
      onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        if (!interactive || event.button !== 0) return;
        event.stopPropagation();
        onPress();
      }}>
      {row.titleLines.map((line, index) => (
        <box key={`task-${index}`} width={width} height={1} flexShrink={0} minWidth={0} flexDirection="row">
          {markerWidth > 0 ? <text width={markerWidth} height={1} flexShrink={0} wrapMode="none"
            fg={foreground} attributes={selected ? TextAttributes.BOLD : undefined}>{index === 0 ? marker : "  "}</text> : null}
          {compact ? <text width={glyphWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
            {`${glyph}  `}
          </text> : null}
          {compact && timerWidth > 0 ? <text width={timerWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
            {`${elapsed} `}
          </text> : null}
          <text width={titleWidth} height={1} flexShrink={0} minWidth={0} wrapMode="none"
            fg={foreground} attributes={selected ? TextAttributes.BOLD : undefined}>
            {fitCells(line, titleWidth)}
          </text>
        </box>
      ))}
      {row.activityLines.map((line, index) => (
        <box key={`activity-${index}`} width={width} height={1} flexShrink={0} minWidth={0} flexDirection="row">
          <text width={glyphWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
            {index === 0 ? `${glyph}  ` : " ".repeat(glyphWidth)}
          </text>
          {timerWidth > 0 ? <text width={timerWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
            {index === 0 ? `${elapsed} ` : " ".repeat(timerWidth)}
          </text> : null}
          <text width={activityWidth} height={1} flexShrink={0} minWidth={0} wrapMode="none" fg={foreground}>
            {fitCells(line, activityWidth)}
          </text>
        </box>
      ))}
    </box>
  );
}

function WorkSeparator({ width, theme }: { width: number; theme: Theme }) {
  return width > 0 ? (
    <text width={width} height={1} flexShrink={0} wrapMode="none" fg={theme.BORDER}>
      {"─".repeat(width)}
    </text>
  ) : null;
}

/** Full-width, mouse-selectable work rows below the composer; it never intercepts composer keys. */
export function AgentWorkList({
  agents,
  selectedAgentId,
  width,
  height,
  theme,
  interactive,
  runningGlyph,
  mainTask,
  mainActivity,
  onSelect,
}: AgentWorkListProps) {
  const tabs = useMemo(() => agentChatWorkItems(agents), [agents]);
  const layout = computeAgentWorkListLayout(tabs, selectedAgentId, width, height, mainTask, mainActivity);
  if (layout.width === 0 || layout.height === 0) return null;
  const mainSelected = selectedAgentId === null;
  const nextHiddenId = nextHiddenAgentChatWorkItemId(tabs, layout.visibleTabs);
  const nextHiddenTab = tabs.find((tab) => tab.id === nextHiddenId);
  const moreLabel = `+${layout.hiddenCount} more · Next ${nextHiddenTab?.label ?? "agent"}`;
  return (
    <box width={layout.width} height={layout.height} flexShrink={0} minWidth={0} minHeight={0}
      flexDirection="column" overflow="hidden">
      {layout.mainHeight > 0 ? (
        <>
          <AgentWorkRow row={layout.mainRow} width={layout.width}
            selected={mainSelected} theme={theme} interactive={interactive} runningGlyph={runningGlyph}
            onPress={() => onSelect(null)} />
          {layout.separatorHeight > 0 ? <WorkSeparator width={layout.width} theme={theme} /> : null}
        </>
      ) : null}
      {layout.visibleRows.map(({ tab, row }) => (
        <React.Fragment key={tab.id}>
          <AgentWorkRow row={row} status={tab.status}
            width={layout.width} selected={tab.id === selectedAgentId}
            theme={theme} interactive={interactive} runningGlyph={runningGlyph}
            onPress={() => onSelect(tab.id)} />
          {layout.separatorHeight > 0 ? <WorkSeparator width={layout.width} theme={theme} /> : null}
        </React.Fragment>
      ))}
      {layout.showMore ? (
        <box width={layout.width} height={1} flexShrink={0} minWidth={0} flexDirection="row"
          backgroundColor={theme.CANVAS}
          onMouseDown={(event) => {
            if (!interactive || event.button !== 0 || nextHiddenId === null) return;
            event.stopPropagation();
            onSelect(nextHiddenId);
          }}>
          <text width={layout.width} height={1} wrapMode="none" truncate fg={theme.ACCENT}>
            {fitCells(moreLabel, layout.width)}
          </text>
        </box>
      ) : null}
    </box>
  );
}
