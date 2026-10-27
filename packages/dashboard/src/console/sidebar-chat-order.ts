import type { SessionRailRow } from "./session-rail-order";

export function sidebarChatTitle(row: SessionRailRow): string {
  return row.kind === "live" ? row.session.title || row.session.target || "Untitled chat" : row.session.summary || row.session.target || row.session.preview || "Past chat";
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
