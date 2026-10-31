import { Button } from "@/components/ui/button";
import { NewChatButton } from "@/components/new-chat-button";
import { Link } from "react-router-dom";
import { CircleAlert, MessageCircleQuestion, Search, Trash2, Settings, ShieldCheck } from "lucide-react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";
import { openAppSearch } from "@/components/command-palette";
import { cn } from "@/lib/utils";
import { LoadingDots } from "./loading-state";
import type { ConsoleWorkspace } from "./use-console-workspace";
import { orderSessionRail } from "./session-rail-order";
import { TeamAccount, useTeamAccess } from "@/components/team-access";
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

export function ConsoleSessionRail({ workspace, selectedId, onCreate, onDeleteLive, onResume, onDelete, onSelect, onOpenDockChat, showMobileFooter = true }: {
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
  showMobileFooter?: boolean;
  onOpenDockChat?: (id: string, title: string) => void;
}) {
  const team = useTeamAccess();
  const { teamClient } = useBackendApi();
  const presence = useTeamOverview(teamClient, { enabled: team.enabled && Boolean(team.user) });
  const presenceFor = (id: string) => presence.isError ? [] : presence.data?.rooms.find(room => room.kind === "conversation" && room.id === id)?.presence ?? [];
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const live = workspace.sessions.filter((session) => session.status !== "closed" && (team.enabled || (session.messageCount ?? 0) > 0 || session.status !== "ready"));
  const activeIds = new Set(workspace.sessions.filter(session => session.status !== "closed").flatMap(session => [session.id, ...("savedId" in session && typeof session.savedId === "string" ? [session.savedId] : [])]));
  const saved = workspace.saved.filter(session => (team.enabled || session.messageCount > 0) && !activeIds.has(session.id)).filter((session) => !session.archived);
  const rows = orderSessionRail(live, saved, workspace.saved);
  return <div className="session-rail flex h-full min-h-0 flex-col">
    <div className="shrink-0 space-y-0.5 p-1"><NewChatButton className="w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground" disabled={workspace.busy || readOnlyTeam} onClick={onCreate} /><Button variant="ghost" type="button" onClick={event => { const button = event.currentTarget; onSelect?.(); openAppSearch("all", button); }} className="relative flex h-8 w-full justify-start items-center rounded-[var(--radius-control)] pl-8 pr-3 text-left text-sm font-normal text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-keyshortcuts="Meta+K Control+K"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-4" />Search anything<kbd className="ml-auto rounded-[var(--radius-control)] px-1 text-[10px] text-muted-foreground/70">⌘K</kbd></Button></div>
    <div id="chat-sidebar-list" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1" aria-label="Chats">
      {rows.map((row) => {
        if (row.kind === "live") {
          const session = row.session;
          return <div key={row.key} className={cn("session-row group relative flex items-center rounded-[var(--radius-control)]", selectedId === session.id ? "bg-muted" : "hover:bg-muted/50")}>
        <Link to={`/console/${session.id}`} draggable onDragStart={event => { event.dataTransfer.setData("application/x-0-console-chat", JSON.stringify({sessionId:session.id,title:session.title || "Chat"})); event.dataTransfer.effectAllowed="copy"; }} onClick={event => { if (onOpenDockChat && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onOpenDockChat(session.id,session.title || "Chat"); } onSelect?.(); }} className="flex h-8 min-w-0 flex-1 justify-start items-center rounded-[var(--radius-control)] px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" title={session.target || undefined}><span className="min-w-0 flex-1 truncate text-left text-sm">{session.title || session.target || "Untitled chat"}</span></Link>
        <SessionActivity status={session.status} />
        <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
        <div className="session-row-actions absolute right-1 flex w-7 shrink-0 items-center pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 max-lg:pointer-events-auto max-lg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Button variant="ghost" type="button" aria-label={`Delete ${session.title || "chat"}`} title="Delete chat" disabled={workspace.busy || readOnlyTeam} onClick={() => onDeleteLive(session)} className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></Button>
        </div>
      </div>;
        }
        const session = row.session;
        return <div key={row.key} className="session-row group relative flex items-center rounded-[var(--radius-control)] hover:bg-muted/50">
        <Button variant="ghost" type="button" draggable onDragStart={event => { event.dataTransfer.setData("application/x-0-console-chat", JSON.stringify({sessionId:session.id,title:session.summary || session.target || "Past chat",saved:true})); event.dataTransfer.effectAllowed="copy"; }} className="flex h-8 min-w-0 flex-1 justify-start items-center rounded-[var(--radius-control)] px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 text-left" title={`${new Date(session.savedAt).toLocaleDateString()} · ${session.messageCount} messages`} onClick={() => onResume(session)}><span className="min-w-0 flex-1 truncate text-left text-sm">{session.summary || session.target || session.preview || "Past chat"}</span></Button>
        <TeamPresenceAvatars presence={presenceFor(session.id)} compact />
        <div className="session-row-actions absolute right-1 flex w-7 shrink-0 items-center pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 max-lg:pointer-events-auto max-lg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Button variant="ghost" type="button" aria-label={`Delete ${session.summary || session.target || "chat"}`} title="Delete chat" disabled={workspace.busy || readOnlyTeam} onClick={() => onDelete(session)} className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></Button>
        </div>
      </div>;
      })}{!rows.length && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No chats yet.</p>}
    </div>
    {showMobileFooter && <div className="space-y-2 p-3 lg:hidden"><div className="flex items-center justify-between text-sm text-muted-foreground"><Link to={selectedId ? `/settings?session=${encodeURIComponent(selectedId)}&return=${encodeURIComponent(`/console/${selectedId}`)}` : "/settings"} className="flex items-center gap-1.5 rounded-[var(--radius-control)] px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><Settings className="size-3.5" />Settings</Link><Link to="/findings" className="flex items-center gap-1.5 rounded-[var(--radius-control)] px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ShieldCheck className="size-3.5" />Findings</Link></div><TeamAccount /></div>}

  </div>;
}
