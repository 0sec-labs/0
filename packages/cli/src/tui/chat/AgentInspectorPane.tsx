/** @jsxImportSource @opentui/react */
import React, { useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { HerdSubagentMap } from "../herd-layout.js";
import { commsEdgeLabel, commsFleetStatLine, commsMessageCard, computeCommsEdges, type CommsMessage } from "../agents-comms-layout.js";
import { DialogActionButton } from "../dialog-screen-chrome.js";
import { Cells } from "../primitives.js";
import { sleekScrollbar } from "../scrollbar.js";
import { fitLegend, fitTuiText, sanitizeTuiText } from "../text.js";
import type { Theme } from "../theme-context.js";
import { MessageCard } from "./MessageCard.js";
import { renderEntry } from "./TranscriptEntry.js";
import type { ChatEntry, EntryDisplay } from "./types.js";
import { computeAgentInspectorLayout, inspectorAgentName, inspectorLineage, inspectorMessages, inspectorTabWindow } from "./agent-inspector-layout.js";

export interface AgentInspectorPaneProps {
  agents: Readonly<HerdSubagentMap>;
  activeAgentId: string;
  openAgentIds: readonly string[];
  rootScanId: string;
  transcripts: Readonly<Record<string, readonly ChatEntry[]>>;
  messages: readonly CommsMessage[];
  display: EntryDisplay;
  theme: Theme;
  width: number;
  height: number;
  interactive: boolean;
  onSelectAgent: (id: string) => void;
  onClose: (id: string) => void;
  onReturnToConversation: () => void;
}

/** Padded dialog controls with a one-row degradation for short/narrow panes. */
function InspectorAction({ label, compactLabel, width, height, focused, selected, onPress, theme }: {
  label: string; compactLabel?: string; width: number; height: number;
  focused: boolean; selected?: boolean; onPress: () => void; theme: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  if (width <= 0 || height <= 0) return null;
  if (height === 3 && width >= 8) return (
    <box width={width} height={height} flexShrink={0} overflow="hidden">
      <DialogActionButton label={fitTuiText(label, width - 6)} onPress={onPress}
        variant={selected ? "primary" : "secondary"} focused={focused} />
    </box>
  );
  const paddingX = width >= 5 ? 1 : 0;
  return (
    <box width={width} height={height} flexShrink={0} minWidth={0} overflow="hidden"
      paddingX={paddingX} paddingY={height === 3 ? 1 : 0}
      backgroundColor={focused || hovered ? theme.BORDER : theme.PANEL_ALT}
      onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => { event.stopPropagation(); if (event.button === 0) onPress(); }}>
      <Cells width={Math.max(0, width - paddingX * 2)} fg={selected ? theme.PRIMARY : theme.TEXT}
        attributes={focused || selected ? TextAttributes.BOLD : undefined}>
        {fitTuiText(compactLabel ?? label, Math.max(0, width - paddingX * 2))}
      </Cells>
    </box>
  );
}

/** A view only: changing tabs or closing the pane never messages/stops a worker. */
export function AgentInspectorPane({ agents, activeAgentId, openAgentIds, rootScanId, transcripts,
  messages, display, theme, width, height, interactive, onSelectAgent, onClose,
  onReturnToConversation }: AgentInspectorPaneProps) {
  const [view, setView] = useState<"transcript" | "comms">("transcript");
  const [focus, setFocus] = useState("transcript");
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const layout = computeAgentInspectorLayout(width, height);
  const tabs = useMemo(() => [...new Set(openAgentIds.filter(Boolean))], [openAgentIds]);
  const activeId = tabs.includes(activeAgentId) ? activeAgentId : tabs[0] ?? "";
  const record = agents[activeId];
  const entries = transcripts[activeId] ?? [];
  const nameFor = (id: string) => inspectorAgentName(agents, id, rootScanId);
  const traffic = useMemo(() => inspectorMessages(agents, messages, activeId), [agents, messages, activeId]);
  const edges = useMemo(() => computeCommsEdges(traffic), [traffic]);
  const controls = [...tabs.map((id) => `agent:${id}`), "transcript", "comms", "close", "main"];
  const focusIndex = Math.max(0, controls.indexOf(focus));
  const focusedTab = focus.startsWith("agent:") ? tabs.indexOf(focus.slice(6)) : -1;
  const tabWindow = inspectorTabWindow(tabs.length, focusedTab >= 0 ? focusedTab : tabs.indexOf(activeId), layout.innerWidth);
  const selectAgent = (id: string) => { setFocus(`agent:${id}`); onSelectAgent(id); };
  const nextAgent = (delta: number) => {
    if (tabs.length === 0) return;
    const next = (Math.max(0, tabs.indexOf(activeId)) + delta + tabs.length) % tabs.length;
    selectAgent(tabs[next]!);
  };
  const activate = (control: string) => {
    if (control.startsWith("agent:")) selectAgent(control.slice(6));
    else if (control === "transcript" || control === "comms") { setFocus(control); setView(control); }
    else if (control === "close" && activeId) onClose(activeId);
    else if (control === "main") onReturnToConversation();
  };
  useKeyboard((key) => {
    // Global approval/exit/sidebar chords remain owned by ChatScreen.
    if (!interactive || key.ctrl || key.meta) return;
    if (key.name === "escape") { onReturnToConversation(); return; }
    if (key.name === "tab") {
      setFocus(controls[(focusIndex + (key.shift ? -1 : 1) + controls.length) % controls.length]!);
      return;
    }
    if (key.name === "left" || key.name === "right") { nextAgent(key.name === "left" ? -1 : 1); return; }
    if (key.name === "1" || key.name === "2") { activate(key.name === "1" ? "transcript" : "comms"); return; }
    if (key.name === "x" && activeId) { onClose(activeId); return; }
    if (key.name === "return" || key.name === "enter" || key.name === "space") { activate(controls[focusIndex]!); return; }
    if (key.name === "up" || key.name === "down") scroll.current?.scrollBy(key.name === "up" ? -1 : 1);
    if (key.name === "pageup" || key.name === "pagedown") scroll.current?.scrollBy(key.name === "pageup" ? -0.5 : 0.5, "viewport");
    if (key.name === "home") scroll.current?.scrollTo(0);
    if (key.name === "end") scroll.current?.scrollTo(scroll.current.scrollHeight);
  });
  if (layout.width === 0 || layout.height === 0) return null;
  const actionLabels = ["Transcript", "Comms", "Close", "Main"];
  const actionIds = ["transcript", "comms", "close", "main"];
  const compactLabels = ["T", "C", "×", "M"];
  const actionWidth = Math.floor(layout.innerWidth / 4);
  const lastEntry = entries[entries.length - 1];
  // The main turn's shimmer IDs must not leak into a worker transcript.
  const workerDisplay: EntryDisplay = { ...display,
    activeTurn: record?.status === "running" ? lastEntry?.turn : undefined,
    activeEntryId: record?.status === "running" ? lastEntry?.id : undefined,
  };
  const line = (key: string, value: string, fg = theme.MUTED) => (
    <text key={key} width={layout.textWidth} flexShrink={0} minWidth={0} wrapMode="word" fg={fg}>
      {sanitizeTuiText(value)}
    </text>
  );
  return (
    <box width={layout.width} height={layout.height} flexShrink={0} minWidth={0} minHeight={0}
      flexDirection="column" paddingX={layout.paddingX} backgroundColor={theme.PANEL_ALT} overflow="hidden"
      onMouseDown={(event) => { if (!interactive && activeId && event.button === 0) onSelectAgent(activeId); }}>
      {layout.tabsRows > 0 ? <box width={layout.innerWidth} height={layout.tabsRows} flexShrink={0} flexDirection="row" overflow="hidden">
        {tabWindow.arrowWidth > 0 ? <InspectorAction label="‹" width={tabWindow.arrowWidth} height={layout.tabsRows}
          focused={false} onPress={() => nextAgent(-1)} theme={theme} /> : null}
        {tabs.slice(tabWindow.start, tabWindow.end).map((id) => <InspectorAction key={id}
          label={nameFor(id)} width={tabWindow.tabWidth} height={layout.tabsRows}
          focused={interactive && focus === `agent:${id}`} selected={id === activeId}
          onPress={() => selectAgent(id)} theme={theme} />)}
        {tabWindow.arrowWidth > 0 ? <InspectorAction label="›" width={tabWindow.arrowWidth} height={layout.tabsRows}
          focused={false} onPress={() => nextAgent(1)} theme={theme} /> : null}
      </box> : null}
      {layout.actionsRows > 0 ? <box width={layout.innerWidth} height={layout.actionsRows} flexShrink={0} flexDirection="row" overflow="hidden">
        {(actionWidth > 0 ? actionIds : [controls[focusIndex]!]).map((id) => {
          const index = actionIds.indexOf(id);
          return <InspectorAction key={id} label={actionLabels[index] ?? nameFor(id.slice(6))}
            compactLabel={actionWidth >= 10 ? actionLabels[index] : compactLabels[index] ?? nameFor(id.slice(6))}
            width={actionWidth > 0 ? actionWidth : layout.innerWidth} height={layout.actionsRows}
            focused={interactive && focus === id} selected={view === id}
            onPress={() => activate(id)} theme={theme} />;
        })}
      </box> : null}
      {layout.bodyRows > 0 && layout.textWidth > 0 ? <scrollbox key={`${activeId}:${view}`} ref={scroll}
        width={layout.innerWidth} height={layout.bodyRows} flexShrink={0} minHeight={0} minWidth={0}
        scrollX={false} verticalScrollbarOptions={sleekScrollbar(theme)}>
        <box width={layout.textWidth} flexDirection="column" flexShrink={0} minWidth={0} overflow="hidden">
          {line("name", activeId ? `${nameFor(activeId)} · ${sanitizeTuiText(activeId)}` : "No agent pane open", theme.TEXT)}
          {record ? <>
            {line("status", commsFleetStatLine({ kind: "agent", record }, display.now))}
            {record.status === "completed" && record.done === false
              ? line("completion", "Finished without a completion signal.", theme.MUTED) : null}
            {line("lineage", `Spawn lineage: ${inspectorLineage(agents, activeId, rootScanId)}`)}
            {record.task ? line("task", `Task: ${record.task}`) : null}
            {record.error ? line("error", `Error: ${record.error}`, theme.ERROR) : null}
            {record.summary ? line("summary", `Result: ${record.summary}`, theme.TEXT) : null}
            {record.note ? line("note", `Latest: ${record.note}`) : null}
          </> : activeId ? line("unknown", "Agent metadata is not available in this audit.") : null}
          {view === "transcript" ? <>
            {line("title", "TRANSCRIPT", theme.PRIMARY)}
            {entries.length === 0 ? line("empty", record?.status === "failed" ? "No transcript retained for this failed agent."
              : record?.status === "completed" ? "No transcript retained for this finished agent." : "No transcript entries yet.")
              : entries.map((entry) => <box key={entry.id} width={layout.textWidth} flexShrink={0} minWidth={0} overflow="hidden">
                {renderEntry(entry, layout.textWidth, workerDisplay, theme)}
              </box>)}
          </> : <>
            {line("title", "OBSERVED COMMUNICATION", theme.PRIMARY)}
            {line("scope", "Actual sender → recipient counts in the retained stream; spawning is separate. Broadcasts stay #all.")}
            {edges.map((edge, index) => line(`edge:${index}`, commsEdgeLabel(edge, nameFor), theme.TEXT))}
            {traffic.length === 0 ? line("empty", "No messages to or from this agent have been observed.")
              : traffic.map((message) => {
                const data = commsMessageCard(message, { now: display.now, selfId: activeId,
                  resolveName: (id) => fitTuiText(nameFor(id), Math.max(1, Math.floor((layout.textWidth - 12) / 2))) });
                if (!display.showTimestamps) { data.chips = data.chips.filter((chip) => chip !== data.age); data.age = ""; }
                return <MessageCard key={message.seq} data={data} width={layout.textWidth} theme={theme}
                  spacing={display.spacing} expanded={display.transcriptDetail === "expanded"} />;
              })}
          </>}
        </box>
      </scrollbox> : null}
      {layout.hintRows > 0 ? <Cells width={layout.innerWidth} fg={theme.MUTED}>
        {fitLegend(layout.innerWidth, "←/→ agents · 1/2 view · Tab controls · Enter select · x close · Esc main · PgUp/PgDn scroll")}
      </Cells> : null}
    </box>
  );
}
