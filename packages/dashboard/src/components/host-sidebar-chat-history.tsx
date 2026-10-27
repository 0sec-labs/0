import { ChatHistorySkeleton } from "@/console/loading-state";
import { SelectionHighlight } from "@0/ui/components/selection-highlight";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Monitor, Server, SquarePen, Trash2, Ellipsis, Columns2 } from "lucide-react";
import { BackendDescriptorSchema, parseBackendHandshake, type BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import { createBackendApi, localControlFetch, useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { useTeamAccess } from "./team-access";
import { Tooltip } from "./ui/tooltip";
import { Button } from "./ui/button";
import { DropdownMenu } from "./ui/dropdown-menu";
import { Disclosure } from "./ui/disclosure";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { rememberSidebarActivity, sortSidebarChats, type SidebarChatActivity } from "@/console/sidebar-chat-order";
import { orderSessionRail } from "@/console/session-rail-order";
import { CHAT_DRAG_MIME } from "@/console/dock-workspace";
import { createChatOnExecutionHost } from "@/console/model-source";
import { backendRouteHref, chatHostScopeKey } from "@/console/chat-host";
import { consoleSnapshotKey } from "@/console/use-console-workspace";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";

export interface PendingChatSelection { id: string; title: string; backendId: string }

interface HostHistoryProps {
  selectedId?: string;
  selectedBackendId?: string;
  onSelect?: () => void;
  onPendingChatChange?: (selection: PendingChatSelection | null) => void;
  isPendingChatCurrent?: (selection: PendingChatSelection) => boolean;
  onOpenDockChat?: (id: string, title: string, backendId: string) => void;
  onCreate?: (backendId: string) => void;
  sort?: "updated" | "name";
  filter?: string;
}

/** Lists only registered hosts; every query and action retains its host identity. */
export function HostSidebarChatHistory(props: HostHistoryProps) {
  const navigate = useNavigate();
  const selection = useBackendSelection();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const [sort, setSort] = usePersistentState<"updated" | "name">("host-sidebar-sort", "updated");
  const [creatingHost, setCreatingHost] = useState<string | null>(null);
  const [creationError, setCreationError] = useState("");
  const navigationVersion = useRef(0);
  const hostId = props.selectedBackendId ?? selection?.backendId ?? "local";
  const create = (id: string) => {
    const version = ++navigationVersion.current;
    if (props.onCreate) { props.onSelect?.(); props.onCreate(id); }
    else {
      if (creatingHost) return;
      setCreatingHost(id); setCreationError("");
      void createChatOnExecutionHost(id, { title: "New chat" }).then(session => {
        if (version !== navigationVersion.current) return;
        props.onSelect?.();
        navigate(backendRouteHref(id, `/console/${encodeURIComponent(session.id)}`));
      }).catch(error => setCreationError(error instanceof Error ? error.message : "Couldn’t create this chat. Try again.")).finally(() => setCreatingHost(null));
    }
  };
  return <div className="session-rail flex h-full min-h-0 flex-col">
    <div className="shrink-0 space-y-0.5 p-1">
      <div className="group/chat-actions flex min-w-0 items-center">
        <Button variant="ghost" size="sm" disabled={readOnly || Boolean(creatingHost)} className="min-w-0 flex-1 justify-start px-1.5 font-normal text-muted-foreground" onClick={() => create(hostId)}><SquarePen />New chat</Button>
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/chat-actions:opacity-100 group-focus-within/chat-actions:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
          <Tooltip content="Click to open. Drag a chat to an edge to view side by side." side="right"><span tabIndex={0} role="img" aria-label="Drag chats to an edge for side by side" className="inline-flex size-6 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"><Columns2 aria-hidden="true" className="size-3.5" /></span></Tooltip>
          <DropdownMenu><DropdownMenu.Trigger><Button variant="ghost" size="icon-xs" aria-label="Chat list options"><Ellipsis className="size-3.5" /></Button></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Group>
            <DropdownMenu.Label>Sort chats</DropdownMenu.Label>
            <DropdownMenu.Item selected={sort === "updated"} onClick={() => setSort("updated")}>Last updated</DropdownMenu.Item>
            <DropdownMenu.Item selected={sort === "name"} onClick={() => setSort("name")}>Name</DropdownMenu.Item>
          </DropdownMenu.Group></DropdownMenu.Content></DropdownMenu>
        </div>
      </div>
    </div>
    {creationError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{creationError}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-1" aria-label="Chats by host">
      {(selection?.backends ?? []).map(host => <HostChatGroup key={host.id} host={host} navigationVersion={navigationVersion} {...props} selectedBackendId={hostId} onCreate={create} sort={sort} filter="" />)}
    </div>
  </div>;
}

function HostChatGroup({ host, navigationVersion, onSelect, onPendingChatChange, isPendingChatCurrent, onOpenDockChat, onCreate, selectedId, selectedBackendId, sort = "updated", filter = "" }: HostHistoryProps & { host: BackendDescriptor; navigationVersion: RefObject<number> }) {
  const navigate = useNavigate();
  const currentApi = useBackendApi();
  const cache = useQueryClient();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const account = chatHostScopeKey(host.id, team.user?.workspaceId, team.user?.userId);
  const handshake = useQuery({ queryKey: ["host-sidebar-connection", account], enabled: host.id !== "local" && (!team.enabled || team.user?.role === "owner"), queryFn: async ({ signal }) => {
    const response = await localControlFetch(`/api/backends/${encodeURIComponent(host.id)}/handshake`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error("Host is disconnected.");
    const value = await response.json();
    const backend = BackendDescriptorSchema.parse(value.backend);
    if (backend.id !== host.id || backend.status !== "connected") throw new Error("Host is disconnected.");
    const identity = parseBackendHandshake(value.handshake);
    return { backend, epoch: JSON.stringify([identity.engineId, identity.serverInstanceId]) };
  }, retry: false, refetchInterval: 30000, refetchOnWindowFocus: false });
  const effectiveHost = handshake.data?.backend ?? host;
  const connectionStatus = handshake.isError ? "disconnected" : effectiveHost.status;
  const epoch = handshake.data?.epoch ?? "registry";
  // Registry refreshes create fresh objects; only actual transport policy changes
  // should replace a client or invalidate its host/account-bound cache.
  const policy = JSON.stringify({ id: host.id, status: connectionStatus, protocolVersion: effectiveHost.protocolVersion, capabilities: effectiveHost.capabilities, platform: effectiveHost.platform });
  const transport = useMemo(() => ({ api: createBackendApi(host.id, JSON.parse(policy) as BackendDescriptor), disposal: undefined as ReturnType<typeof setTimeout> | undefined }), [host.id, policy, account, epoch]);
  const api = transport.api;
  useEffect(() => {
    if (transport.disposal) clearTimeout(transport.disposal);
    return () => { transport.disposal = setTimeout(() => transport.api.client.dispose(), 0); };
  }, [transport]);
  const [groupOpen, setGroupOpen] = usePersistentState(`host-sidebar-group:${host.id}`, true);
  const key = ["host-sidebar-chats", account, epoch];
  const history = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const [live, saved] = await Promise.all([api.listConsoleSessions(signal), api.listSavedConsoleSessions(signal)]);
    return { live, saved };
  }, enabled: connectionStatus === "connected", retry: false, refetchInterval: connectionStatus === "connected" ? 10000 : false, refetchOnWindowFocus: false });
  const suppressClickUntil = useRef(0);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }, []);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const selectionVersion = navigationVersion;
  const [error, setError] = useState("");
  const [deletion, setDeletion] = useState<{ id: string; saved: boolean; title: string } | null>(null);
  const activityHistory = useRef<{ account: string; values: Map<string, SidebarChatActivity> }>({ account, values: new Map() });
  if (activityHistory.current.account !== account) activityHistory.current = { account, values: new Map() };
  const rows = useMemo(() => {
    const live = history.data?.live.filter(session => session.status !== "closed" && (team.enabled || (selectedBackendId === host.id && selectedId === session.id) || (session.messageCount ?? 0) > 0 || session.status !== "ready")) ?? [];
    const active = new Set(history.data?.live.filter(session => session.status !== "closed").flatMap(session => [session.id, ...(session.savedId ? [session.savedId] : [])]));
    const saved = history.data?.saved.filter(session => !session.archived && !active.has(session.id) && (team.enabled || session.messageCount > 0)) ?? [];
    const remembered = rememberSidebarActivity(orderSessionRail(live, saved, history.data?.saved ?? []), activityHistory.current.values);
    return sortSidebarChats(remembered, sort, filter);
  }, [history.data, account, team.enabled, selectedBackendId, host.id, selectedId, sort, filter]);
  const offline = connectionStatus !== "connected";
  const unavailable = offline || history.isError;
  const open = (id: string, title: string, saved = false) => {
    selectionVersion.current++;
    setOpeningId(null);
    setError("");
    onSelect?.();
    onPendingChatChange?.(null);
    if (onOpenDockChat && !saved) onOpenDockChat(id, title, host.id);
    else navigate(backendRouteHref(host.id, `/console/${saved ? "saved/" : ""}${encodeURIComponent(id)}`));
  };
  const resume = async (id: string, title: string) => {
    if (readOnly) { open(id, title, true); return; }
    const version = ++selectionVersion.current;
    setOpeningId(id); setError("");
    onSelect?.();
    const pending = { id, title, backendId: host.id };
    onPendingChatChange?.(pending);
    const stillSelected = () => version === selectionVersion.current && (!isPendingChatCurrent || isPendingChatCurrent(pending));
    try {
      const session = await api.resumeConsoleSession(id, {});
      cache.setQueryData<typeof history.data>(key, previous => previous ? {
        live: [...previous.live.filter(item => item.id !== session.id), session],
        saved: previous.saved,
      } : { live: [session], saved: [] });
      if (currentApi.client.backendId === host.id) cache.setQueryData<import("@0/shared").DesktopConsoleSession[]>(["console-sessions"], previous => [...(previous ?? []).filter(item => item.id !== session.id), session]);
      if (stillSelected()) open(session.id, session.title || title);
      void cache.invalidateQueries({ queryKey: key });
    } catch { if (stillSelected()) { setError("Couldn’t open this chat. Try again."); onPendingChatChange?.(null); } }
    finally { if (version === selectionVersion.current) setOpeningId(null); }
  };
  const prefetch = (id: string, saved: boolean) => {
    if (saved || currentApi.client.backendId !== host.id || unavailable) return;
    void cache.prefetchQuery({ queryKey: consoleSnapshotKey(host.id, id, team.user?.workspaceId, team.user?.userId), queryFn: ({ signal }) => api.getConsoleSnapshot(id, signal), staleTime: 1000, gcTime: 300000 });
  };
  const remove = async () => {
    if (!deletion || readOnly || busy) return;
    setBusy(true); setError("");
    try { if (deletion.saved) await api.deleteSavedConsoleSession(deletion.id); else await api.deleteConsoleSession(deletion.id); setDeletion(null); await cache.invalidateQueries({ queryKey: key }); }
    catch { setError("Couldn’t delete this chat. Try again."); }
    finally { setBusy(false); }
  };
  const Icon = host.id === "local" ? Monitor : Server;
  if (offline && rows.length === 0) return null;
  const statusLabel = `${host.name} — ${offline ? "Disconnected" : history.isError ? "Connected; chats unavailable" : "Connected"}`;
  return <Disclosure open={groupOpen} onOpenChange={setGroupOpen} actions={!readOnly ? <Button variant="ghost" size="icon-xs" aria-label={`New chat on ${host.name}`} disabled={unavailable} onClick={() => onCreate?.(host.id)}><SquarePen className="size-3.5" /></Button> : undefined} className="mb-2" triggerClassName="group flex h-8 w-full items-center gap-2.5 rounded-[var(--radius-control)] border border-transparent px-1.5 text-xs text-muted-foreground hover:bg-muted/50" summary={<><Icon className="size-4 shrink-0" /><span className="min-w-0 truncate text-left">{host.id === "local" && /darwin|mac/i.test(host.platform?.os ?? "") ? "My Mac" : host.name}</span><Tooltip content={statusLabel} side="right"><span role="img" aria-label={statusLabel} className={cn("size-1.5 shrink-0 rounded-full", offline ? "bg-muted-foreground/40" : "bg-emerald-500")} /></Tooltip><ChevronDown className="size-3 transition-transform group-aria-expanded:rotate-180" /></>}>
    {history.isError && !history.data ? <Button size="xs" variant="ghost" onClick={() => void history.refetch()}>Retry loading chats</Button> : history.isPending ? <ChatHistorySkeleton /> : <div className="relative isolate">
      <SelectionHighlight activeKey={`${selectedBackendId}:${openingId ?? selectedId}`} revision={rows.map(row => row.key).join(":")} />
      {rows.map(row => {
        const session = row.session;
        const title = row.kind === "live" ? row.session.title || row.session.target || "Untitled chat" : row.session.summary || row.session.target || row.session.preview || "Past chat";
        const isSaved = row.kind === "saved";
        const selected = openingId === session.id || selectedBackendId === host.id && selectedId === session.id;
        return <div key={row.key} data-ui-selected={selected || undefined} className="sidebar-history-row group relative z-10 flex min-w-0 items-center rounded-[var(--radius-control)] hover:bg-muted/50">
          <Button variant="row" size="sm" asChild className="min-w-0 flex-1 justify-start px-3 font-normal">
            <a onPointerEnter={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); prefetchTimer.current = setTimeout(() => prefetch(session.id, isSaved), 80); }} onPointerLeave={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }} onFocus={() => prefetch(session.id, isSaved)} aria-busy={openingId === session.id || undefined} href={backendRouteHref(host.id, `/console/${isSaved ? "saved/" : ""}${encodeURIComponent(session.id)}`)} draggable={true} onDragStart={event => { suppressClickUntil.current = Number.POSITIVE_INFINITY; event.dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify({ id: session.id, sessionId: session.id, backendId: host.id, title, saved: isSaved })); event.dataTransfer.effectAllowed = "copy"; }} onDragEnd={() => { suppressClickUntil.current = Date.now() + 350; }} onClick={event => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); return; } if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); if (isSaved) void resume(session.id, title); else { if (currentApi.client.backendId === host.id && row.kind === "live") cache.setQueryData<import("@0/shared").DesktopConsoleSession[]>(["console-sessions"], previous => [...(previous ?? []).filter(item => item.id !== session.id), row.session]); open(session.id, title); } } }}><span title={title} className="min-w-0 flex-1 truncate text-left">{title}</span></a>
          </Button>
          {row.kind === "live" && row.session.status === "working" && <span aria-label="Responding" className="size-1.5 shrink-0 rounded-full bg-current text-muted-foreground" />}
          {!readOnly && <Button variant="ghost" size="icon-xs" disabled={busy || unavailable} className="sidebar-history-delete absolute right-1 pointer-events-none opacity-0 text-muted-foreground hover:text-destructive group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100" aria-label={`Delete ${title}`} onClick={() => setDeletion({ id: session.id, title, saved: isSaved })}><Trash2 className="size-3.5" /></Button>}
        </div>;
      })}
      {!rows.length && <p className="px-3 py-2 text-xs text-muted-foreground">{filter ? "No matching chats." : "No chats yet."}</p>}
    </div>}
    {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    <Dialog open={Boolean(deletion)} onOpenChange={open => { if (!open) setDeletion(null); }}><DialogContent><DialogHeader><DialogTitle>Delete chat?</DialogTitle><DialogDescription>Delete “{deletion?.title}” from {host.name}? This cannot be undone.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeletion(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Delete chat</Button></DialogFooter></DialogContent></Dialog>
  </Disclosure>;
}
