import { agentTaskLabel } from "@0/core/dist/hub/name-generator.js";
import { sanitizeHerdText, type HerdSubagentMap, type HerdSubagentRecord, type SubagentStatus } from "../herd-layout.js";
import { toCells } from "../primitives.js";
import stringWidth from "string-width";
import { ELAPSED_VISIBLE_AFTER_MS, formatElapsed } from "../animation.js";

export interface AgentChatTab {
  readonly id: string;
  readonly label: string;
  readonly status: SubagentStatus;
  readonly activity?: string;
  readonly startedAt?: number;
}

/** Active workers are the Main ⇄ worker transcript cycling set; terminal rows remain in the full work list. */
export function activeAgentChatTabs(agents: Readonly<HerdSubagentMap>): AgentChatTab[] {
  const tabs: AgentChatTab[] = [];
  for (const agent of Object.values(agents)) {
    if (agent.status !== "queued" && agent.status !== "running") continue;
    tabs.push({
      id: agent.agentId,
      label: sanitizeHerdText(agentTaskLabel(agent.task, undefined, Infinity)),
      status: agent.status,
    });
  }
  return tabs;
}

/** Prefer recorded progress notes over tool mirrors when describing a running worker. */
function latestProgressActivity(agent: HerdSubagentRecord): string {
  let note = "";
  let tool = "";
  for (let index = agent.activity.length - 1; index >= 0 && (!note || !tool); index -= 1) {
    const entry = agent.activity[index]!;
    if (entry.kind !== "progress") continue;
    note ||= entry.note ?? "";
    tool ||= entry.tool ?? "";
  }
  const currentNote = sanitizeHerdText(note || agent.note || "");
  if (currentNote) return currentNote;
  const currentTool = sanitizeHerdText(tool || agent.tool || "");
  return currentTool ? `using ${currentTool}` : "";
}

/** Every retained worker is reachable from the transcript list, including terminal work. */
export function agentChatWorkItems(agents: Readonly<HerdSubagentMap>): AgentChatTab[] {
  return Object.values(agents).map((agent) => {
    const label = sanitizeHerdText(agentTaskLabel(agent.task, undefined, Infinity));
    let activity: string;
    switch (agent.status) {
      case "queued":
        activity = "queued · waiting to start";
        break;
      case "running": {
        const detail = latestProgressActivity(agent);
        activity = `running${detail ? ` · ${detail}` : ""}`;
        break;
      }
      case "completed": {
        const result = agent.done === false ? "completed · incomplete" : "completed";
        const summary = sanitizeHerdText(agent.summary ?? "");
        const reason = agent.completionReason === "done" ? "" : sanitizeHerdText(agent.completionReason ?? "");
        const completion = summary || reason;
        activity = `${result}${completion ? ` · ${completion}` : ""}`;
        break;
      }
      case "failed":
        activity = `failed${agent.error ? ` · ${sanitizeHerdText(agent.error)}` : ""}`;
        break;
      case "parked":
        activity = "parked";
        break;
    }
    return {
      id: agent.agentId,
      label: label || "Worker",
      status: agent.status,
      activity,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
    };
  });
}

export interface AgentWorkRowLayout {
  readonly titleLines: readonly string[];
  readonly activityLines: readonly string[];
  readonly titleWidth: number;
  readonly activityWidth: number;
  readonly markerWidth: number;
  readonly glyphWidth: number;
  readonly timerWidth: number;
  readonly elapsed?: string;
  readonly height: number;
}

export interface AgentWorkListLayout {
  readonly width: number;
  /** Actual painted height, no taller than heightLimit. */
  readonly height: number;
  readonly heightLimit: number;
  readonly separatorHeight: number;
  readonly mainHeight: number;
  readonly mainRow: AgentWorkRowLayout;
  readonly visibleRows: readonly { tab: AgentChatTab; row: AgentWorkRowLayout }[];
  readonly visibleTabs: readonly AgentChatTab[];
  readonly hiddenCount: number;
  readonly showMore: boolean;
}

const workTextSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The sidebar's bounded word-wrap pattern, measured in terminal cells rather than JS characters. */
function wrapWorkText(value: string, width: number, maxLines: number): string[] {
  if (width <= 0) return [""];
  let rest = sanitizeHerdText(value);
  const lines: string[] = [];
  while (rest && lines.length < maxLines) {
    if (stringWidth(rest) <= width) {
      lines.push(rest);
      break;
    }
    const lastLine = lines.length + 1 === maxLines;
    const limit = lastLine ? width - 1 : width;
    let cells = 0;
    let end = 0;
    let breakAt = 0;
    for (const { segment, index } of workTextSegments.segment(rest)) {
      const segmentWidth = stringWidth(segment);
      if (cells + segmentWidth > limit) break;
      cells += segmentWidth;
      end = index + segment.length;
      if (segment === " ") breakAt = index;
    }
    if (lastLine || end === 0) {
      lines.push(`${rest.slice(0, end).trimEnd()}…`);
      break;
    }
    const boundary = breakAt > 0 ? breakAt : end;
    lines.push(rest.slice(0, boundary).trimEnd());
    rest = rest.slice(boundary).trimStart();
  }
  return lines.length > 0 ? lines : [""];
}

/** Task text and live activity are independently wrapped, never merged into a synthetic summary. */
function workRowLayout(
  title: string,
  activity: string,
  width: number,
  titleLimit: number,
  activityLimit: number,
  tab?: AgentChatTab,
  now = Date.now(),
): AgentWorkRowLayout {
  const markerWidth = width >= 3 ? 2 : 0;
  const glyphWidth = Math.min(3, width);
  const elapsedMs = tab?.status === "running" && tab.startedAt !== undefined ? now - tab.startedAt : 0;
  const elapsed = elapsedMs >= ELAPSED_VISIBLE_AFTER_MS ? formatElapsed(elapsedMs) : undefined;
  const elapsedWidth = elapsed ? stringWidth(elapsed) + 1 : 0;
  // Never let a timer squeeze the activity to nothing on a compact terminal.
  const timerWidth = width - glyphWidth - elapsedWidth >= 8 ? elapsedWidth : 0;
  const titleWidth = Math.max(0, width - markerWidth
    - (activityLimit === 0 && tab ? glyphWidth + timerWidth : 0));
  const activityWidth = Math.max(0, width - glyphWidth - timerWidth);
  const titleLines = titleLimit > 0 ? wrapWorkText(title, titleWidth, titleLimit) : [];
  const activityLines = activityLimit > 0 && activity ? wrapWorkText(activity, activityWidth, activityLimit) : [];
  return {
    titleLines, activityLines, titleWidth, activityWidth, markerWidth, glyphWidth, timerWidth,
    ...(timerWidth > 0 ? { elapsed } : {}),
    height: titleLines.length + activityLines.length,
  };
}

function displayWorkActivity(tab: AgentChatTab): string {
  const activity = tab.activity ?? tab.status;
  const runningPrefix = "running · ";
  return tab.status === "running" && activity.startsWith(runningPrefix)
    ? activity.slice(runningPrefix.length)
    : activity;
}

/** Reserve exactly the same content-aware geometry that the component paints. */
export function agentWorkListHeight(
  tabs: readonly AgentChatTab[],
  selectedAgentId: string | null,
  width: number,
  heightLimit: number,
  mainTask?: string,
  mainActivity?: string,
): number {
  return computeAgentWorkListLayout(tabs, selectedAgentId, width, heightLimit, mainTask, mainActivity).height;
}

