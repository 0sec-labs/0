import { useState } from "react";
import { Link } from "react-router-dom";
import { Archive, ArchiveRestore, CircleAlert, MessageCircleQuestion, Plus, Search, Trash2, Settings, ShieldCheck } from "lucide-react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";
import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LoadingDots } from "./loading-state";
import type { ConsoleWorkspace } from "./use-console-workspace";

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
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const needle = query.trim().toLowerCase();
  const live = workspace.sessions.filter((session) => !showArchived && session.status !== "closed" && `${session.title ?? ""} ${session.target} ${session.role} ${session.runtime?.model ?? ""} ${session.status}`.toLowerCase().includes(needle));
  const activeIds = new Set(workspace.sessions.filter(session => session.status !== "closed").flatMap(session => [session.id, ...("savedId" in session && typeof session.savedId === "string" ? [session.savedId] : [])]));
  const saved = workspace.saved.filter(session => session.messageCount > 0 && !activeIds.has(session.id)).filter((session) => Boolean(session.archived) === showArchived).filter((session) => `${session.summary ?? ""} ${session.preview} ${session.target ?? ""} ${session.model ?? ""}`.toLowerCase().includes(needle));
  return <div className="session-rail flex h-full min-h-0 flex-col">
    <div className="space-y-3  p-3"><KumoButton variant="primary" size="base" className="w-full justify-start text-sm" disabled={workspace.busy} onClick={onCreate}><Plus className="size-4" />New chat</KumoButton><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-8 text-sm" placeholder="Search chats" aria-label="Search chats" /></div></div>
    <button type="button" onClick={() => setShowArchived(value => !value)} className="mx-3 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><Archive className="size-3.5" />{showArchived ? "Back to chats" : "Archived chats"}</button>
    <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label={showArchived ? "Archived chats" : "Chats"}>
      {live.map((session) => <div key={session.id} className={cn("session-row group relative flex items-center rounded-xl", selectedId === session.id ? "bg-muted" : "hover:bg-muted/50")}>
        <Link to={`/console/${session.id}`} onClick={onSelect} className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" title={session.target || undefined}><div className="truncate text-sm">{session.title || session.target || "Untitled chat"}</div></Link>
        <SessionActivity status={session.status} />
        <div className="session-row-actions mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-lg:opacity-100 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={`Archive ${session.title || "chat"}`} title="Archive chat" disabled={workspace.busy || !session.messageCount} onClick={() => onArchiveLive(session)} className="flex size-7 items-center justify-center rounded-lg hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Archive aria-hidden="true" className="size-4" /></button>
          <button type="button" aria-label={`Delete ${session.title || "chat"}`} title="Delete chat" disabled={workspace.busy} onClick={() => onDeleteLive(session)} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></button>
        </div>
      </div>)}{saved.map((session) => <div key={session.id} className="session-row group flex items-center rounded-xl hover:bg-muted/50">
        <button type="button" className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 text-left" title={`${new Date(session.savedAt).toLocaleDateString()} · ${session.messageCount} messages`} onClick={() => onResume(session)}><div className="truncate text-sm">{session.summary || session.target || session.preview || "Past chat"}</div></button>
        <div className="session-row-actions mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-lg:opacity-100 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={`${showArchived ? "Restore" : "Archive"} ${session.summary || session.target || "chat"}`} title={showArchived ? "Restore chat" : "Archive chat"} disabled={workspace.busy} onClick={() => onArchive(session, !showArchived)} className="flex size-7 items-center justify-center rounded-lg hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">{showArchived ? <ArchiveRestore aria-hidden="true" className="size-4" /> : <Archive aria-hidden="true" className="size-4" />}</button>
          <button type="button" aria-label={`Delete ${session.summary || session.target || "chat"}`} title="Delete chat" disabled={workspace.busy} onClick={() => onDelete(session)} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></button>
        </div>
      </div> )}{!live.length && !saved.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{needle ? "No matching chats." : showArchived ? "No archived chats." : "No chats yet."}</p>}
    </div>
    <div className="space-y-2 p-3 lg:hidden"><div className="flex items-center justify-between text-sm text-muted-foreground"><Link to={selectedId ? `/settings?session=${encodeURIComponent(selectedId)}&return=${encodeURIComponent(`/console/${selectedId}`)}` : "/settings"} className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><Settings className="size-3.5" />Settings</Link><Link to="/findings" className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ShieldCheck className="size-3.5" />Findings</Link></div></div>
  </div>;
}
