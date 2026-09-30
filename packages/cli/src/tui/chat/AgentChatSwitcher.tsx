/** @jsxImportSource @opentui/react */
import React, { useMemo, useState } from "react";
import stringWidth from "string-width";
import { TextAttributes } from "@opentui/core";
import { sanitizeHerdText, type HerdSubagentMap, type SubagentStatus } from "../herd-layout.js";
import type { Theme } from "../theme-context.js";
import { truncateGhostText } from "./Composer.js";
import { sanitizeTuiText } from "../text.js";
import { ELAPSED_VISIBLE_AFTER_MS, formatElapsed } from "../animation.js";
import {
  agentChatWorkItems,
  computeAgentWorkListLayout,
  nextHiddenAgentChatWorkItemId,
  type AgentChatTab,
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
  /** Optional live Main activity; absent means the truthful static conversation label. */
  mainActivity?: string;
}

function fitCells(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitizeTuiText(value);
  if (stringWidth(text) <= width) return text;
  const suffix = width >= 3 ? "…" : "";
  return `${truncateGhostText(text, width - stringWidth(suffix))}${suffix}`;
}

function displayWorkActivity(tab: AgentChatTab): string {
  const activity = tab.activity ?? tab.status;
  const runningPrefix = "running · ";
  return tab.status === "running" && activity.startsWith(runningPrefix)
    ? activity.slice(runningPrefix.length)
    : activity;
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
  title,
  activity,
  status,
  height,
  width,
  selected,
  theme,
  interactive,
  runningGlyph,
  elapsed,
  onPress,
}: {
  title: string;
  activity: string;
  status?: SubagentStatus;
  height: number;
  width: number;
  selected: boolean;
  theme: Theme;
  interactive: boolean;
  runningGlyph: string;
  elapsed?: string;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  if (width <= 0 || height <= 0) return null;
  const background = selected ? theme.PRIMARY : hovered && interactive ? theme.PANEL_ALT : theme.CANVAS;
  const foreground = selected ? theme.CANVAS : theme.MUTED;
  const markerWidth = width >= 3 ? 2 : 0;
  const marker = selected ? "▶ " : "  ";
  const glyph = status ? workStatusGlyph(status, runningGlyph) : "›";
  const statusColor = selected ? theme.CANVAS : status ? workStatusColor(status, theme) : theme.MUTED;
  const timerWidth = elapsed ? stringWidth(elapsed) + 1 : 0;
  const glyphWidth = Math.min(3, width);
  const compactPrefixWidth = Math.min(width, markerWidth + glyphWidth);
  const compactTimerWidth = elapsed && width >= compactPrefixWidth + timerWidth + 8 ? timerWidth : 0;
  const compactTextWidth = Math.max(0, width - compactPrefixWidth - compactTimerWidth);
  const titleWidth = Math.max(0, width - markerWidth);
  const activityWidth = Math.max(0, width - glyphWidth - timerWidth);
  const oneLine = height === 1 ? fitCells(`${title} · ${activity}`, compactTextWidth) : undefined;
  return (
    <box width={width} height={height} flexShrink={0} minWidth={0} minHeight={0} flexDirection="column"
      overflow="hidden" backgroundColor={background}
      onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        if (!interactive || event.button !== 0) return;
        event.stopPropagation();
        onPress();
      }}>
      {height === 1 ? (
        <box width={width} height={1} flexShrink={0} minWidth={0} flexDirection="row">
          <text width={compactPrefixWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
            {`${marker}${glyph}  `}
          </text>
          {compactTimerWidth > 0 ? (
            <text width={compactTimerWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
              {`${elapsed} `}
            </text>
          ) : null}
          <text width={compactTextWidth} height={1} flexShrink={0} minWidth={0} wrapMode="none" truncate
            fg={selected ? theme.CANVAS : theme.MUTED}
            attributes={selected ? TextAttributes.BOLD : undefined}>{oneLine}</text>
        </box>
      ) : (
        <>
          <box width={width} height={1} flexShrink={0} minWidth={0} flexDirection="row">
            {markerWidth > 0 ? <text width={markerWidth} height={1} flexShrink={0} wrapMode="none"
              fg={selected ? theme.CANVAS : theme.MUTED} attributes={selected ? TextAttributes.BOLD : undefined}>{marker}</text> : null}
            <text width={titleWidth} height={1} flexShrink={0} minWidth={0} wrapMode="none" truncate
              fg={selected ? theme.CANVAS : theme.MUTED} attributes={selected ? TextAttributes.BOLD : undefined}>
              {fitCells(title, titleWidth)}
            </text>
          </box>
          <box width={width} height={1} flexShrink={0} minWidth={0} flexDirection="row">
            <text width={glyphWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
              {`${glyph}  `}
            </text>
            {elapsed ? (
              <text width={timerWidth} height={1} flexShrink={0} wrapMode="none" fg={statusColor}>
                {`${elapsed} `}
              </text>
            ) : null}
            <text width={activityWidth} height={1} flexShrink={0} minWidth={0} wrapMode="none" truncate
              fg={foreground}>
              {fitCells(activity, activityWidth)}
            </text>
          </box>
        </>
      )}
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
  mainActivity,
  onSelect,
}: AgentWorkListProps) {
  const tabs = useMemo(() => agentChatWorkItems(agents), [agents]);
  const layout = useMemo(() => computeAgentWorkListLayout(tabs, selectedAgentId, width, height),
    [tabs, selectedAgentId, width, height]);
  if (layout.width === 0 || layout.height === 0) return null;
  const now = Date.now();
  const mainSelected = selectedAgentId === null;
  const mainDetail = sanitizeHerdText(mainActivity || "current conversation");
  const nextHiddenId = nextHiddenAgentChatWorkItemId(tabs, layout.visibleTabs);
  const nextHiddenTab = tabs.find((tab) => tab.id === nextHiddenId);
  const moreLabel = `+${layout.hiddenCount} more · Next ${nextHiddenTab?.label ?? "agent"}`;
  return (
    <box width={layout.width} height={layout.height} flexShrink={0} minWidth={0} minHeight={0}
      flexDirection="column" overflow="hidden">
      <AgentWorkRow title="Main" activity={mainDetail} height={layout.itemHeight} width={layout.width}
        selected={mainSelected} theme={theme} interactive={interactive} runningGlyph={runningGlyph}
        onPress={() => onSelect(null)} />
      {layout.separatorHeight > 0 ? <WorkSeparator width={layout.width} theme={theme} /> : null}
      {layout.visibleTabs.map((tab) => {
        const elapsedMs = tab.status === "running" && tab.startedAt !== undefined
          ? now - tab.startedAt
          : undefined;
        const elapsed = elapsedMs !== undefined && elapsedMs >= ELAPSED_VISIBLE_AFTER_MS
          ? formatElapsed(elapsedMs)
          : undefined;
        return (
          <React.Fragment key={tab.id}>
            <AgentWorkRow title={tab.label} activity={displayWorkActivity(tab)} status={tab.status}
              height={layout.itemHeight} width={layout.width} selected={tab.id === selectedAgentId}
              theme={theme} interactive={interactive} runningGlyph={runningGlyph} elapsed={elapsed}
              onPress={() => onSelect(tab.id)} />
            {layout.separatorHeight > 0 ? <WorkSeparator width={layout.width} theme={theme} /> : null}
          </React.Fragment>
        );
      })}
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