/** Keep the focused worker in a bounded, variable-height window with a reachable remainder. */
export function computeAgentWorkListLayout(
  tabs: readonly AgentChatTab[],
  selectedAgentId: string | null,
  width: number,
  height: number,
  mainTask?: string,
  mainActivity?: string,
): AgentWorkListLayout {
  const columns = toCells(width);
  const rows = columns > 0 ? toCells(height) : 0;
  const selectedIndex = tabs.findIndex((tab) => tab.id === selectedAgentId);
  const anchor = Math.max(0, selectedIndex);
  const title = mainTask ? `Main · ${sanitizeHerdText(mainTask)}` : "Main";
  const activity = sanitizeHerdText(mainActivity ?? "");
  const now = Date.now();
  // Only vertical pressure reduces detail. A long assignment can occupy at
  // most three task lines and two activity lines, not the whole terminal.
  const detailLevels = [[3, 2, 1], [3, 1, 0], [2, 1, 0], [1, 1, 0], [1, 0, 0]] as const;
  let separatorHeight = 0;
  let mainRow = workRowLayout(title, activity, columns, 0, 0);
  let workerRows: AgentWorkRowLayout[] = [];
  for (const [titleLimit, activityLimit, separator] of detailLevels) {
    mainRow = workRowLayout(title, activity, columns, titleLimit, activityLimit);
    workerRows = tabs.map((tab) => workRowLayout(tab.label, displayWorkActivity(tab),
      columns, titleLimit, activityLimit, tab, now));
    separatorHeight = separator;
    const required = mainRow.height + separator
      + (workerRows[anchor]?.height ?? 0) + (tabs.length > 0 ? separator : 0)
      + (tabs.length > 1 ? 1 : 0);
    if (required <= rows) break;
  }
  // At one or two rows there physically is not room for Main, a worker AND
  // a remainder. Preserve the focused worker; keyboard navigation still works.
  const mainHeight = rows === 0 || (rows === 1 && selectedIndex >= 0)
    ? 0 : Math.min(rows, mainRow.height + separatorHeight);
  const remaining = Math.max(0, rows - mainHeight);
  const totalWorkers = workerRows.reduce((sum, row) => sum + row.height + separatorHeight, 0);
  const allFit = totalWorkers <= remaining;
  const reserveMore = !allFit && remaining > 0 && (remaining > 1 || selectedIndex < 0);
  const budget = remaining - (reserveMore ? 1 : 0);
  let first = anchor;
  let last = anchor;
  let used = 0;
  if (workerRows[anchor] && workerRows[anchor]!.height + separatorHeight <= budget) {
    used = workerRows[anchor]!.height + separatorHeight;
    last += 1;
    while (first > 0 || last < tabs.length) {
      const left = first > 0 ? workerRows[first - 1]!.height + separatorHeight : Infinity;
      const right = last < tabs.length ? workerRows[last]!.height + separatorHeight : Infinity;
      const preferLeft = anchor - first <= last - anchor - 1;
      if (preferLeft && used + left <= budget) { first -= 1; used += left; }
      else if (used + right <= budget) { last += 1; used += right; }
      else if (used + left <= budget) { first -= 1; used += left; }
      else break;
    }
  }
  const visibleTabs = tabs.slice(first, last);
  const visibleRows = visibleTabs.map((tab, index) => ({ tab, row: workerRows[first + index]! }));
  const hiddenCount = tabs.length - visibleTabs.length;
  const showMore = reserveMore && hiddenCount > 0;
  return {
    width: columns,
    height: mainHeight + used + (showMore ? 1 : 0),
    heightLimit: rows,
    separatorHeight,
    mainHeight,
    mainRow,
    visibleRows,
    visibleTabs,
    hiddenCount,
    showMore,
  };
}

/** Select the next item outside the current window; repeated selection walks every retained worker. */
export function nextHiddenAgentChatWorkItemId(
  tabs: readonly AgentChatTab[],
  visibleTabs: readonly AgentChatTab[],
): string | null {
  if (tabs.length <= visibleTabs.length) return null;
  if (visibleTabs.length === 0) return tabs[0]?.id ?? null;
  const lastVisibleIndex = tabs.findIndex((tab) => tab.id === visibleTabs[visibleTabs.length - 1]!.id);
  if (lastVisibleIndex >= 0 && lastVisibleIndex + 1 < tabs.length) return tabs[lastVisibleIndex + 1]!.id;
  const firstVisibleId = visibleTabs[0]!.id;
  return tabs[0]?.id === firstVisibleId ? null : tabs[0]?.id ?? null;
}


export type AgentChatCycleShortcut = "previous" | "next" | "main";

/** No plain arrows, printable text, Enter, Tab or Escape are claimed from the composer. */
export function agentChatSwitcherShortcut(key: {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
}): AgentChatCycleShortcut | null {
  if (!key.ctrl || key.meta || key.option) return null;
  if (!key.shift && key.name === "pageup") return "previous";
  if (!key.shift && key.name === "pagedown") return "next";
  if (key.shift && key.name === "home") return "main";
  return null;
}

export function adjacentAgentChatTab(
  tabs: readonly AgentChatTab[],
  selectedAgentId: string | null,
  delta: -1 | 1,
): string | null {
  const current = tabs.findIndex((tab) => tab.id === selectedAgentId) + 1;
  const next = (current + delta + tabs.length + 1) % (tabs.length + 1);
  return next === 0 ? null : tabs[next - 1]!.id;
}
