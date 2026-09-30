import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, MoreHorizontal, Pencil, Plus, Search, Trash2, X, Settings, ShieldCheck } from "lucide-react";
import type { ConsoleSavedSession, DesktopConsoleSession } from "@0/shared";
import { Button } from "@/components/ui/button";
import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LoadingDots } from "./loading-state";
import type { ConsoleWorkspace } from "./use-console-workspace";

function SessionActivity({ status }: { status: DesktopConsoleSession["status"] }) {
  if (status === "ready" || status === "closed") return null;
  const label = status === "working" ? "Responding" : status === "waiting" ? "Waiting for you" : "Needs attention";
  return <span role="status" aria-label={label} title={label} className="mr-1 flex size-5 shrink-0 items-center justify-center">
    {status === "working"
      ? <LoadingDots className="console-loading-dots-compact text-muted-foreground" />
      : <span aria-hidden="true" className={cn("size-1.5 rounded-full", status === "waiting" ? "bg-amber-400" : "bg-red-400/80")} />}
  </span>;
}

export function ConsoleSessionRail({ workspace, selectedId, onCreate, onRename, onClose, onDeleteLive, onResume, onDelete, onExport, onSelect }: {
  workspace: ConsoleWorkspace;
  selectedId?: string;
  onCreate: () => void;
  onRename: (session: DesktopConsoleSession) => void;
  onClose: (session: DesktopConsoleSession) => void;
  onDeleteLive: (session: DesktopConsoleSession) => void;
  onResume: (saved: ConsoleSavedSession) => void;
  onDelete: (saved: ConsoleSavedSession) => void;
  onExport: (id: string, saved: boolean) => void;
  onSelect?: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const live = workspace.sessions.filter((session) => session.status !== "closed" && `${session.title ?? ""} ${session.target} ${session.role} ${session.runtime?.model ?? ""} ${session.status}`.toLowerCase().includes(needle));
  const activeIds = new Set(workspace.sessions.filter(session => session.status !== "closed").flatMap(session => [session.id, ...("savedId" in session && typeof session.savedId === "string" ? [session.savedId] : [])]));
  const saved = workspace.saved.filter(session => session.messageCount > 0 && !activeIds.has(session.id)).filter((session) => `${session.summary ?? ""} ${session.preview} ${session.target ?? ""} ${session.model ?? ""}`.toLowerCase().includes(needle));
  return <div className="session-rail flex h-full min-h-0 flex-col">
    <div className="space-y-3  p-3"><KumoButton variant="primary" size="base" className="w-full justify-start text-sm" disabled={workspace.busy} onClick={onCreate}><Plus className="size-4" />New conversation</KumoButton><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-8 text-sm" placeholder="Search conversations" aria-label="Search conversations" /></div></div>
    <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Conversations">
      {live.map((session) => <div key={session.id} className={cn("session-row group relative flex items-center rounded-xl", selectedId === session.id ? "bg-muted" : "hover:bg-muted/50")}>
        <Link to={`/console/${session.id}`} onClick={onSelect} className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" title={session.target || undefined}><div className="truncate text-sm">{session.title || session.target || "Untitled conversation"}</div></Link>
        <SessionActivity status={session.status} />
        <DropdownMenu><DropdownMenu.Trigger aria-label={`Actions for ${session.title || "conversation"}`} title="Conversation actions" className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 opacity-0 hover:bg-background/60 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[popup-open]:opacity-100 max-lg:opacity-100"><button type="button"><MoreHorizontal className="size-4" /></button></DropdownMenu.Trigger><DropdownMenu.Content>
          <DropdownMenu.Item icon={<Pencil className="size-4" />} onClick={() => onRename(session)}>Rename</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Download className="size-4" />} onClick={() => onExport(session.id, false)}>Export</DropdownMenu.Item>
          <DropdownMenu.Item icon={<X className="size-4" />} onClick={() => onClose(session)}>Close</DropdownMenu.Item>
          <DropdownMenu.Item variant="danger" icon={<Trash2 className="size-4" />} onClick={() => onDeleteLive(session)}>Delete</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu>
      </div>)}{saved.map((session) => <div key={session.id} className="session-row group flex items-center rounded-xl hover:bg-muted/50">
        <button type="button" className="min-w-0 flex-1 rounded-xl px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 text-left" title={`${new Date(session.savedAt).toLocaleDateString()} · ${session.messageCount} messages`} onClick={() => onResume(session)}><div className="truncate text-sm">{session.summary || session.target || session.preview || "Past conversation"}</div></button>
        <DropdownMenu><DropdownMenu.Trigger aria-label={`Actions for ${session.summary || session.target || "conversation"}`} title="Conversation actions" className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 opacity-0 hover:bg-background/60 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[popup-open]:opacity-100 max-lg:opacity-100"><button type="button"><MoreHorizontal className="size-4" /></button></DropdownMenu.Trigger><DropdownMenu.Content>
          <DropdownMenu.Item onClick={() => onResume(session)}>Resume</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Download className="size-4" />} onClick={() => onExport(session.id, true)}>Export</DropdownMenu.Item>
          <DropdownMenu.Item variant="danger" icon={<Trash2 className="size-4" />} onClick={() => onDelete(session)}>Delete</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu>
      </div> )}{!live.length && !saved.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{needle ? "No matching conversations." : "No conversations yet."}</p>}
    </div>
    <div className="space-y-2 p-3"><div className="flex items-center justify-between text-sm text-muted-foreground"><Link to="/settings" className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><Settings className="size-3.5" />Settings</Link><Link to="/findings" className="flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><ShieldCheck className="size-3.5" />Findings</Link></div></div>
  </div>;
}
