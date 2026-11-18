import { formatRelativeAge } from "./relative-time";
import { presentStatus, sentinelHref, type Sentinel } from "@/sentinels/model";

/** Row view-models for the sidebar lists. Pure: components only lay them out. */

export type SidebarListMode = "agents" | "threads";
export type SidebarDensity = "comfortable" | "compact";
export type AgentSort = "recent" | "name";
export type AgentBadge = "running" | "needs-you" | "failed" | "paused" | "idle";

/** The stored choice wins; with none, Sentinels when there are any, else Threads. Servers without Sentinels always show Threads. */
export function resolveListMode(stored: SidebarListMode | null, agentCount: number, supported: boolean): SidebarListMode {
  if (!supported) return "threads";
  return stored ?? (agentCount > 0 ? "agents" : "threads");
}

/** Badge priority: waiting on the operator, then failed, then working, then paused, else idle. Only working, waiting and failed draw a glyph. */
export function agentBadge(sentinel: Pick<Sentinel, "status" | "attention"> & { thread?: Sentinel["thread"] }, running = sentinel.thread?.status === "working"): AgentBadge {
  const status = presentStatus(sentinel);
  if (status.needsYou || status.needsReview) return "needs-you";
  if (sentinel.thread?.status === "failed") return "failed";
  if (sentinel.status === "paused") return "paused";
  return running ? "running" : "idle";
}

export const AGENT_BADGE_LABEL: Record<AgentBadge, string> = { running: "Working", "needs-you": "Needs you", failed: "Failed", paused: "Paused", idle: "Idle" };

export interface AgentSubtitle { text: string; tone: "muted" | "accent" }

/** Line 2: what needs the operator, why it paused, else the last thing it said (the job line before it has said anything). */
export function agentSubtitle(sentinel: Pick<Sentinel, "status" | "attention" | "mission"> & { thread?: Sentinel["thread"] }): AgentSubtitle {
  const status = presentStatus(sentinel);
  if (status.needsYou || status.needsReview) return { text: sentinel.attention?.reason?.trim() || status.label, tone: "accent" };
  if (sentinel.status === "paused") return { text: "Paused. Triggers are off.", tone: "muted" };
  return { text: sentinel.thread?.lastMessage?.trim() || sentinel.mission.trim(), tone: "muted" };
}

export interface AgentRow { id: string; name: string; href: string; age: string; needsYou: boolean; badge: AgentBadge; badgeLabel: string; subtitle: AgentSubtitle }

export function agentRow(sentinel: Sentinel, now = Date.now(), running = sentinel.thread?.status === "working"): AgentRow {
  const badge = agentBadge(sentinel, running);
  const status = presentStatus(sentinel);
  return { id: sentinel.id, name: sentinel.name, href: sentinelHref(sentinel.id), age: formatRelativeAge(Date.parse(sentinel.thread?.updatedAt ?? sentinel.updatedAt), now), needsYou: status.needsYou || status.needsReview, badge, badgeLabel: AGENT_BADGE_LABEL[badge], subtitle: agentSubtitle(sentinel) };
}

/** Recent keeps the waiting-first order from the model; name is plain alphabetical. */
export function sortAgents<T extends Pick<Sentinel, "name" | "id">>(sentinels: readonly T[], sort: AgentSort): T[] {
  return sort === "name" ? [...sentinels].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : [...sentinels];
}

/** Last path segment of a folder, for the thread chip. */
export function folderName(path: string | undefined): string {
  const parts = (path ?? "").split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export const folderMonogram = (name: string): string => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "").toUpperCase();

export type ThreadSubline = { kind: "needs-you"; text: string; folder: string } | { kind: "place"; folder: string; computer: string };

/** Line 2 of a thread: the accent attention text when waiting on the operator, else its folder and computer. */
export function threadSubline(input: { attention?: string; workspacePath?: string; computer: string }): ThreadSubline {
  if (input.attention) return { kind: "needs-you", text: input.attention, folder: folderName(input.workspacePath) };
  return { kind: "place", folder: folderName(input.workspacePath), computer: input.computer };
}

export type ThreadShelf = "main" | "settled" | "automations";
export const SETTLED_AFTER_MS = 14 * 24 * 3600_000;

/** Which part of the Threads list a thread belongs to: automation runs and Sentinel activations go to Automations, quiet threads untouched for two weeks to Settled. Waiting, open and selected threads stay on the main list. */
export function threadShelf(input: { automation: boolean; waiting: boolean; selected: boolean; timestamp: number; now: number }): ThreadShelf {
  if (input.waiting || input.selected) return "main";
  if (input.automation) return "automations";
  return input.now - input.timestamp > SETTLED_AFTER_MS ? "settled" : "main";
}
