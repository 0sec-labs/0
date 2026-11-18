import { v } from "@/lib/vocabulary";
import type { SessionRailRow } from "./session-rail-order";

export function sidebarChatTitle(row: SessionRailRow): string {
  return row.kind === "live" ? row.session.title || v("Untitled {mission}") : row.session.summary || row.session.preview || v("Past {mission}");
}

type TitleSourced = { titleSource?: "default" | "auto" | "user" };

/** True while the first turn runs and the server has not settled the title yet. Old engines omit titleSource. */
export const TITLE_GRACE_MS = 15_000;
export function sessionTitlePending(session: { status: string; messageCount?: number; updatedAt?: string } & TitleSourced, now: number = Date.now()): boolean {
  if (session.titleSource !== "default") return false;
  if (session.status === "working") return true;
  // The post-turn title call runs after the turn goes idle: keep shimmering through that short window.
  const updated = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  return session.status === "ready" && (session.messageCount ?? 0) >= 2 && Number.isFinite(updated) && now - updated < TITLE_GRACE_MS;
}

export function sidebarChatTitlePending(row: SessionRailRow): boolean {
  return row.kind === "live" && sessionTitlePending(row.session);
}

export interface SidebarChatActivity {
  timestamp: number;
  messageCount: number | undefined;
}

/** Runtime handles and save timestamps change on opening; only new messages change rank. */
export function rememberSidebarActivity(rows: SessionRailRow[], activity: Map<string, SidebarChatActivity>): SessionRailRow[] {
  return rows.map(row => {
    const previous = activity.get(row.key);
    const count = row.session.messageCount;
    const observed = row.kind === "live" ? Date.parse(row.session.updatedAt) || row.timestamp : row.timestamp;
    const timestamp = previous
      ? count !== undefined && previous.messageCount !== undefined && count > previous.messageCount
        ? Math.max(previous.timestamp, observed)
        : previous.timestamp
      : Number.isFinite(row.timestamp) ? row.timestamp : 0;
    activity.set(row.key, {
      timestamp,
      // Retain the high-water mark through shortened/resumed transcript metadata.
      messageCount: count === undefined ? previous?.messageCount : previous?.messageCount === undefined ? count : Math.max(count, previous.messageCount),
    });
    return timestamp === row.timestamp ? row : { ...row, timestamp };
  });
}

/** Sort on remembered conversation activity, never a handle's last-opened timestamp. */
export function sortSidebarChats(rows: SessionRailRow[], sort: "updated" | "name", filter = ""): SessionRailRow[] {
  const needle = filter.trim().toLocaleLowerCase();
  return rows.filter(row => !needle || sidebarChatTitle(row).toLocaleLowerCase().includes(needle)).sort((a, b) => sort === "name" ? sidebarChatTitle(a).localeCompare(sidebarChatTitle(b)) || a.key.localeCompare(b.key) : b.timestamp - a.timestamp || a.key.localeCompare(b.key));
}
