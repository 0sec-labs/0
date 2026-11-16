import { queryKeys } from "@/queries";
import { SAVED_POLL_MS, sessionsRefetchInterval } from "@/console/session-polling";
import { VOCAB, v } from "@/lib/vocabulary";
import { ActivityMark, ChatHistorySkeleton } from "@/console/loading-state";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Search, Trash2 } from "lucide-react";
import { BackendDescriptorSchema, parseBackendHandshake, type BackendDescriptor } from "@0/engine/shared/backend-protocol";
import { createBackendApi, localControlFetch, useBackendApi } from "@/api";
import { errorText, isMissingMissionText } from "@/lib/api-error";
import { useBackendSelection } from "@/backend-context";
import { useTeamAccess } from "./team-access";
import { Tooltip } from "./ui/tooltip";
import { Button } from "./ui/button";
import { SidebarLabel } from "@/ui/components/sidebar";
import { SidebarListHeader } from "./sidebar/sidebar-list-header";
import { RowAge, RowSubline, RowTitleLine, sidebarRowClasses } from "./sidebar/sidebar-row";
import { rowNavigation } from "./sidebar/use-row-navigation";
import { useSidebarDensity } from "./sidebar/use-sidebar-list";
import { folderMonogram, threadShelf, threadSubline } from "@/lib/sidebar-rows";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { markMissionsDeleting } from "@/lib/deleting-missions";
import { rememberSidebarActivity, sidebarChatTitle, sidebarChatTitlePending, sortSidebarChats, type SidebarChatActivity } from "@/console/sidebar-chat-order";
import { orderSessionRail, type SessionRailRow } from "@/console/session-rail-order";
import { openAppSearch } from "./search-events";
import { formatRelativeAge } from "@/lib/relative-time";
import { CHAT_DRAG_MIME } from "@/console/dock-chat-state";
import { backendRouteHref, chatHostScopeKey } from "@/console/chat-host";
import { consoleSnapshotKey } from "@/console/use-console-workspace";
import { usePersistentState } from "@/lib/use-persistent-state";
import { cn } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage";

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

const SORTS = [{ value: "updated", label: "Recent" }, { value: "name", label: "Name" }] as const;
const ATTENTION: Record<string, string> = { working: "Responding", cancelling: "Stopping", waiting: "Waiting for you", failed: "Needs attention" };

/**
 * One flat, time-sorted chat list across every registered host. Each host keeps its own queries,
 * cache and actions (HostChatSource); this component only merges what they publish.
 */
