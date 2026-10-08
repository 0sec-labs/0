import { useState } from "react";
import { Link } from "react-router-dom";
import { Archive, ArchiveRestore, CircleAlert, MessageCircleQuestion, SquarePen, Search, Trash2, Settings, ShieldCheck } from "lucide-react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";
import { openAppSearch } from "@/components/command-palette";
import { cn } from "@/lib/utils";
import { LoadingDots } from "./loading-state";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { orderSessionRail } from "./session-rail-order";
import { useTeamAccess } from "@/components/team-access";
import { useBackendApi } from "@/api";
import { TeamPresenceAvatars } from "./team-collaboration";
import { useTeamOverview } from "./team-overview";

function SessionActivity({ status }: { status: DesktopConsoleSession["status"] }) {
  if (status === "ready" || status === "closed") return null;
  const label = status === "working" ? "Responding" : status === "waiting" ? "Waiting for you" : "Needs attention";
  return <span role="status" aria-label={label} title={label} className="flex size-7 shrink-0 items-center justify-center">
    {status === "working"
      ? <LoadingDots className="console-loading-dots-compact text-muted-foreground" />
      : status === "waiting"
        ? <MessageCircleQuestion aria-hidden="true" className="size-4 text-amber-400" />
        : <CircleAlert aria-hidden="true" className="size-4 text-red-400/80" />}
  </span>;
}

export function ConsoleSessionRail({ workspace, selectedId, onCreate, onArchiveLive, onArchive, onDeleteLive, onResume, onDelete, onSelect }: {
  workspace: ConsoleWorkspace;
  selectedId?: string;
  onCreate: () => void;
  onRename: (session: DesktopConsoleSession) => void;
  onArchiveLive: (session: DesktopConsoleSession) => void;
  onArchive: (saved: ConsoleSavedSession, archived: boolean) => void;
  onDeleteLive: (session: DesktopConsoleSession) => void;
  onResume: (saved: ConsoleSavedSession) => void;
  onDelete: (saved: ConsoleSavedSession) => void;
  onExport: (id: string, saved: boolean) => void;
  onSelect?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const team = useTeamAccess();
  const { teamClient } = useBackendApi();
  const presence = useTeamOverview(teamClient, { enabled: team.enabled && Boolean(team.user) });
  const presenceFor = (id: string) => presence.isError ? [] : presence.data?.rooms.find(room => room.kind === "conversation" && room.id === id)?.presence ?? [];
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const live = workspace.sessions.filter((session) => !showArchived && session.status !== "closed" && (team.enabled || (session.messageCount ?? 0) > 0 || session.status !== "ready"));
  const activeIds = new Set(workspace.sessions.filter(session => session.status !== "closed").flatMap(session => [session.id, ...("savedId" in session && typeof session.savedId === "string" ? [session.savedId] : [])]));
  const saved = workspace.saved.filter(session => (team.enabled || session.messageCount > 0) && !activeIds.has(session.id)).filter((session) => Boolean(session.archived) === showArchived);
  const rows = orderSessionRail(live, saved, workspace.saved);
  return <div className="session-rail flex h-full min-h-0 flex-col">
    <div className="shrink-0 space-y-2 p-2"><button type="button" className="relative h-9 w-full rounded-lg pl-8 pr-3 text-left text-sm font-normal text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50" disabled={workspace.busy || readOnlyTeam} onClick={onCreate}><SquarePen aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5" />New chat</button><button type="button" onClick={event => { const button = event.currentTarget; onSelect?.(); openAppSearch("chats", button); }} className="relative h-9 w-full rounded-lg pl-8 pr-3 text-left text-sm font-normal text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-keyshortcuts="Meta+K Control+K"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5" />Search chats</button></div>
    <div id="chat-sidebar-list" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label={showArchived ? "Archived chats" : "Chats"}>
      {rows.map((row) => {
        if (row.kind === "live") {
          const session = row.session;
          return <div key={row.key} className={cn("session-row group relative flex items-center rounded-xl", selectedId === session.id ? "bg-muted" : "hover:bg-muted/50")}>
        <Link to={`/console/${session.id}`} onClick={onSelect} className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" title={session.target || undefined}><div className="truncate text-sm">{session.title || session.target || "Untitled chat"}</div></Link>
        <SessionActivity status={session.status} />
        <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
        <div className="session-row-actions mr-1 flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 motion-reduce:transition-none group-hover:w-14 group-hover:opacity-100 group-has-[:focus-visible]:w-14 group-has-[:focus-visible]:opacity-100 max-lg:w-14 max-lg:opacity-100 [@media(hover:none)]:w-14 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={`Archive ${session.title || "chat"}`} title="Archive chat" disabled={workspace.busy || readOnlyTeam || !session.messageCount} onClick={() => onArchiveLive(session)} className="flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Archive aria-hidden="true" className="size-4" /></button>
          <button type="button" aria-label={`Delete ${session.title || "chat"}`} title="Delete chat" disabled={workspace.busy || readOnlyTeam} onClick={() => onDeleteLive(session)} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></button>
        </div>
      </div>;
        }
        const session = row.session;
        return <div key={row.key} className="session-row group flex items-center rounded-xl hover:bg-muted/50">
        <button type="button" className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 text-left" title={`${new Date(session.savedAt).toLocaleDateString()} · ${session.messageCount} messages`} onClick={() => onResume(session)}><div className="truncate text-sm">{session.summary || session.target || session.preview || "Past chat"}</div></button>
        <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
        <div className="session-row-actions mr-1 flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-[width,opacity] duration-150 motion-reduce:transition-none group-hover:w-14 group-hover:opacity-100 group-has-[:focus-visible]:w-14 group-has-[:focus-visible]:opacity-100 max-lg:w-14 max-lg:opacity-100 [@media(hover:none)]:w-14 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={`${showArchived ? "Restore" : "Archive"} ${session.summary || session.target || "chat"}`} title={showArchived ? "Restore chat" : "Archive chat"} disabled={workspace.busy || readOnlyTeam} onClick={() => onArchive(session, !showArchived)} className="flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">{showArchived ? <ArchiveRestore aria-hidden="true" className="size-4" /> : <Archive aria-hidden="true" className="size-4" />}</button>
          <button type="button" aria-label={`Delete ${session.summary || session.target || "chat"}`} title="Delete chat" disabled={workspace.busy || readOnlyTeam} onClick={() => onDelete(session)} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></button>
        </div>
      </div>;
      })}{!rows.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{showArchived ? "No archived chats." : "No chats yet."}</p>}
    </div>
    <div className="space-y-2 p-3 lg:hidden"><div className="flex items-center justify-between text-sm text-muted-foreground"><Link to={selectedId ? `/settings?session=${encodeURIComponent(selectedId)}&return=${encodeURIComponent(`/console/${selectedId}`)}` : "/settings"} className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><Settings className="size-3.5" />Settings</Link><Link to="/findings" className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ShieldCheck className="size-3.5" />Findings</Link></div></div>
    <div className="shrink-0 p-2 pt-1">
      <button type="button" aria-controls="chat-sidebar-list" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-normal transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", showArchived ? "bg-muted text-foreground" : "text-muted-foreground")}><Archive aria-hidden="true" className="size-4 shrink-0" />{showArchived ? "Back to chats" : "Archived chats"}</button>
    </div>
  </div>;
}
