import { VOCAB, v } from "@/lib/vocabulary";
import { LaptopIcon, ServerIcon } from "@/ui/icons/device";
import { ActivityMark, ChatHistorySkeleton } from "@/console/loading-state";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Ellipsis, Monitor, Search, Server, Trash2 } from "lucide-react";
import { BackendDescriptorSchema, parseBackendHandshake, type BackendDescriptor } from "@0/engine/dist/shared/backend-protocol.js";
import { createBackendApi, localControlFetch, useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { useTeamAccess } from "./team-access";
import { Tooltip } from "./ui/tooltip";
import { Button } from "./ui/button";
import { DropdownMenu } from "./ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { rememberSidebarActivity, sidebarChatDetails, sidebarChatTitle, sidebarChatTitlePending, sortSidebarChats, type SidebarChatActivity } from "@/console/sidebar-chat-order";
import { orderSessionRail, type SessionRailRow } from "@/console/session-rail-order";
import { openAppSearch } from "./command-palette";
import { formatRelativeAge } from "@/lib/relative-time";
import { CHAT_DRAG_MIME } from "@/console/dock-workspace";
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

/** Everything the merged list needs from one host; actions stay bound to that host's API and cache. */
interface HostSlice {
  host: BackendDescriptor;
  rows: SessionRailRow[];
  details: Map<string, string>;
  offline: boolean;
  loading: boolean;
  failed: boolean;
  error: string;
  openingId: string | null;
  busy: boolean;
  unavailable: boolean;
  actions: HostActions;
}
interface HostActions {
  click: (row: SessionRailRow, title: string) => void;
  prefetch: (id: string, saved: boolean) => void;
  requestDelete: (id: string, title: string, saved: boolean) => void;
  retry: () => void;
}
interface MergedRow { id: string; slice: HostSlice; row: SessionRailRow; title: string }

const ATTENTION: Record<string, string> = { working: "Responding", cancelling: "Stopping", waiting: "Waiting for you", failed: "Needs attention" };

/**
 * One flat, time-sorted chat list across every registered host. Each host keeps its own queries,
 * cache and actions (HostChatSource); this component only merges what they publish.
 */
export function HostSidebarChatHistory(props: HostHistoryProps) {
  const selection = useBackendSelection();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const [sort, setSort] = usePersistentState<"updated" | "name">("host-sidebar-sort", "updated");
  const [collapsed, setCollapsed] = usePersistentState("host-sidebar-chats-collapsed", false);
  const [slices, setSlices] = useState<Record<string, HostSlice>>({});
  const navigationVersion = useRef(0);
  const suppressClickUntil = useRef(0);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }, []);
  // Draft renders replace page callbacks without changing the host roster.
  // Keep source props stable while actions use the latest committed closures.
  const actions = useRef(props);
  useLayoutEffect(() => { actions.current = props; }, [props]);
  const select = useCallback(() => actions.current.onSelect?.(), []);
  const pendingChatChange = useCallback((pending: PendingChatSelection | null) => actions.current.onPendingChatChange?.(pending), []);
  const pendingChatCurrent = useCallback((pending: PendingChatSelection) => actions.current.isPendingChatCurrent?.(pending) ?? true, []);
  const openDockChat = useCallback((id: string, title: string, backendId: string) => actions.current.onOpenDockChat?.(id, title, backendId), []);
  const publish = useCallback((slice: HostSlice) => setSlices(previous => previous[slice.host.id] === slice ? previous : { ...previous, [slice.host.id]: slice }), []);
  const hosts = selection?.backends ?? [];
  const hostId = props.selectedBackendId ?? selection?.backendId ?? "local";
  const published = hosts.flatMap(host => slices[host.id] ? [slices[host.id]!] : []);
  const items: MergedRow[] = published.flatMap(slice => slice.rows.map(row => ({ id: `${slice.host.id}:${row.key}`, slice, row, title: sidebarChatTitle(row) })));
  items.sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id) : b.row.timestamp - a.row.timestamp || a.id.localeCompare(b.id));
  const multiHost = hosts.length > 1;
  const { client: pageClient } = useBackendApi();
  const loading = items.length === 0 && (published.length < hosts.length || published.some(slice => slice.loading));
  const failedHosts = published.filter(slice => slice.failed);
  const error = published.find(slice => slice.error)?.error;
  const now = Date.now();
  return <div className="flex h-full min-h-0 flex-col">
    <div className="mx-0.5 mt-2.5 flex h-7 shrink-0 items-center gap-1">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)} className="group/collapsible flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-(--radius-button) px-2 text-xs font-medium text-muted-foreground-2 outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-ring-inset">{v("{Missions}")}<ChevronDown aria-hidden="true" className={cn("size-3 shrink-0 text-muted-foreground-3 transition-[opacity,rotate] duration-100", collapsed ? "-rotate-90 opacity-100" : "opacity-0 group-hover/collapsible:opacity-100 group-focus-visible/collapsible:opacity-100")} /></button>
      <div className="ml-auto flex items-center">
        <Tooltip content={v("Search {missions}")} side="bottom"><Button variant="ghost" size="icon-sm" aria-label={v("Search {missions}")} onClick={event => openAppSearch("chats", event.currentTarget)} className="text-muted-foreground-1"><Search className="size-(--icon-sm)" /></Button></Tooltip>
        <DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label={v("{Mission} list options")} className="relative text-muted-foreground-1" />}><Ellipsis className="size-(--icon-sm)" />{sort !== "updated" && <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />}</DropdownMenu.Trigger><DropdownMenu.Content align="end" sideOffset={4} className="w-48"><DropdownMenu.Group>
          <DropdownMenu.Label>{v("Sort {missions}")}</DropdownMenu.Label>
          <DropdownMenu.Item selected={sort === "updated"} onClick={() => setSort("updated")}>Last updated</DropdownMenu.Item>
          <DropdownMenu.Item selected={sort === "name"} onClick={() => setSort("name")}>Name</DropdownMenu.Item>
        </DropdownMenu.Group></DropdownMenu.Content></DropdownMenu>
      </div>
    </div>
    {hosts.map(host => <HostChatSource key={host.id} host={host} publish={publish} navigationVersion={navigationVersion} {...props} selectedBackendId={hostId} onSelect={select} onPendingChatChange={pendingChatChange} isPendingChatCurrent={pendingChatCurrent} onOpenDockChat={props.onOpenDockChat ? openDockChat : undefined} sort={sort} filter="" />)}
    {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    <div className={cn("min-h-0 flex-1 overflow-y-auto scroll-fade-y", collapsed && "hidden")}>
      {loading ? <ChatHistorySkeleton /> : <div role="list" aria-label={v("{Missions}")} className="relative isolate flex flex-col gap-px">
        {items.map(({ id, slice, row, title }) => {
          const { host } = slice;
          const session = row.session;
          const isSaved = row.kind === "saved";
          const selected = slice.openingId === session.id || hostId === host.id && props.selectedId === session.id;
          const live = row.kind === "live" ? row.session.status : undefined;
          const attention = live ? ATTENTION[live] : undefined;
          const working = live === "working" || live === "cancelling";
          const count = (row.session as { messageCount?: number }).messageCount;
          // Every row gets a second line (like Capy's thread rows): attention/detail text first, else a quiet status summary.
          const summary = [live ? (working ? (live === "cancelling" ? "Stopping" : "Working") : "Idle") : "Saved", typeof count === "number" && count > 0 ? `${count} ${count === 1 ? "message" : "messages"}` : ""].filter(Boolean).join(" · ");
          const sub = slice.details.get(row.key) ?? attention ?? summary;
          const hostLabel = `${host.name}${slice.offline ? " · offline" : ""}`;
          const tag = (multiHost && host.id !== pageClient.backendId) || slice.offline ? hostLabel : "";
          const Icon = host.id === "local" ? LaptopIcon : ServerIcon;
          const showIcon = true;
          const age = formatRelativeAge(row.timestamp, now);
          return <div key={id} role="listitem" data-ui-selected={selected || undefined} className="group relative mx-0.5 flex min-w-0 items-center rounded-(--radius-button) transition-colors duration-100 hover:bg-secondary data-[ui-selected]:bg-secondary">
            <a onPointerEnter={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); prefetchTimer.current = setTimeout(() => slice.actions.prefetch(session.id, isSaved), 80); }} onPointerLeave={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }} onFocus={() => slice.actions.prefetch(session.id, isSaved)} aria-busy={slice.openingId === session.id || undefined} aria-current={selected ? "page" : undefined} href={backendRouteHref(host.id, `/console/${isSaved ? "saved/" : ""}${encodeURIComponent(session.id)}`)} draggable={true}
              onDragStart={event => { suppressClickUntil.current = Number.POSITIVE_INFINITY; event.dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify({ id: session.id, sessionId: session.id, backendId: host.id, title, saved: isSaved })); event.dataTransfer.effectAllowed = "copy"; }}
              onDragEnd={() => { suppressClickUntil.current = Date.now() + 350; }}
              onClick={event => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); return; } if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); slice.actions.click(row, title); } }}
              title={sub ? `${title} — ${sub}` : title}
              className={cn("grid min-w-0 flex-1 items-center", showIcon ? "grid-cols-[--spacing(4)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]", " gap-x-2 gap-y-0.5 rounded-md px-2 text-muted-foreground-1 outline-none select-none group-hover:text-foreground group-data-[ui-selected]:text-foreground focus-visible:outline-ring-inset", "py-1.5")}>
              {showIcon && <span title={host.name} className="inline-flex size-(--icon-sm) place-self-center"><Icon className="size-(--icon-sm)" /></span>}
              <span className="flex min-w-0 items-center gap-2">
                <span className={cn("min-w-0 truncate text-sm font-normal", sidebarChatTitlePending(row) && "ui-text-shimmer")}>{title}</span>
                <span className="ml-auto flex min-w-6 shrink-0 items-center justify-end">
                  {working
                    ? <span role="status" aria-label={live === "cancelling" ? "Stopping" : "Working"} className={cn("flex size-4 items-center justify-center text-muted-foreground", !readOnly && "group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 [@media(hover:none)]:opacity-0")}><ActivityMark compact /></span>
                    : <span className={cn("block text-2xs leading-none font-normal text-muted-foreground-2 tabular-nums", !readOnly && "group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 [@media(hover:none)]:opacity-0")}>{age}</span>}
                </span>
              </span>
              {(tag || sub) && <span className={cn(showIcon ? "col-start-2" : "col-start-1", "flex min-w-0 items-center gap-1 text-2xs font-normal whitespace-nowrap text-muted-foreground-2")}>
                {tag && <span className="min-w-0 shrink-[3] truncate">{tag}</span>}
                {sub && tag && <span aria-hidden="true" className="shrink-0">·</span>}
                {sub && <span className={cn("min-w-0 shrink truncate", attention ? "text-primary-ink" : "text-muted-foreground-2")}>{sub}</span>}
              </span>}
            </a>
            {!readOnly && <div className="pointer-events-none absolute inset-y-0 right-0 flex origin-right scale-[.98] items-start rounded-r-(--radius-button) bg-chrome bg-[image:linear-gradient(var(--secondary),var(--secondary))] pt-1 pr-1 pl-9 opacity-0 transition-[opacity,scale] duration-100 [mask-image:linear-gradient(to_left,#000_calc(100%-32px),transparent)] group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:scale-100 group-has-[:focus-visible]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:scale-100 [@media(hover:none)]:opacity-100">
              <Button variant="ghost" size="icon-xs" disabled={slice.busy || slice.unavailable} className="size-5.5 p-1 text-muted-foreground hover:bg-transparent hover:text-destructive" aria-label={`Delete ${title}`} onClick={() => slice.actions.requestDelete(session.id, title, isSaved)}><Trash2 className="size-(--icon-sm)" /></Button>
            </div>}
          </div>;
        })}
        {!items.length && failedHosts.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{published.some(slice => slice.offline) && !published.some(slice => !slice.offline) ? v("Connect a host to see {missions}.") : v("No {missions} yet.")}</p>}
        {failedHosts.map(slice => <Button key={slice.host.id} size="xs" variant="ghost" className="justify-start text-muted-foreground" onClick={slice.actions.retry}>{multiHost ? `Retry loading ${VOCAB.mission.plural} from ${slice.host.name}` : v("Retry loading {missions}")}</Button>)}
      </div>}
    </div>
  </div>;
}

