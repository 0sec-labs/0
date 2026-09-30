import { agentTaskLabel } from "@0/core/dist/hub/name-generator.js";
import { sanitizeHerdText, type HerdSubagentMap, type HerdSubagentRecord, type SubagentStatus } from "../herd-layout.js";
import { toCells } from "../primitives.js";

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
      label: sanitizeHerdText(agentTaskLabel(agent.task, agent.name)),
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

export interface AgentWorkListLayout {
  readonly width: number;
  /** Actual painted height, no taller than heightLimit. */
  readonly height: number;
  readonly heightLimit: number;
  readonly itemHeight: number;
  readonly separatorHeight: number;
  readonly mainHeight: number;
  readonly visibleTabs: readonly AgentChatTab[];
  readonly hiddenCount: number;
  readonly showMore: boolean;
}

const WORK_ITEM_HEIGHT = 2;
const WORK_SEPARATOR_HEIGHT = 1;

/** Natural list height within a caller's remaining vertical budget. */
export function agentWorkListHeight(agentCount: number, heightLimit: number): number {
  const rows = toCells(heightLimit);
  if (rows === 0) return 0;
  const count = toCells(agentCount);
  const itemHeight = rows >= 3 ? WORK_ITEM_HEIGHT : 1;
  const separatorHeight = itemHeight === WORK_ITEM_HEIGHT ? WORK_SEPARATOR_HEIGHT : 0;
  const blockHeight = itemHeight + separatorHeight;
  const mainHeight = Math.min(rows, blockHeight);
  const remainingRows = Math.max(0, rows - mainHeight);
  const capacityWithoutMore = Math.floor(remainingRows / blockHeight);
  if (count <= capacityWithoutMore) return mainHeight + count * blockHeight;
  if (remainingRows === 0) return mainHeight;
  const visibleCount = Math.floor(Math.max(0, remainingRows - 1) / blockHeight);
  return mainHeight + visibleCount * blockHeight + 1;
}

/** Window the focused worker among neighbors; a same-list remainder row represents every hidden worker. */
export function computeAgentWorkListLayout(
  tabs: readonly AgentChatTab[],
  selectedAgentId: string | null,
  width: number,
  height: number,
): AgentWorkListLayout {
  const columns = toCells(width);
  const rows = toCells(height);
  const itemHeight = rows >= 3 ? WORK_ITEM_HEIGHT : 1;
  const separatorHeight = itemHeight === WORK_ITEM_HEIGHT ? WORK_SEPARATOR_HEIGHT : 0;
  const blockHeight = itemHeight + separatorHeight;
  const mainHeight = Math.min(rows, blockHeight);
  const remainingRows = Math.max(0, rows - mainHeight);
  const capacityWithoutMore = Math.floor(remainingRows / blockHeight);
  const overflowsWithoutMore = tabs.length > capacityWithoutMore;
  const showMore = overflowsWithoutMore && remainingRows > 0;
  const visibleCapacity = showMore
    ? Math.floor(Math.max(0, remainingRows - 1) / blockHeight)
    : capacityWithoutMore;
  const selectedIndex = tabs.findIndex((tab) => tab.id === selectedAgentId);
  const visibleCount = Math.min(tabs.length, visibleCapacity);
  const anchor = selectedIndex < 0 ? 0 : selectedIndex;
  const firstIndex = Math.max(0, Math.min(anchor - Math.floor(visibleCount / 2), tabs.length - visibleCount));
  const visibleTabs = tabs.slice(firstIndex, firstIndex + visibleCount);
  const hiddenCount = tabs.length - visibleTabs.length;
  const showMoreRow = showMore && hiddenCount > 0;
  const paintedHeight = mainHeight + visibleTabs.length * blockHeight + (showMoreRow ? 1 : 0);
  return {
    width: columns,
    height: paintedHeight,
    heightLimit: rows,
    itemHeight,
    separatorHeight,
    mainHeight,
    visibleTabs,
    hiddenCount,
    showMore: showMoreRow,
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