export function HostSidebarChatHistory(props: HostHistoryProps) {
  const selection = useBackendSelection();
  const team = useTeamAccess();
  const readOnly = team.enabled && team.user?.role === "viewer";
  const [sort, setSort] = usePersistentState<"updated" | "name">(STORAGE_KEYS.sidebarSort, "updated");
  const [density, setDensity] = useSidebarDensity();
  const navigate = useNavigate();
  const [slices, setSlices] = useState<Record<string, HostSlice>>({});
  /* Row actions are mounted (not faded) while a row is hovered or holds focus; touch has no hover, so they stay mounted. */
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const touchOnly = useMemo(() => typeof matchMedia === "function" && matchMedia("(hover: none)").matches, []);
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
  const loading = items.length === 0 && (published.length < hosts.length || published.some(slice => slice.loading));
  const failedHosts = published.filter(slice => slice.failed);
  const error = published.find(slice => slice.error)?.error;
  const now = Date.now();
  const placed = items.map(item => {
    const live = item.row.kind === "live" ? item.row.session.status : undefined;
    const waiting = Boolean(live && (ATTENTION[live] || (item.row.session as { lastTurnIncomplete?: boolean; lastTurnFailed?: boolean }).lastTurnIncomplete || (item.row.session as { lastTurnFailed?: boolean }).lastTurnFailed));
    const selected = item.slice.openingId === item.row.session.id || hostId === item.slice.host.id && props.selectedId === item.row.session.id;
    return { item, shelf: threadShelf({ automation: Boolean((item.row.session as { parentSessionId?: string }).parentSessionId), waiting, selected, timestamp: item.row.timestamp, now }) };
  });
  const main = placed.filter(p => p.shelf === "main").map(p => p.item);
  const settled = placed.filter(p => p.shelf === "settled").map(p => p.item);
  const automations = placed.filter(p => p.shelf === "automations").map(p => p.item);
  const renderRow = ({ id, slice, row, title }: MergedRow) => {
  const { host } = slice;
  const session = row.session;
  const isSaved = row.kind === "saved";
  const selected = slice.openingId === session.id || hostId === host.id && props.selectedId === session.id;
  const live = row.kind === "live" ? row.session.status : undefined;
  const attention = live ? ATTENTION[live] ?? ((row.session as { lastTurnIncomplete?: boolean }).lastTurnIncomplete ? "Needs attention" : (row.session as { lastTurnFailed?: boolean }).lastTurnFailed ? "Last turn failed" : undefined) : undefined;
  const working = live === "working" || live === "cancelling";
  const count = (row.session as { messageCount?: number }).messageCount;
  // Second line: the waiting/failed text in the accent colour, else the folder and the computer. Running work shows its spinner instead.
  const waiting = working ? undefined : attention;
  const hostLabel = `${host.name}${slice.offline ? " · offline" : ""}`;
  const subline = threadSubline({ attention: waiting, workspacePath: (row.session as { workspacePath?: string }).workspacePath, computer: hostLabel });
  const age = formatRelativeAge(row.timestamp, now);
  return <div key={id} role="listitem" data-active={selected || undefined} onPointerEnter={event => { if (event.pointerType !== "touch") setActionsFor(id); }} onPointerLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setActionsFor(current => current === id ? null : current); }} onFocus={() => setActionsFor(id)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActionsFor(current => current === id ? null : current); }} className={cn("group", sidebarRowClasses(density))}>
    <a onPointerEnter={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); prefetchTimer.current = setTimeout(() => slice.actions.prefetch(session.id, isSaved), 80); }} onPointerLeave={() => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }} onFocus={() => slice.actions.prefetch(session.id, isSaved)} aria-busy={slice.openingId === session.id || undefined} aria-current={selected ? "page" : undefined} href={backendRouteHref(host.id, `/chats/${isSaved ? "saved/" : ""}${encodeURIComponent(session.id)}`)} draggable={true}
      onDragStart={event => { suppressClickUntil.current = Number.POSITIVE_INFINITY; event.dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify({ id: session.id, sessionId: session.id, backendId: host.id, title, saved: isSaved })); event.dataTransfer.effectAllowed = "copy"; }}
      onDragEnd={() => { suppressClickUntil.current = Date.now() + 350; }}
      onClick={event => { if (Date.now() < suppressClickUntil.current) { event.preventDefault(); return; } if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); slice.actions.click(row, title); } }}
      data-sidebar-row title={title}
      className="-mx-2 flex h-full min-w-0 flex-1 flex-col justify-center gap-1 rounded-md px-2 outline-none select-none focus-visible:outline-ring-inset">
      <RowTitleLine className={sidebarChatTitlePending(row) ? "ui-text-shimmer" : undefined} title={title} trailing={<span className="flex min-w-6 shrink-0 items-center justify-end">
        {working
          ? <span role="status" aria-label={live === "cancelling" ? "Stopping" : "Working"} className={cn("flex size-4 items-center justify-center text-muted-foreground", !readOnly && "group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0")}><ActivityMark compact /></span>
          : <RowAge className={cn(!readOnly && "group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0")}>{age}</RowAge>}
      </span>} />
      {density === "comfortable" && (subline.kind === "needs-you"
        ? <RowSubline className="text-primary-ink">{subline.text}</RowSubline>
        : <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground-1">
          {subline.folder && <><span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-secondary text-[9px] leading-none font-semibold">{folderMonogram(subline.folder)}</span><SidebarLabel className="flex-initial">{subline.folder}</SidebarLabel></>}
          <SidebarLabel className="max-w-[60%] flex-none text-right ml-auto">{subline.computer}</SidebarLabel>
        </span>)}
    </a>
    {!readOnly && (actionsFor === id || touchOnly) && <div data-slot="sidebar-thread-actions" className="absolute inset-y-0 right-0 flex items-center rounded-r-md bg-chrome bg-[image:linear-gradient(var(--secondary),var(--secondary))] pr-1 pl-9 [mask-image:linear-gradient(to_left,#000_calc(100%-32px),transparent)]">
      <Button variant="ghost" size="icon-xs" disabled={slice.busy || slice.unavailable} tooltip={`Delete ${VOCAB.mission.singular}`} className="size-5.5 p-1 text-muted-foreground hover:bg-transparent hover:text-destructive" aria-label={`Delete ${title}`} onClick={() => slice.actions.requestDelete(session.id, title, isSaved)}><Trash2 className="size-(--icon-sm)" /></Button>
    </div>}
  </div>;
        };
  return <div className="flex h-full min-h-0 flex-col">
    <SidebarListHeader title={v("{Missions}")} newLabel={v("New {mission}")} onNew={() => props.onCreate ? props.onCreate(hostId) : navigate(backendRouteHref(hostId, "/chats?new=1"))} sortLabel="Sort by" sortOptions={SORTS} sort={sort} onSort={setSort} density={density} onDensity={setDensity}>
      <Tooltip content={v("Search {missions}")} side="bottom"><Button variant="ghost" size="icon-sm" aria-label={v("Search {missions}")} onClick={event => openAppSearch("chats", event.currentTarget)} className="text-muted-foreground-1"><Search className="size-(--icon-sm)" /></Button></Tooltip>
    </SidebarListHeader>
    {hosts.map(host => <HostChatSource key={host.id} host={host} publish={publish} navigationVersion={navigationVersion} selectedId={props.selectedId} selectedBackendId={hostId} onSelect={select} onPendingChatChange={pendingChatChange} isPendingChatCurrent={pendingChatCurrent} onOpenDockChat={props.onOpenDockChat ? openDockChat : undefined} sort={sort} filter="" />)}
    {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
    <div onKeyDown={rowNavigation} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-fade-y px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {loading ? <ChatHistorySkeleton /> : <div role="list" aria-label={v("{Missions}")} className="relative isolate flex flex-col">
        {main.map(renderRow)}
        <ThreadShelfList label="Settled" rows={settled} render={renderRow} />
        <ThreadShelfList label="Automations" rows={automations} render={renderRow} />
        {!items.length && failedHosts.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{v("No {missions} yet.")}</p>}
        {failedHosts.map(slice => <Button key={slice.host.id} size="xs" variant="ghost" className="justify-start text-muted-foreground" onClick={slice.actions.retry}>{multiHost ? `Retry loading ${VOCAB.mission.plural} from ${slice.host.name}` : v("Retry loading {missions}")}</Button>)}
      </div>}
    </div>
  </div>;
}