type SourceProps = HostHistoryProps & { host: BackendDescriptor; navigationVersion: RefObject<number>; publish: (slice: HostSlice) => void };

/** Headless per-host data source: queries, cache and mutations for one host, published to the merged list. */
const HostChatSource = memo(function HostChatSource({ host, publish, navigationVersion, onSelect, onPendingChatChange, isPendingChatCurrent, onOpenDockChat, selectedId, selectedBackendId, sort = "updated", filter = "" }: SourceProps) {
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
  // The active host shares the workspace's lists (one source, one poll); other hosts keep their own combined slice.
  const sharedHost = currentApi.client.backendId === host.id;
  const key = ["host-sidebar-chats", account, epoch];
  const remote = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const [live, saved] = await Promise.all([api.listConsoleSessions(signal), api.listSavedConsoleSessions(signal)]);
    return { live, saved };
  }, enabled: !sharedHost && connectionStatus === "connected", retry: false, staleTime: 15_000, refetchInterval: connectionStatus === "connected" ? 30_000 : false, refetchOnWindowFocus: false });
  const sharedSessions = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => currentApi.listConsoleSessions(signal), enabled: sharedHost && connectionStatus === "connected", staleTime: 15_000, refetchInterval: 10_000 });
  const sharedSaved = useQuery({ queryKey: ["console-saved"], queryFn: ({ signal }) => currentApi.listSavedConsoleSessions(signal), enabled: sharedHost && connectionStatus === "connected", staleTime: 15_000, refetchInterval: 30_000 });
  const sharedData = useMemo(() => sharedSessions.data && sharedSaved.data ? { live: sharedSessions.data, saved: sharedSaved.data } : undefined, [sharedSessions.data, sharedSaved.data]);
  const history = {
    data: sharedHost ? sharedData : remote.data,
    isPending: sharedHost ? sharedSessions.isPending || sharedSaved.isPending : remote.isPending,
    isError: sharedHost ? sharedSessions.isError || sharedSaved.isError : remote.isError,
    refetch: () => sharedHost ? Promise.all([sharedSessions.refetch(), sharedSaved.refetch()]) : remote.refetch(),
  };
  const invalidateHistory = () => sharedHost ? Promise.all([cache.invalidateQueries({ queryKey: ["console-sessions"] }), cache.invalidateQueries({ queryKey: ["console-saved"] })]) : cache.invalidateQueries({ queryKey: key });
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
  const rowDetails = useMemo(() => sidebarChatDetails(rows), [rows]);
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
  const prefetch = (id: string, saved: boolean) => {
    if (currentApi.client.backendId !== host.id || unavailable) return;
    if (saved) { void cache.prefetchQuery({ queryKey: ["saved-transcript", host.id, id], queryFn: ({ signal }) => api.getSavedTranscript(id, { window: 60 }, signal), staleTime: 30_000 }); return; }
    void cache.prefetchQuery({ queryKey: consoleSnapshotKey(host.id, id, team.user?.workspaceId, team.user?.userId), queryFn: ({ signal }) => api.getConsoleSnapshot(id, signal), staleTime: 1000, gcTime: 300000 });
  };
  const remove = async () => {
    if (!deletion || readOnly || busy) return;
    setBusy(true); setError("");
    try { if (deletion.saved) await api.deleteSavedConsoleSession(deletion.id); else await api.deleteConsoleSession(deletion.id); setDeletion(null); await invalidateHistory(); }
    catch { setError(v("Couldn’t delete this {mission}. Try again.")); }
    finally { setBusy(false); }
  };
  const latest = useRef<HostActions | null>(null);
  useLayoutEffect(() => {
    latest.current = {
      click: (row, title) => {
        // Saved rows open the read-only transcript at once; the live session is resumed only when the user focuses the composer or sends.
        if (row.kind === "saved") open(row.session.id, title, true);
        else {
          if (currentApi.client.backendId === host.id) cache.setQueryData<import("@0/engine/shared").DesktopConsoleSession[]>(["console-sessions"], previous => [...(previous ?? []).filter(item => item.id !== row.session.id), row.session]);
          open(row.session.id, title);
        }
      },
      prefetch,
      requestDelete: (id, title, saved) => setDeletion({ id, title, saved }),
      retry: () => void history.refetch(),
    };
  });
  const actions = useMemo<HostActions>(() => ({
    click: (row, title) => latest.current?.click(row, title),
    prefetch: (id, saved) => latest.current?.prefetch(id, saved),
    requestDelete: (id, title, saved) => latest.current?.requestDelete(id, title, saved),
    retry: () => latest.current?.retry(),
  }), []);
  const loading = connectionStatus === "connected" && history.isPending;
  const failed = history.isError && !history.data;
  const slice = useMemo<HostSlice>(() => ({ host, rows, details: rowDetails, offline, loading, failed, error, openingId, busy, unavailable, actions }), [host, rows, rowDetails, offline, loading, failed, error, openingId, busy, unavailable, actions]);
  useEffect(() => { publish(slice); }, [publish, slice]);
  return <Dialog open={Boolean(deletion)} onOpenChange={open => { if (!open) setDeletion(null); }}><DialogContent><DialogHeader><DialogTitle>{v("Delete {mission}?")}</DialogTitle><DialogDescription>Delete “{deletion?.title}” from {host.name}? This cannot be undone.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeletion(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{v("Delete {mission}")}</Button></DialogFooter></DialogContent></Dialog>;
});
