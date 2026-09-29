import type { HerdSubagentMap } from "../herd-layout.js";
import { filterMessagesForAgent, type CommsMessage } from "../agents-comms-layout.js";
import { toCells } from "../primitives.js";
import { sanitizeTuiText } from "../text.js";
import { BROADCAST_ID, SELF_ID } from "./message-card-layout.js";

export function computeAgentInspectorLayout(width: number, height: number) {
  const columns = toCells(width);
  const rows = toCells(height);
  const paddingX = columns >= 16 ? 1 : 0;
  const innerWidth = Math.max(0, columns - paddingX * 2);
  const tabsRows = rows >= 10 && innerWidth >= 12 ? 3 : rows >= 3 ? 1 : 0;
  const actionsRows = rows >= 12 && innerWidth >= 40 ? 3 : rows >= 2 ? 1 : 0;
  const hintRows = rows - tabsRows - actionsRows >= 4 ? 1 : 0;
  return {
    width: columns,
    height: rows,
    paddingX,
    innerWidth,
    tabsRows,
    actionsRows,
    hintRows,
    bodyRows: rows - tabsRows - actionsRows - hintRows,
    textWidth: Math.max(0, innerWidth - 1),
  };
}

/** A bounded, selected-centred tab window; arrows page to every open pane. */
export function inspectorTabWindow(count: number, selected: number, width: number) {
  const total = toCells(count);
  const columns = toCells(width);
  const selectedIndex = Math.max(0, Math.min(total - 1, toCells(selected)));
  const arrowWidth = total > Math.max(1, Math.floor(columns / 12)) && columns >= 8 ? 3 : 0;
  const available = Math.max(0, columns - arrowWidth * 2);
  const visible = Math.min(total, Math.max(1, Math.floor(available / 12)));
  const start = Math.max(0, Math.min(total - visible, selectedIndex - Math.floor(visible / 2)));
  return { start, end: start + visible, arrowWidth, tabWidth: visible > 0 ? Math.floor(available / visible) : 0 };
}

export function inspectorAgentName(agents: Readonly<HerdSubagentMap>, id: string, rootScanId: string): string {
  if (id === BROADCAST_ID) return "#all";
  if (id === SELF_ID || (rootScanId && id === rootScanId)) return SELF_ID;
  const record = agents[id] ?? Object.values(agents).find((agent) => agent.name === id);
  return sanitizeTuiText(record?.name || record?.agentId || id);
}

/** Parent links describe spawning, never inferred message delivery. */
export function inspectorLineage(agents: Readonly<HerdSubagentMap>, agentId: string, rootScanId: string): string {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = agentId;
  let cycle = false;
  while (current) {
    if (visited.has(current)) { cycle = true; break; }
    visited.add(current);
    chain.push(inspectorAgentName(agents, current, rootScanId));
    if (current === rootScanId || current === SELF_ID) break;
    const record = agents[current];
    if (!record) break;
    current = record.parentScanId;
  }
  if (cycle) chain.push("[parent cycle]");
  return chain.reverse().join(" → ");
}

/** Endpoints may be roster IDs or actual peer names; broadcasts stay #all. */
export function inspectorMessages(agents: Readonly<HerdSubagentMap>, messages: readonly CommsMessage[], agentId: string): CommsMessage[] {
  if (!agentId) return [];
  const idsByName = new Map<string, string>();
  for (const record of Object.values(agents)) {
    if (record.name && record.name !== BROADCAST_ID && record.name !== SELF_ID) idsByName.set(record.name, record.agentId);
  }
  const normalized = messages.map((message) => {
    const from = agents[message.from] ? message.from : idsByName.get(message.from) ?? message.from;
    const to = message.to === BROADCAST_ID || agents[message.to] ? message.to : idsByName.get(message.to) ?? message.to;
    return from === message.from && to === message.to ? message : { ...message, from, to };
  });
  return filterMessagesForAgent(normalized, agentId);
}