/** A collapsed shelf at the end of the list: muted label and count, rows only once opened. */
function ThreadShelfList({ label, rows, render }: { label: string; rows: MergedRow[]; render: (row: MergedRow) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return <div role="group" aria-label={label}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground-1 outline-none transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset">
      <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform duration-100", open && "rotate-90")} />
      <span>{label}</span><span className="tabular-nums">{rows.length}</span>
    </button>
    {open && rows.map(render)}
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
  const handshake = useQuery({ queryKey: queryKeys.hostSidebarConnection(account), enabled: host.id !== "local" && (!team.enabled || team.user?.role === "owner"), queryFn: async ({ signal }) => {
    const response = await localControlFetch(`/api/backends/${encodeURIComponent(host.id)}/handshake`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error("Computer is disconnected.");
    const value = await response.json();
    const backend = BackendDescriptorSchema.parse(value.backend);
    if (backend.id !== host.id || backend.status !== "connected") throw new Error("Computer is disconnected.");
    const identity = parseBackendHandshake(value.handshake);
    return { backend, epoch: JSON.stringify([identity.engineId, identity.serverInstanceId]) };
  }, retry: false, refetchInterval: 60_000, refetchOnWindowFocus: false });
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
  const key = queryKeys.hostSidebarChats(account, epoch);
  const remote = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const [live, saved] = await Promise.all([api.listConsoleSessions(signal), api.listSavedConsoleSessions(signal)]);
    return { live, saved };
  }, enabled: !sharedHost && connectionStatus === "connected", retry: false, staleTime: 15_000, refetchInterval: connectionStatus === "connected" ? 30_000 : false, refetchOnWindowFocus: false });
  const sharedSessions = useQuery({ queryKey: queryKeys.consoleSessions(), queryFn: ({ signal }) => currentApi.listConsoleSessions(signal), enabled: sharedHost && connectionStatus === "connected", staleTime: 15_000, refetchInterval: sessionsRefetchInterval });
  const sharedSaved = useQuery({ queryKey: queryKeys.consoleSaved(), queryFn: ({ signal }) => currentApi.listSavedConsoleSessions(signal), enabled: sharedHost && connectionStatus === "connected", staleTime: 15_000, refetchInterval: SAVED_POLL_MS });
  const sharedData = useMemo(() => sharedSessions.data && sharedSaved.data ? { live: sharedSessions.data, saved: sharedSaved.data } : undefined, [sharedSessions.data, sharedSaved.data]);
  const history = {
    data: sharedHost ? sharedData : remote.data,
    isPending: sharedHost ? sharedSessions.isPending || sharedSaved.isPending : remote.isPending,
    isError: sharedHost ? sharedSessions.isError || sharedSaved.isError : remote.isError,
    refetch: () => sharedHost ? Promise.all([sharedSessions.refetch(), sharedSaved.refetch()]) : remote.refetch(),
  };
  const invalidateHistory = () => sharedHost ? Promise.all([cache.invalidateQueries({ queryKey: queryKeys.consoleSessions() }), cache.invalidateQueries({ queryKey: queryKeys.consoleSaved() })]) : cache.invalidateQueries({ queryKey: key });
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
    const live = history.data?.live.filter(session => session.status !== "closed" && (team.enabled || (selectedBackendId === host.id && selectedId === session.id) || (session.messageCount ?? 0) > 0 || session.titleSource === "user" || session.status !== "ready")) ?? [];
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
    else navigate(backendRouteHref(host.id, `/chats/${saved ? "saved/" : ""}${encodeURIComponent(id)}`));
  };
  const prefetch = (id: string, saved: boolean) => {
    if (currentApi.client.backendId !== host.id || unavailable) return;
    if (saved) { void cache.prefetchQuery({ queryKey: queryKeys.savedTranscript(host.id, id), queryFn: ({ signal }) => api.getSavedTranscript(id, { window: 60 }, signal), staleTime: 30_000 }); return; }
    void cache.prefetchQuery({ queryKey: consoleSnapshotKey(host.id, id, team.user?.workspaceId, team.user?.userId), queryFn: ({ signal }) => api.getConsoleSnapshot(id, signal), staleTime: 1000, gcTime: 300000 });
  };
  const remove = async () => {
    if (!deletion || readOnly || busy) return;
    setBusy(true); setError("");
    markMissionsDeleting(deletion.id);
    try { if (deletion.saved) await api.deleteSavedConsoleSession(deletion.id); else await api.deleteConsoleSession(deletion.id); setDeletion(null); await invalidateHistory(); }
    catch (cause) {
      const reason = errorText(cause, "");
      // A mission the host no longer has is already gone: drop the row instead of failing.
      if (isMissingMissionText(reason)) { setDeletion(null); await invalidateHistory().catch(() => undefined); }
      else setError(reason && reason.length <= 160 && !/[{}<]/.test(reason) ? reason : v("Couldn’t delete this {mission}. Try again."));
    }
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
  const slice = useMemo<HostSlice>(() => ({ host, rows, offline, loading, failed, error, openingId, busy, unavailable, actions }), [host, rows, offline, loading, failed, error, openingId, busy, unavailable, actions]);
  useEffect(() => { publish(slice); }, [publish, slice]);
  return <ConfirmDialog open={Boolean(deletion)} onOpenChange={open => { if (!open) setDeletion(null); }} pending={busy} cancelVariant="outline" destructive title={v("Delete {mission}?")} description={<>“{deletion?.title}”</>} confirmLabel="Delete" onConfirm={() => void remove()} />;
});
