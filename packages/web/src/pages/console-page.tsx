import { queryKeys } from "@/queries";
import { SLASH_DESTINATIONS, explainPrompt } from "@/console/slash-destinations";
import { findBlankSession, withCreateLock } from "@/console/blank-session";
import { runOnBackendHost } from "@/console/run-on-host";
import { useChatVisibility } from "@/console/use-chat-visibility";
import { useOwnedNavigate } from "@/console/use-owned-navigate";
import { usePendingChat } from "@/console/use-pending-chat";
import { useSessionAliases } from "@/console/use-session-aliases";
import { useStaleSessionRecovery } from "@/console/use-stale-session-recovery";
import { VOCAB, v } from "@/lib/vocabulary";
import { NewChatButton } from "@/components/new-chat-button";
import { dockWorkspaceStorageKey } from "@/console/dock-chat-state";
import { dockChatsBeforeSessions, dockChatsForRender } from "@/console/dock-layout";
import { isRequestCancellation } from "@/lib/request-cancellation";
import { setWebTheme } from "@/lib/web-theme";
import { useAppNotice } from "@/components/app-notice";
import { isTransientMessage } from "@/lib/network-resilience";
import {
  isMissingSession,
  rememberSessionAlias,
  staleSessionRecovery,
  useResolvedSessionId,
  type SessionAlias,
} from "@/console/session-recovery";
import { Textarea } from "@/components/ui/textarea";
import { createPortal } from "react-dom";
import { useSidebarHistory } from "@/components/sidebar-history";
import { openAppSearch } from "@/components/search-events";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from "react-router-dom";
import { useQuery, useQueryClient, QueryClientProvider } from "@tanstack/react-query";
import { findCommand, SLASH_COMMANDS } from "@0/engine/dist/shared/slash-commands.js";
import type {
  ConsoleSessionSnapshot,
  ConsolePublicExport,
  DesktopConsoleSession,
  HarnessSnapshot,
  ConsoleCreateSessionInput,
} from "@0/engine/shared";
import { DEFAULT_AUTONOMY_MODE } from "@0/engine/dist/shared/desktop-console.js";
import { Download, Menu, Trash2, Pencil, Eraser } from "lucide-react";
import {
  CapyCopyIcon as Copy,
  CapyMoreIcon as MoreHorizontal,
  CapyCloseIcon as X,
  CapySparkleIcon as Sparkles,
} from "@/ui/icons/capy";
import { createBackendApi, useBackendApi } from "@/api";
import { BackendApiContext, BackendSelectionContext, useBackendSelection } from "@/backend-context";
import { ChatBackendScope, ChatHostSelectionScope } from "@/chat-backend-scope";
import { chatResourceKey, parseChatResourceKey, backendRouteHref } from "@/console/chat-host";
import { createChatOnExecutionHost, configureChatRuntime } from "@/console/model-source";
import { HostSidebarChatHistory, type PendingChatSelection } from "@/components/host-sidebar-chat-history";
import { useTeamAccess } from "@/components/team-access";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usePersistentState } from "@/lib/use-persistent-state";
import { ConversationSkeleton } from "@/console/loading-state";
import { recoveredProviderError } from "@/console/connection-recovery";
import {
  consoleErrorMessage,
  needsModelEnabled,
  needsProviderSignIn,
  needsModelSourceReconnect,
} from "@/console/provider-error";
import { TeamCollaboration } from "@/console/team-collaboration";
import { DockWorkspace, type DockViews } from "@/console/dock-workspace";
import {
  RightPanelToggle,
  agentTitle,
  agentViewId,
  usePanelData,
  type OpenViewOptions,
  type PanelControls,
  type PanelViewId,
} from "@/console/panel";
import { CostButton } from "@/console/panel/cost-popover";
import { publishDisplaySettings } from "@/lib/display-settings";
import { reconcileDockChatState } from "@/console/dock-chat-state";
import { Conversation, Composer } from "@/console/conversation";

import { ConsoleSessionRail } from "@/console/session-rail";
import { addFindingToDraft } from "@/console/finding-context";
import type { FindingRecord } from "@/types";
import { consoleSnapshotKey, useConsoleWorkspace } from "@/console/use-console-workspace";
import { useComposerPrefill } from "@/console/use-composer-prefill";
import { savedRouteTarget } from "@/console/saved-snapshot";
import { LIST_STALE_MS } from "@/console/workspace-events";
import type { SettingsResponse } from "@/components/console-control/contracts";
import { errorText } from "@/lib/api-error";
import { STORAGE_KEYS } from "@/lib/storage";

interface FeedbackResult {
  saved: boolean;
  path?: string;
  submitted: boolean;
  previewId?: string;
  preview?: { url: string; body: unknown; headers: unknown; warnings: string[] };
  error?: string;
}
type ConfirmAction = { kind: "close" | "clear" | "delete" | "delete-live" | "drain"; id: string; title: string };

type EmbeddedDockView = { actions: ReactNode; views: DockViews };
interface ConsolePageProps {
  /** `/chats/saved/:id` with no live owner: show this retained transcript through the live view; the first send resumes it. */
  savedSessionId?: string;
  embeddedSessionId?: string;
  embeddedBackendId?: string;
  /** Embedded chats: the agent tab visible in the shared right panel, when this chat owns it. */
  panelWorkerId?: string | null;
  /** Embedded chats: open a view in the shared right panel. */
  onOpenView?: (id: PanelViewId, options?: OpenViewOptions) => void;
  onOpenDockChat?: (id: string, title: string, backendId?: string) => void;
  onCloseDockChat?: (key: string) => void;
  onDockViewChange?: (key: string, view: EmbeddedDockView) => void;
  onDockRosterChange?: (backendId: string, sessions: DesktopConsoleSession[]) => void;
  onDockSessionResolved?: (backendId: string, oldId: string, session: DesktopConsoleSession) => void;
}
function ChatTeamPresence({
  sessionId,
  workerId,
  client,
}: {
  sessionId: string;
  workerId: string | null;
  client: ReturnType<typeof useBackendApi>["teamClient"];
}) {
  const [drafts] = usePersistentState<Record<string, string>>(STORAGE_KEYS.drafts, {});
  const value = drafts?.[`${sessionId}:${workerId ?? "root"}`];
  return <TeamCollaboration sessionId={sessionId} client={client} draft={typeof value === "string" ? value : ""} />;
}

export function ConsolePage(props: ConsolePageProps = {}) {
  const { client } = useBackendApi();
  const [query] = useSearchParams();
  const owner = useTeamAccess();
  const accountKey = `${owner.user?.workspaceId ?? "personal"}:${owner.user?.userId ?? "personal"}`;
  const backendId = props.embeddedBackendId ?? query.get("host") ?? client.backendId;
  return (
    <ChatBackendScope key={`${backendId}:${accountKey}`} backendId={backendId}>
      <ConsolePageContent {...props} />
    </ChatBackendScope>
  );
}
function ConsolePageContent({
  savedSessionId,
  embeddedSessionId,
  embeddedBackendId,
  panelWorkerId,
  onOpenView,
  onOpenDockChat,
  onCloseDockChat,
  onDockViewChange,
  onDockRosterChange,
  onDockSessionResolved,
}: ConsolePageProps) {
  const scopedApi = useBackendApi();
  const {
    client,
    teamClient,
    archiveConsoleSession,
    closeConsoleSession,
    configureConsoleSession,
    controlConsoleSession,
    deleteConsoleSession,
    deleteSavedConsoleSession,
    exportConsoleSession,
    resolveConsoleDecision,
    resumeConsoleSession,
    stopConsoleWorker,
    webFetchJson,
    getConsoleSnapshot,
    listConsoleSessions,
  } = scopedApi;
  const queryClient = useQueryClient();
  const backendRegistry = useBackendSelection();
  const team = useTeamAccess();
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  // The address bar keeps the id the user opened; a recovered mission is reached through the persisted alias, so the URL never jumps.
  const resolvedRouteId = useResolvedSessionId(routeSessionId);
  const embedded = Boolean(embeddedSessionId);
  // `/chats/saved/:id` opens the live session that already owns the record; otherwise the retained transcript is read
  // (while the roster loads it is assumed unowned). Nothing live exists to act on until the first send resumes it.
  const savedRoster = useQuery({
    queryKey: queryKeys.consoleSessions(),
    queryFn: ({ signal }) => listConsoleSessions(signal),
    staleTime: LIST_STALE_MS,
    enabled: Boolean(savedSessionId) && !embedded,
  });
  const savedTarget = embedded ? undefined : savedRouteTarget(savedSessionId, savedRoster.data);
  const liveSessionId = savedTarget?.kind === "live" ? savedTarget.sessionId : undefined;
  const savedMode = savedTarget?.kind === "saved";
  const sessionId = embeddedSessionId ?? liveSessionId ?? (savedMode ? savedSessionId : undefined) ?? resolvedRouteId;
  const [search, setSearch] = useSearchParams();
  const routeNavigate = useNavigate();
  const navigate = useOwnedNavigate(client.backendId);
  const dockLegacyKey = `0-console-dock-view:${sessionId ?? "new"}`;
  // Embedded views must never reconcile the root layout out of the shared store.
  const dockPersistenceKey = dockWorkspaceStorageKey({
    backendId: client.backendId,
    embeddedSessionId,
    workspaceId: team.user?.workspaceId,
    userId: team.user?.userId,
  });
  const [extraChatIds, setExtraChatIds] = usePersistentState<
    Array<{ id: string; title: string; savedId?: string; backendId?: string }>
  >(`${dockPersistenceKey}:chats`, [], { legacyKey: `${dockLegacyKey}:chats` });
  const [activeChatId, setActiveChatId] = usePersistentState<string | null>(`${dockPersistenceKey}:active-chat`, null, {
    legacyKey: `${dockLegacyKey}:active-chat`,
  });
  // The agent tab visible in the right panel decides which worker the worker composer addresses.
  const [visibleAgentId, setVisibleAgentId] = useState<string | null>(null);
  const [panelControls, setPanelControls] = useState<PanelControls | null>(null);
  const workerId = embedded ? (panelWorkerId ?? null) : activeChatId ? null : visibleAgentId;
  const { setChatElement, chatVisible } = useChatVisibility();
  const workspace = useConsoleWorkspace(sessionId, workerId, { visible: chatVisible, savedId: savedMode ? savedSessionId : undefined });
  useComposerPrefill(!embedded && Boolean(sessionId) && !workerId, () => workspace.readDraft(true), workspace.setRootDraft);
  const [sessionAliases, setSessionAliases] = useSessionAliases(workspace);
  const recoveringSession = useStaleSessionRecovery({
    embedded,
    sessionId: savedMode ? undefined : sessionId,
    routeSessionId,
    backendId: client.backendId,
    readOnlyTeam,
    workspace,
    sessionAliases,
    setSessionAliases,
    navigate,
    search,
    resumeConsoleSession,
    createOwnedSession: (configuration) => createOwnedSession(configuration),
    onDockSessionResolved,
  });
  const [hostRosters, setHostRosters] = useState<Record<string, DesktopConsoleSession[]>>({});
  const pendingResolved = Boolean(workspace.snapshot) || Boolean(workspace.error);
  const { pendingChatSelection, pendingChatRef, showPendingChat, isPendingChatCurrent } = usePendingChat({
    activeChatId,
    sessionId,
    backendId: client.backendId,
    pendingResolved,
  });
  // Only tab reconciliation sees these references; they grant no chat capabilities.
  const [openingChats, setOpeningChats] = useState<
    Record<string, { backendId: string; session: DesktopConsoleSession }>
  >({});
  const pendingHostRemaps = useRef<Record<string, string | null>>({});
  const updateHostRoster = useCallback(
    (backendId: string, sessions: DesktopConsoleSession[]) =>
      setHostRosters((previous) =>
        JSON.stringify(previous[backendId]) === JSON.stringify(sessions)
          ? previous
          : { ...previous, [backendId]: sessions },
      ),
    [],
  );
  const resolveDockSession = useCallback(
    (backendId: string, oldId: string, session: DesktopConsoleSession) => {
      const oldKey = chatResourceKey({ backendId, id: oldId }),
        newKey = chatResourceKey({ backendId, id: session.id });
      pendingHostRemaps.current[oldKey] = newKey;
      setHostRosters((previous) => ({
        ...previous,
        [backendId]: [
          ...(previous[backendId] ?? []).filter((item) => item.id !== oldId && item.id !== session.id),
          session,
        ],
      }));
      setExtraChatIds((previous) =>
        previous.map((item) => {
          const ref = parseChatResourceKey(item.id, item.backendId ?? client.backendId);
          return ref && chatResourceKey(ref) === oldKey
            ? { id: session.id, backendId, title: session.title || item.title, savedId: session.savedId }
            : item;
        }),
      );
      setActiveChatId((previous) => (previous === oldKey ? newKey : previous));
    },
    [client.backendId, setExtraChatIds, setActiveChatId],
  );
  const [embeddedViews, setEmbeddedViews] = useState<Record<string, EmbeddedDockView>>({});
  const updateEmbeddedView = useCallback(
    (id: string, view: EmbeddedDockView) => setEmbeddedViews((current) => ({ ...current, [id]: view })),
    [],
  );
  const closeDockChat = (id: string) => {
    if (pendingChatRef.current?.paneKey === id) showPendingChat(null);
    setExtraChatIds((current) =>
      current.filter((item) => chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) !== id),
    );
    setActiveChatId((current) => (current === id ? null : current));
    setEmbeddedViews((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  };
  const openDockChat = (id: string, title: string, backendId = client.backendId) => {
    const key = chatResourceKey({ backendId, id });
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            `[data-console-resource="${CSS.escape(key)}"] textarea[aria-autocomplete="list"]:not(:disabled)`,
          )
          ?.focus({ preventScroll: true }),
      ),
    );
    if (onOpenDockChat) {
      onOpenDockChat(id, title, backendId);
      return;
    }
    if (!routeSessionId && backendId === client.backendId) {
      const next = new URLSearchParams(search);
      next.delete("new");
      next.set("host", backendId);
      navigate(`/chats/${id}?${next}`);
      return;
    }
    if ((id === routeSessionId || id === sessionId) && backendId === client.backendId) {
      setActiveChatId(null);
      return;
    }
    const insert = (savedId?: string) => {
      setExtraChatIds((current) =>
        current.some((item) => item.id === id && (item.backendId ?? client.backendId) === backendId)
          ? current
          : [...current, { id, title, backendId, savedId }],
      );
      setActiveChatId(key);
    };
    const snapshotKey = consoleSnapshotKey(backendId, id, team.user?.workspaceId, team.user?.userId);
    const cached =
      backendId === client.backendId ? queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey) : undefined;
    const known =
      (backendId === client.backendId ? workspace.sessions : hostRosters[backendId])?.find(
        (session) => session.id === id,
      ) ?? cached?.session;
    if (!known) {
      // Mount the selected view now, retaining its tab until background validation
      // supplies an authoritative roster entry. Never wait for a host handshake here.
      const session: DesktopConsoleSession = {
        id,
        title,
        target: "",
        role: "audit",
        autonomyMode: DEFAULT_AUTONOMY_MODE,
        status: "ready",
        scopeConfigured: false,
        localScopeConfigured: false,
        createdAt: "",
        updatedAt: "",
      };
      setOpeningChats((previous) => ({ ...previous, [key]: { backendId, session } }));
      insert();
      const verify =
        backendId === client.backendId
          ? queryClient.fetchQuery({
              queryKey: snapshotKey,
              queryFn: ({ signal }) => getConsoleSnapshot(id, signal),
              staleTime: 1000,
              gcTime: 300_000,
            })
          : runOnHost(backendId, (api) => api.getConsoleSnapshot(id));
      void verify
        .then((value) => {
          if (backendId === client.backendId)
            queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
              ...(previous ?? []).filter((item) => item.id !== id),
              value.session,
            ]);
          else
            setHostRosters((previous) => ({
              ...previous,
              [backendId]: [...(previous[backendId] ?? []).filter((item) => item.id !== id), value.session],
            }));
        })
        .catch((error) => {
          if (isRequestCancellation(error)) return;
          setOpeningChats((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
          setNotice(errorText(error, v("Couldn't open that {mission}.")));
        });
      return;
    }
    if (backendId === client.backendId && !workspace.sessions.some((item) => item.id === id))
      queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
        ...(previous ?? []).filter((item) => item.id !== id),
        known,
      ]);
    insert(known.savedId);
  };
  const replaceChatInPlace = (id: string, title: string, backendId = client.backendId) => {
    const key = chatResourceKey({ backendId, id });
    if (activeChatId && key !== chatResourceKey({ backendId: client.backendId, id: sessionId ?? "" })) {
      if (
        extraChatIds.some(
          (item) => chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) === key,
        )
      ) {
        setActiveChatId(key);
        return;
      }
      const old = activeChatId;
      pendingHostRemaps.current[old] = key;
      setExtraChatIds((items) =>
        items.map((item) =>
          chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) === old
            ? { id, title, backendId }
            : item,
        ),
      );
      setActiveChatId(key);
      return;
    }
    setActiveChatId(null);
    routeNavigate(backendRouteHref(backendId, `/chats/${encodeURIComponent(id)}`));
  };
  const runOnHost = <T,>(
    backendId: string,
    action: (api: ReturnType<typeof createBackendApi>) => Promise<T>,
  ): Promise<T> =>
    runOnBackendHost({
      backendId,
      currentBackendId: client.backendId,
      currentApi: scopedApi,
      registry: backendRegistry,
      action,
    });
  const createOwnedSession = (configuration: ConsoleCreateSessionInput) =>
    workspace.perform(() => createChatOnExecutionHost(client.backendId, configuration), undefined);
  const createChatOnHost = async (backendId: string) => {
    if (backendId === client.backendId) {
      await createSession();
      return;
    }
    try {
      const created = await createChatOnExecutionHost(backendId, {
        title: v("New {mission}"),
        role: "audit",
        autonomyMode: DEFAULT_AUTONOMY_MODE,
      });
      setHostRosters((previous) => ({
        ...previous,
        [backendId]: [...(previous[backendId] ?? []).filter((item) => item.id !== created.id), created],
      }));
      onDockSessionResolved?.(backendId, created.id, created);
      replaceChatInPlace(created.id, created.title || v("New {mission}"), backendId);
    } catch (error) {
      if (isRequestCancellation(error)) return;
      setNotice(error instanceof Error ? error.message : v("Couldn't open {a mission} on that computer."));
    }
  };
  const settingsQuery = useQuery({
    queryKey: queryKeys.consoleSettings(client.backendId, team.user?.workspaceId, team.user?.userId),
    queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }),
    staleTime: 60_000,
  });
  useEffect(() => {
    setOpeningChats((previous) => {
      const retained = Object.entries(previous).filter(
        ([, opening]) =>
          !(opening.backendId === client.backendId ? workspace.sessions : hostRosters[opening.backendId])?.some(
            (item) => item.id === opening.session.id,
          ),
      );
      return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained);
    });
  }, [workspace.sessions, hostRosters, client.backendId]);
  const dockChatState = useMemo(() => {
    const sessions = [...workspace.sessions];
    const sessionsByBackend = { ...hostRosters };
    for (const opening of Object.values(openingChats)) {
      const roster =
        opening.backendId === client.backendId
          ? sessions
          : (sessionsByBackend[opening.backendId] = [...(sessionsByBackend[opening.backendId] ?? [])]);
      if (!roster.some((item) => item.id === opening.session.id)) roster.push(opening.session);
    }
    return reconcileDockChatState({
      chats: extraChatIds,
      activeChatId,
      sessions,
      primarySessionId: sessionId,
      defaultBackendId: client.backendId,
      primaryBackendId: client.backendId,
      sessionsByBackend,
    });
  }, [extraChatIds, activeChatId, workspace.sessions, sessionId, client.backendId, hostRosters, openingChats]);
  // A pending selection belongs to the primary pane unless it names a docked chat that still exists.
  const pendingPrimary =
    Boolean(pendingChatSelection) &&
    (pendingChatSelection!.paneKey === null ||
      !dockChatState.chats.some(
        (item) =>
          chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) ===
          pendingChatSelection!.paneKey,
      ));
  const dockRemap = useRef<{ key: string; ids: Record<string, string | null> }>({ key: dockPersistenceKey, ids: {} });
  if (dockRemap.current.key !== dockPersistenceKey) dockRemap.current = { key: dockPersistenceKey, ids: {} };
  Object.assign(dockRemap.current.ids, dockChatState.chatIdRemap, pendingHostRemaps.current);
  // The primary chat and the persisted tabs mount from the route and stored layout without waiting for the sessions list.
  const persistedDockChats = useMemo(
    () =>
      dockChatsBeforeSessions(extraChatIds, {
        primary: { backendId: client.backendId, id: sessionId },
        defaultBackendId: client.backendId,
      }),
    [extraChatIds, client.backendId, sessionId],
  );
  const dockChatsNormalized =
    JSON.stringify(extraChatIds) === JSON.stringify(dockChatState.chats) && activeChatId === dockChatState.activeChatId;
  useEffect(() => {
    if (!workspace.sessionsLoaded || dockChatsNormalized) return;
    setExtraChatIds(dockChatState.chats);
    setActiveChatId(dockChatState.activeChatId);
  }, [workspace.sessionsLoaded, dockChatsNormalized, dockChatState, setExtraChatIds, setActiveChatId]);
  useEffect(() => {
    if (!embedded || !workspace.sessionsLoaded || !workspace.savedLoaded || !onDockRosterChange) return;
    if (sessionId && staleSessionRecovery(sessionId, workspace.sessions, workspace.saved, sessionAliases)) return;
    onDockRosterChange(client.backendId, workspace.sessions);
  }, [
    embedded,
    workspace.sessionsLoaded,
    workspace.savedLoaded,
    workspace.sessions,
    workspace.saved,
    onDockRosterChange,
    client.backendId,
    sessionId,
    sessionAliases,
  ]);
  const snapshot = workspace.snapshot;
  const worker = snapshot?.workers.find((item) => item.id === workerId);
  const canExport = Boolean(snapshot?.messages.some((message) => message.content.length > 0));
  const panelData = usePanelData(snapshot ?? undefined, sessionId);
  const [activeSession, setActiveSession] = usePersistentState<string | null>(STORAGE_KEYS.activeSession, null);
  const creatingSession = useRef(false);
  const sessionRailElement = useRef<HTMLElement>(null);
  const openingInitialChat = useRef(false);
  const requestedNewSession = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const restoreDockState = useCallback(
    (state: { activeChatId: string | null }) => setActiveChatId(state.activeChatId),
    [setActiveChatId],
  );
  const controlsRef = useRef(panelControls);
  controlsRef.current = panelControls;
  const openPanelView = useCallback(
    (id: PanelViewId, options?: OpenViewOptions) => {
      if (embedded) onOpenView?.(id, options);
      else controlsRef.current?.openView(id, options);
    },
    [embedded, onOpenView],
  );
  /** Agent chips and rows: `null` opens the Agents list, an id opens that worker's tab. */
  const selectWorker = (id: string | null) => {
    const found = id ? snapshot?.workers.find((item) => item.id === id) : undefined;
    openPanelView(found ? agentViewId(found.id) : "agents", found ? { title: agentTitle(found) } : undefined);
  };
  // `?worker=<id>` deep links open that agent's tab once, then leave the URL clean.
  const deepLinkedWorker = embedded ? null : search.get("worker");
  useEffect(() => {
    if (!deepLinkedWorker || !panelControls?.ready || !snapshot) return;
    const found = snapshot.workers.find((item) => item.id === deepLinkedWorker);
    if (found) panelControls.openView(agentViewId(found.id), { title: agentTitle(found) });
    const next = new URLSearchParams(search);
    next.delete("worker");
    setSearch(next, { replace: true });
  }, [deepLinkedWorker, panelControls, snapshot?.session.id, snapshot?.workers.length]);
  const observedPlans = useRef(new Set<string>());
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1536px)").matches);
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [rename, setRename] = useState<DesktopConsoleSession | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [exported, setExported] = useState<ConsolePublicExport | null>(null);
  const [exportKind, setExportKind] = useState<"root" | "worker">("root");
  const [copyStatus, setCopyStatus] = useState("");
  const [capOpen, setCapOpen] = useState(false);
  const [continuation, setContinuation] = useState(
    v("Continue the remaining task from the preserved {mission} and plan. Do not repeat completed work."),
  );
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  const staged = useRef(new Set<string>());
  const focused = useRef<string | null>(null);
  const findingId = embedded ? null : search.get("finding");
  const requestedIntent = embedded ? null : search.get("intent");
  const controlsQuery = sessionId
    ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/chats/${routeSessionId ?? sessionId}`)}`
    : "?return=/chats";
  const active = snapshot && ["working", "waiting", "cancelling"].includes(snapshot.session.status);
  const visibleError =
    !recoveringSession &&
    workspace.error &&
    !isTransientMessage(workspace.error) &&
    !recoveredProviderError(workspace.error, workspace.connectionRecovery) &&
    workspace.error !== snapshot?.lastOutcome?.error
      ? workspace.error
      : undefined;
  useAppNotice(
    embedded
      ? null
      : visibleError
        ? {
            id: `console:${sessionId}`,
            message: consoleErrorMessage(visibleError),
            kind: "error",
            onDismiss: () => {
              workspace.dismissError();
              if (workspace.error) workspace.refresh();
              setNotice("");
            },
            action:
              needsModelSourceReconnect(visibleError) && workspace.reconnectModelSource
                ? {
                    label: workspace.modelSourceRecovery?.checking ? "Reconnecting…" : "Reconnect model source",
                    onClick: () => void workspace.reconnectModelSource?.(),
                  }
                : needsProviderSignIn(visibleError)
                  ? { label: "Manage connection", href: `/connections${controlsQuery}` }
                  : needsModelEnabled(visibleError)
                    ? { label: "Open Connections", href: `/connections${controlsQuery}` }
                    : undefined,
          }
        : notice
          ? { id: `console:${sessionId}`, message: notice, kind: "status", onDismiss: () => setNotice("") }
          : null,
  );
  const dialogError = workspace.error && (
    <p
      role="alert"
      className="rounded-[var(--radius-control)] border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive"
    >
      {workspace.error}
    </p>
  );

  useEffect(() => {
    if (!snapshot?.todos?.todos.length || !wide) return;
    const key = snapshot.session.id;
    if (!observedPlans.current.has(key)) {
      observedPlans.current.add(key);
    }
  }, [snapshot?.session.id, snapshot?.todos, wide]);

  useEffect(() => {
    if (settingsQuery.data) publishDisplaySettings(settingsQuery.data.settings);
  }, [settingsQuery.data]);
  useEffect(() => {
    const busyMode = settingsQuery.data?.settings.busyInputMode;
    if (busyMode === "queue" || busyMode === "steer") setMode(busyMode);
  }, [settingsQuery.data?.settings.busyInputMode]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1536px)");
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // An ID the host no longer has (stale URL or storage): forget it and land on a fresh Home.
  const missingSession = isMissingSession({
    sessionId,
    hasSnapshot: Boolean(snapshot),
    recovering: recoveringSession,
    loading: workspace.loading,
    sessionsLoaded: workspace.sessionsLoaded,
    savedLoaded: workspace.savedLoaded,
    error: workspace.error ?? undefined,
    sessions: workspace.sessions,
    saved: workspace.saved,
    aliases: sessionAliases,
  });
  useEffect(() => {
    if (embedded || !missingSession) return;
    setActiveSession(null);
    workspace.dismissError();
    setNotice(v("That {mission} isn't available on this host."));
    navigate("/chats?new=1", { replace: true });
  }, [embedded, missingSession]);
  useEffect(() => {
    if (embedded || missingSession || savedMode) return;
    if (sessionId) setActiveSession(sessionId);
    else if (
      !findingId &&
      search.get("new") !== "1" &&
      activeSession &&
      workspace.sessions.some((item) => item.id === activeSession && item.status !== "closed")
    )
      navigate(`/chats/${activeSession}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: true });
  }, [sessionId, activeSession, workspace.sessions, findingId, navigate, setActiveSession, search]);
  const findBlank = () => findBlankSession(workspace.sessions, snapshot, team.enabled);
  const createSession = async () => {
    if (readOnlyTeam) {
      const available = workspace.sessions.find((item) => item.status !== "closed");
      if (available) openDockChat(available.id, available.title || v("{Mission}"));
      return;
    }
    if (creatingSession.current) return;
    setRailOpen(false);
    const blank = findBlank();
    if (blank) {
      if (blank.id !== sessionId) replaceChatInPlace(blank.id, blank.title || v("New {mission}"));
      else if (!embedded) {
        setActiveChatId(null);
        if (search.get("new") === "1") navigate(`/chats/${blank.id}`, { replace: true });
      }
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            `[data-console-session="${CSS.escape(blank.id)}"] textarea[aria-autocomplete="list"]`,
          )
          ?.focus(),
      );
      return;
    }
    creatingSession.current = true;
    try {
      // Serialise across tabs and mounts, then re-check the server's list: the cached roster can be stale,
      // and two visits racing each other would otherwise each create their own empty chat.
      const created = await withCreateLock(async () => {
        if (!team.enabled) {
          const fresh = await listConsoleSessions().catch(() => null);
          if (fresh) {
            queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], fresh);
            const reusable = findBlankSession(fresh, snapshot, false);
            if (reusable) return { reused: reusable };
          }
        }
        return {
          created: await createOwnedSession({
            title: v("New {mission}"),
            role: "audit",
            autonomyMode: DEFAULT_AUTONOMY_MODE,
          }),
        };
      }).then((result) => {
        if (result.reused) {
          replaceChatInPlace(result.reused.id, result.reused.title || v("New {mission}"));
          return undefined;
        }
        return result.created;
      });
      if (created) {
        queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
          ...(previous ?? []).filter((item) => item.id !== created.id),
          created,
        ]);
        onDockSessionResolved?.(client.backendId, created.id, created);
        replaceChatInPlace(created.id, created.title || v("New {mission}"));
      }
    } finally {
      creatingSession.current = false;
    }
  };
  useEffect(() => {
    if (
      embedded ||
      sessionId ||
      findingId ||
      search.get("new") === "1" ||
      !workspace.sessionsLoaded ||
      openingInitialChat.current
    )
      return;
    openingInitialChat.current = true;
    const existing = workspace.sessions.find((item) => item.id === activeSession && item.status !== "closed");
    if (existing)
      navigate(`/chats/${existing.id}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: true });
    else void createSession();
  }, [sessionId, findingId, search, workspace.sessionsLoaded, activeSession]);
  useEffect(() => {
    if (embedded || search.get("search") !== "1" || !sessionId) return;
    openAppSearch("chats");
    const next = new URLSearchParams(search);
    next.delete("search");
    setSearch(next, { replace: true });
  }, [sessionId, search, setSearch]);
  useEffect(() => {
    if (embedded) return;
    if (search.get("new") !== "1") {
      requestedNewSession.current = false;
      return;
    }
    if (requestedNewSession.current || !workspace.sessionsLoaded) return;
    requestedNewSession.current = true;
    void createSession();
  }, [search, workspace.sessionsLoaded]);
  useEffect(() => {
    if (!findingId) {
      focused.current = null;
      return;
    }
    const requestKey = `${findingId}:${requestedIntent ?? "investigate"}`;
    if (focused.current === requestKey) return;
    focused.current = requestKey;
    const findingIntent =
      requestedIntent === "verify" || requestedIntent === "draft_fix" || requestedIntent === "impact"
        ? requestedIntent
        : "investigate";
    void createOwnedSession({ findingId, findingIntent }).then((created) => {
      if (created && focused.current === requestKey)
        navigate(`/chats/${created.id}${findingIntent === "impact" ? "?intent=impact" : ""}`, { replace: true });
    });
  }, [findingId, requestedIntent]);
  useEffect(() => {
    if (workerId || !snapshot?.stagedPrompt || staged.current.has(snapshot.session.id)) return;
    staged.current.add(snapshot.session.id);
    if (!workspace.readDraft()) workspace.setDraft(snapshot.stagedPrompt);
  }, [snapshot?.session.id, snapshot?.stagedPrompt, workerId]);

  const openExport = async (id: string, saved = false, copy = false, addressedWorker?: string) => {
    const result = await workspace.perform(() => exportConsoleSession(id, saved, addressedWorker), id);
    if (!result) return;
    setExported(result);
    setExportKind(addressedWorker ? "worker" : "root");
    setCopyStatus("");
    if (copy) {
      try {
        await navigator.clipboard.writeText(result.text);
        setCopyStatus("Copied");
      } catch {
        setCopyStatus("Couldn't copy. Select the text below or download it.");
      }
    }
  };
  const download = (format: "json" | "txt") => {
    if (!exported) return;
    const blob = new Blob([format === "json" ? JSON.stringify(exported.messages, null, 2) : exported.text], {
      type: format === "json" ? "application/json" : "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `0-conversation-${sessionId ?? "saved"}.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const submit = async (forceRoot = false) => {
    const messageWorkerId = forceRoot ? null : workerId;
    const messageWorkspace = forceRoot
      ? {
          ...workspace,
          draft: workspace.readDraft(true),
          attachments: workspace.rootAttachments,
          setDraft: workspace.setRootDraft,
          setAttachments: workspace.setRootAttachments,
        }
      : { ...workspace, draft: workspace.readDraft() };
    const text = messageWorkspace.draft.trim();
    if ((!text && !messageWorkspace.attachments.length) || messageWorkspace.busy) return;
    if (messageWorkerId && messageWorkspace.attachments.length) {
      setNotice(v("Attachments are available in the main {mission}."));
      return;
    }
    setNotice("");
    if (text.length > 32000) {
      setNotice("Message is too long (max 32,000 characters).");
      return;
    }
    const command = findCommand(text);
    if (command.isSlash && !messageWorkspace.attachments.length) {
      if (command.isUnknown) {
        setNotice(`Unknown command /${command.rawName}. Type /help to see commands.`);
        return;
      }
      const name = command.command!;
      if (messageWorkerId && (name === "clear" || name === "exit")) {
        setNotice(`Switch back to the main ${VOCAB.mission.singular} to use /${name}.`);
        return;
      }
      if (name === "help") {
        setHelpOpen(true);
        messageWorkspace.setDraft("");
        return;
      }
      if (name === "new-chat") {
        void createSession();
        return;
      }
      if (name === "sessions") {
        setRailOpen(true);
        messageWorkspace.setDraft("");
        return;
      }
      if (name === "status" || name === "usage") {
        openPanelView("overview");
        messageWorkspace.setDraft("");
        return;
      }
      if (name === "chat") {
        messageWorkspace.setDraft("");
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLTextAreaElement>(
              `[data-console-session="${CSS.escape(sessionId ?? "")}"] textarea[aria-autocomplete="list"]`,
            )
            ?.focus(),
        );
        return;
      }
      if (name === "back") {
        messageWorkspace.setDraft("");
        navigate(-1);
        return;
      }
      if (savedMode && (name === "clear" || name === "exit" || name === "model")) {
        setNotice(v("Send a message to resume this {mission} first."));
        return;
      }
      if (name === "copy") {
        if (sessionId) {
          await openExport(sessionId, savedMode, true, messageWorkerId ?? undefined);
          messageWorkspace.setDraft("");
        }
        return;
      }
      if (name === "clear" || name === "exit") {
        if (sessionId)
          setConfirm({
            kind: name === "clear" ? "clear" : "close",
            id: sessionId,
            title: snapshot?.title ?? v("this {mission}"),
          });
        return;
      }
      if (name === "model" && command.args && sessionId) {
        const result = await messageWorkspace.perform(() =>
          configureChatRuntime(scopedApi, sessionId, { model: command.args }, snapshot?.runtime),
        );
        if (result) messageWorkspace.setDraft("");
        return;
      }
      if (name === "theme" && command.args) {
        const appearance = command.args.trim().toLowerCase();
        if (appearance !== "light" && appearance !== "dark") {
          setNotice("Use /theme light or /theme dark for browser appearance.");
          return;
        }
        setWebTheme(appearance);
        messageWorkspace.setDraft("");
        setNotice(`Web appearance set to ${appearance}.`);
        return;
      }
      if (name === "feedback") {
        if (command.args === "cancel") {
          const result = await messageWorkspace.perform(() =>
            webFetchJson<FeedbackResult>("/api/console/feedback", {
              method: "POST",
              body: JSON.stringify({ action: "cancel" }),
            }),
          );
          if (result) {
            setFeedback(null);
            messageWorkspace.setDraft("");
            setNotice("Feedback cancelled.");
          }
          return;
        }
        if (command.args === "send") {
          if (!feedback?.previewId) setNotice("Use /feedback submit <message> first.");
          else setNotice("Review your feedback in the dialog, then send it.");
          return;
        }
        const submitFeedback = command.args.startsWith("submit ");
        const message = submitFeedback ? command.args.slice(7).trim() : command.args;
        if (!message) {
          setNotice("Use /feedback <message> to save it, or /feedback submit <message> to send it.");
          return;
        }
        const result = await messageWorkspace.perform(() =>
          webFetchJson<FeedbackResult>("/api/console/feedback", {
            method: "POST",
            body: JSON.stringify({ message, submit: submitFeedback }),
          }),
        );
        if (result) {
          messageWorkspace.setDraft("");
          if (result.previewId) setFeedback(result);
          else setNotice(result.error ?? `Feedback saved${result.path ? ` to ${result.path}` : ""}. Nothing was sent.`);
        }
        return;
      }
      if (name === "explain") {
        if (!sessionId || active) {
          setNotice("Wait until 0 finishes, then try again.");
          return;
        }
        if (!command.args && !snapshot?.messages.length) {
          setNotice("Nothing to explain yet. Use /explain <topic>.");
          return;
        }
        await messageWorkspace.send({
          text: explainPrompt(command.args),
          mode: "send",
          ...(messageWorkerId ? { workerId: messageWorkerId } : {}),
        });
        return;
      }
      if (SLASH_DESTINATIONS[name]) {
        let extra = name === "theme" ? "#setting-web-theme" : name === "keybindings" ? "&tab=keybindings" : "";
        if (name === "fix" && command.args) {
          if (command.args === "cancel") extra = "&intent=cancel";
          else if (command.args.startsWith("publish "))
            extra = `&finding=${encodeURIComponent(command.args.slice(8).trim())}&intent=publish`;
          else extra = `&finding=${encodeURIComponent(command.args)}`;
        }
        messageWorkspace.setDraft("");
        navigate(`${SLASH_DESTINATIONS[name]}${controlsQuery}${extra}`);
        return;
      }
      setNotice(`/${name} isn't available here.`);
      return;
    }
    if (!sessionId || (messageWorkerId && !worker)) {
      setNotice(v("Pick {a mission} first."));
      return;
    }
    await messageWorkspace.send({
      text,
      attachments: messageWorkspace.attachments.map(({ kind, value, name }) => ({ kind, value, name })),
      mode: messageWorkerId ? "send" : active ? mode : "send",
      ...(messageWorkerId ? { workerId: messageWorkerId } : {}),
    });
  };
  const onAddFinding = (finding: FindingRecord) => {
    workspace.setRootDraft(addFindingToDraft(workspace.readDraft(true), finding));
    setRailOpen(false);
    if (snapshot && !embedded && !savedMode) navigate(`/chats/${snapshot.session.id}`);
    setNotice("Finding added to your draft. Review it, then send.");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-composer-textarea]")?.focus());
  };
  const activeResource = activeChatId ? parseChatResourceKey(activeChatId, client.backendId) : undefined;
  const rail = (
    <HostSidebarChatHistory
      selectedId={pendingChatSelection?.id ?? activeResource?.id ?? sessionId}
      selectedBackendId={pendingChatSelection?.backendId ?? activeResource?.backendId ?? client.backendId}
      onPendingChatChange={showPendingChat}
      isPendingChatCurrent={isPendingChatCurrent}
      onOpenDockChat={replaceChatInPlace}
      onCreate={(backendId) => void createChatOnHost(backendId)}
      onSelect={() => setRailOpen(false)}
    />
  );

  const chatActions = (
    <div className="flex items-center gap-1">
      <Tooltip content={v("Open {missions}")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={v("Open {missions}")}
          className="lg:hidden"
          onClick={() => setRailOpen(true)}
        >
          <Menu className="size-4" />
        </Button>
      </Tooltip>
      {snapshot && team.enabled && client.backendId === "local" && (
        <ChatTeamPresence sessionId={snapshot.session.id} client={teamClient} workerId={workerId} />
      )}
      {snapshot && <CostButton snapshot={snapshot} />}
      {snapshot && (
        <DropdownMenu>
          <Tooltip content="Thread options">
            <DropdownMenu.Trigger
              aria-label={v("{Mission} menu")}
              className="flex size-7 items-center justify-center rounded-[var(--radius-control)] hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              <Button type="button" variant="ghost" size="icon-sm">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenu.Trigger>
          </Tooltip>
          <DropdownMenu.Content align="end">
            {!savedMode && <DropdownMenu.Item
              icon={<Pencil className="size-4" />}
              onClick={() => {
                setRename(snapshot.session);
                setRenameValue(snapshot.title);
              }}
            >
              {v("Rename {mission}")}
            </DropdownMenu.Item>}
            {!savedMode && <DropdownMenu.Item
              disabled={!canExport || workspace.busy}
              icon={<Sparkles className="size-4" />}
              onClick={() =>
                void workspace.perform(
                  () => controlConsoleSession(snapshot.session.id, "title/regenerate"),
                  snapshot.session.id,
                )
              }
            >
              Regenerate title
            </DropdownMenu.Item>}
            <DropdownMenu.Item
              disabled={!canExport}
              icon={<Copy className="size-4" />}
              onClick={() => void openExport(snapshot.session.id, savedMode, true)}
            >
              {v("Copy {mission}")}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={!canExport}
              icon={<Download className="size-4" />}
              onClick={() => void openExport(snapshot.session.id, savedMode, false)}
            >
              Export
            </DropdownMenu.Item>
            {!savedMode && <DropdownMenu.Item
              disabled={!canExport}
              icon={<Eraser className="size-4" />}
              onClick={() => setConfirm({ kind: "clear", id: snapshot.session.id, title: snapshot.title })}
            >
              {v("Clear {mission}")}
            </DropdownMenu.Item>}
            {!savedMode && <DropdownMenu.Item
              icon={<X className="size-4" />}
              onClick={() => setConfirm({ kind: "close", id: snapshot.session.id, title: snapshot.title })}
            >
              {v("Close {mission}")}
            </DropdownMenu.Item>}
            <DropdownMenu.Item
              variant="danger"
              icon={<Trash2 className="size-4" />}
              onClick={() => setConfirm({ kind: savedMode ? "delete" : "delete-live", id: snapshot.session.id, title: snapshot.title })}
            >
              {v("Delete {mission}")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
      {snapshot && <RightPanelToggle />}
    </div>
  );

  const chatContent = (
    <section
      ref={setChatElement}
      data-console-resource={sessionId ? chatResourceKey({ backendId: client.backendId, id: sessionId }) : undefined}
      data-console-session={sessionId}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {snapshot?.focusedFinding && (
        <Disclosure
          key={snapshot.focusedFinding.id}
          className="shrink-0 bg-muted/10 px-4 py-3 text-xs"
          defaultOpen={search.get("intent") === "impact"}
          summary={
            <>
              {snapshot.focusedFinding.title} · {snapshot.focusedFinding.severity}
            </>
          }
          triggerClassName="cursor-pointer font-medium"
        >
          <div className="max-h-64 space-y-3 overflow-auto pt-3">
            <p className="whitespace-pre-wrap">{snapshot.focusedFinding.description}</p>
            <div>
              <div className="font-medium">Impact</div>
              {snapshot.focusedFinding.impactAssessment ? (
                <pre className="mt-2 whitespace-pre-wrap break-words">
                  {JSON.stringify(snapshot.focusedFinding.impactAssessment, null, 2)}
                </pre>
              ) : (
                <p className="mt-1 text-muted-foreground">Not assessed yet.</p>
              )}
            </div>
            <Button size="sm" variant="outline" render={<Link to={`/fix${controlsQuery}&finding=${encodeURIComponent(snapshot.focusedFinding.id)}`} />}>
              Prepare a fix
            </Button>
          </div>
        </Disclosure>
      )}
      {(recoveringSession && !snapshot) || workspace.loading || (!sessionId && !workspace.error && !readOnlyTeam) ? (
        <ConversationSkeleton />
      ) : snapshot ? (
        <Conversation
          onSubmitRoot={() => void submit(true)}
          onStopRoot={() => void workspace.perform(() => controlConsoleSession(snapshot.session.id, "cancel"))}
          onDrainAgents={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })}
          onOpenDetails={() => openPanelView("overview")}
          onSelectWorker={selectWorker}
          sendBehavior={mode}
          workspace={workspace}
          worker={undefined}
          onSubmit={() => void submit(true)}
          onStop={() => void workspace.perform(() => controlConsoleSession(snapshot.session.id, "cancel"))}
          onResolve={(id, response) =>
            void workspace.perform(() => resolveConsoleDecision(snapshot.session.id, id, response))
          }
          resumeCap={() => setCapOpen(true)}
        />
      ) : (
        <div className="ui-surface-enter grid flex-1 place-items-center overflow-auto p-6">
          <div className="max-w-xl text-center">
            <BrandMark className="mx-auto mb-6" />
            <h1 className="font-heading text-2xl font-medium">Hi! What do you want me to do?</h1>
            {sessionId && workspace.draft.trim() && (
              <p className="mt-3 text-sm text-muted-foreground">
                {v("Your draft is saved. Open History to choose a saved {mission}.")}
              </p>
            )}
            <div className="mt-6 flex justify-center gap-3">
              <NewChatButton
                variant="default"
                disabled={workspace.busy || readOnlyTeam}
                onClick={() => void createSession()}
              />
              <Button variant="ghost" onClick={() => setRailOpen(true)}>
                History
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );

  const pendingChatContent = (
    <section
      data-pending-chat={pendingChatSelection?.id}
      aria-label={pendingChatSelection ? `Opening ${pendingChatSelection.title}` : undefined}
      className="flex h-full min-h-0 flex-col"
    >
      <ConversationSkeleton />
    </section>
  );

  const bindChatNode = (node: ReactNode) => (
    <BackendApiContext value={scopedApi}>
      <QueryClientProvider client={queryClient}>
        <BackendSelectionContext value={backendRegistry}>
          <ChatHostSelectionScope
            backendId={client.backendId}
            reconnect={backendRegistry?.reconnect}
            onSelectHost={(host: string) => void createChatOnHost(host)}
          >
            {node}
          </ChatHostSelectionScope>
        </BackendSelectionContext>
      </QueryClientProvider>
    </BackendApiContext>
  );
  const stagePrompt = (text: string) => {
    workspace.setRootDraft(text);
    if (snapshot && !embedded && !savedMode) navigate(`/chats/${snapshot.session.id}`);
    setNotice("Added a draft message. Review it, then send.");
  };
  const appendPrompt = (text: string) => {
    const current = workspace.readDraft(true);
    workspace.setRootDraft(current && !current.endsWith("\n") ? `${current}\n${text}` : current + text);
    if (snapshot && !embedded && !savedMode) navigate(`/chats/${snapshot.session.id}`);
  };
  const ownViews: DockViews = {
    snapshot: snapshot ?? undefined,
    sessionId,
    backendId: client.backendId,
    busy: workspace.busy,
    title: snapshot?.title,
    counts: panelData.counts,
    agents: panelData.agents,
    scope: {
      bind: bindChatNode,
      findingActions: { onAddFinding, fixes: panelData.fixes },
      agentActions: {
        onStopAll: snapshot
          ? () => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })
          : undefined,
        onStopWorker: snapshot
          ? (id) => void workspace.perform(() => stopConsoleWorker(snapshot.session.id, id))
          : undefined,
        renderComposer: snapshot
          ? (item) =>
              item.id === workerId ? (
                <Composer
                  canWrite={!readOnlyTeam}
                  sendBehavior={mode}
                  workspace={workspace}
                  snapshot={snapshot}
                  worker={item}
                  onSubmit={() => void submit()}
                  onStop={() => void workspace.perform(() => stopConsoleWorker(snapshot.session.id, item.id))}
                />
              ) : null
          : undefined,
      },
      harnessActions: {
        stagePrompt,
        appendPrompt,
        onHarness: snapshot
          ? (providerId, event) => {
              const generationId = snapshot.harness?.generationId;
              if (!generationId) {
                setNotice("Tools aren't ready yet.");
                return;
              }
              void workspace
                .perform(() =>
                  webFetchJson<{ snapshot: HarnessSnapshot; requestedPrompt?: string }>(
                    `/api/console/sessions/${encodeURIComponent(snapshot.session.id)}/harness`,
                    { method: "POST", body: JSON.stringify({ generationId, providerId, event }) },
                  ),
                )
                .then((result) => {
                  if (result?.requestedPrompt) stagePrompt(result.requestedPrompt);
                });
            }
          : undefined,
      },
    },
  };
  useEffect(() => {
    if (embeddedSessionId && onDockViewChange)
      onDockViewChange(chatResourceKey({ backendId: client.backendId, id: embeddedSessionId }), {
        actions: bindChatNode(chatActions),
        views: ownViews,
      });
  }, [
    embeddedSessionId,
    onDockViewChange,
    snapshot,
    workerId,
    mode,
    panelData,
    workspace.draft,
    workspace.busy,
    workspace.error,
    scopedApi,
    queryClient,
    backendRegistry,
  ]);
  const historySlot = useSidebarHistory();
  const ownerView = activeChatId ? embeddedViews[activeChatId] : undefined;
  return (
    <ChatHostSelectionScope
      backendId={client.backendId}
      reconnect={backendRegistry?.reconnect}
      onSelectHost={(host: string) => void createChatOnHost(host)}
    >
      {embedded ? (
        chatContent
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {historySlot ? (
            createPortal(rail, historySlot)
          ) : (
            <aside ref={sessionRailElement} className="hidden w-64 shrink-0 lg:block">
              {rail}
            </aside>
          )}
          <DockWorkspace
            primarySessionId={sessionId}
            primaryBackendId={client.backendId}
            persistenceKey={dockPersistenceKey}
            legacyPersistenceKey={dockLegacyKey}
            restoreReady
            chatIdRemap={dockRemap.current.ids}
            onRestoreLayoutState={restoreDockState}
            primaryTitle={
              pendingPrimary
                ? pendingChatSelection!.title
                : snapshot?.messages.some((message) => message.role === "user" || message.role === "assistant")
                  ? snapshot.title || v("{Mission}")
                  : v("New {mission}")
            }
            primaryClosable={Boolean(
              snapshot?.messages.some((message) => message.role === "user" || message.role === "assistant"),
            )}
            onClosePrimary={(replacement) => {
              showPendingChat(null);
              if (replacement)
                routeNavigate(backendRouteHref(replacement.backendId, `/chats/${encodeURIComponent(replacement.id)}`));
              else navigate(`/chats?new=1&host=${encodeURIComponent(client.backendId)}`);
            }}
            chat={pendingPrimary ? pendingChatContent : chatContent}
            actions={pendingPrimary ? undefined : chatActions}
            views={ownerView?.views ?? ownViews}
            onViewControls={setPanelControls}
            onVisibleAgentChange={setVisibleAgentId}
            extraChats={dockChatsForRender({
              sessionsLoaded: workspace.sessionsLoaded,
              reconciled: dockChatState.chats,
              persisted: persistedDockChats,
            }).map((item) => {
              const backendId = item.backendId ?? client.backendId,
                key = chatResourceKey({ backendId, id: item.id });
              return {
                ...item,
                backendId,
                title: pendingChatSelection?.paneKey === key ? pendingChatSelection.title : item.title,
                actions: pendingChatSelection?.paneKey === key ? undefined : embeddedViews[key]?.actions,
                content:
                  pendingChatSelection?.paneKey === key ? (
                    pendingChatContent
                  ) : (
                    <ConsolePage
                      embeddedSessionId={item.id}
                      embeddedBackendId={backendId}
                      panelWorkerId={activeChatId === key ? visibleAgentId : null}
                      onOpenView={openPanelView}
                      onOpenDockChat={openDockChat}
                      onDockViewChange={updateEmbeddedView}
                      onCloseDockChat={closeDockChat}
                      onDockRosterChange={updateHostRoster}
                      onDockSessionResolved={resolveDockSession}
                    />
                  ),
              };
            })}
            activeChatId={activeChatId}
            onActiveChatChange={(id) => {
              showPendingChat(null);
              setActiveChatId(id);
            }}
            onOpenChat={(id, title, saved, backendId = client.backendId, onResolved) => {
              if (!saved) {
                openDockChat(id, title, backendId);
                return;
              }
              void runOnHost(backendId, (api) => api.resumeConsoleSession(id, {}))
                .then((created) => {
                  onResolved?.({ backendId, id: created.id });
                  if (backendId === client.backendId)
                    queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], (previous) => [
                      ...(previous ?? []).filter((item) => item.id !== created.id),
                      created,
                    ]);
                  else
                    setHostRosters((previous) => ({
                      ...previous,
                      [backendId]: [...(previous[backendId] ?? []).filter((item) => item.id !== created.id), created],
                    }));
                  openDockChat(created.id, created.title || title, backendId);
                })
                .catch((error) => {
                  if (!isRequestCancellation(error))
                    setNotice(error instanceof Error ? error.message : v("Couldn't resume that {mission}."));
                });
            }}
            onCloseChat={closeDockChat}
          />
        </div>
      )}
      <Sheet open={railOpen} onOpenChange={setRailOpen}>
        <SheetContent side="left" className="flex w-80 flex-col bg-background p-0">
          <SheetHeader className=" px-4 py-4 pr-12">
            <SheetTitle>{v("{Missions}")}</SheetTitle>
            <SheetDescription className="sr-only">{v("Current and past {missions}")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{rail}</div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(rename)}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{v("Rename {mission}")}</DialogTitle>
            <DialogDescription className="sr-only">Choose a new name.</DialogDescription>
            {dialogError}
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rename || !renameValue.trim()) return;
              void workspace
                .perform(() => configureConsoleSession(rename.id, { title: renameValue.trim() }), rename.id)
                .then((result) => {
                  if (result) setRename(null);
                });
            }}
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={200}
              aria-label={v("{Mission} name")}
            />
            <Button disabled={!renameValue.trim() || workspace.busy}>Save</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "delete-live"
                ? v("Delete this {mission}?")
                : confirm?.kind === "delete"
                  ? v("Delete this {mission}?")
                  : confirm?.kind === "clear"
                    ? v("Clear this {mission}?")
                    : confirm?.kind === "drain"
                      ? "Stop all sub-agents?"
                      : v("Close this {mission}?")}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "delete-live"
                ? "This stops it and permanently deletes its history. This can't be undone."
                : confirm?.kind === "delete"
                  ? "This permanently deletes its history. This can't be undone."
                  : confirm?.kind === "clear"
                    ? "0 forgets the messages so far. Permissions stay the same."
                    : confirm?.kind === "drain"
                      ? v("The {mission} stays open.")
                      : "This stops any running work. You can resume it later from history."}
            </DialogDescription>
            {dialogError}
          </DialogHeader>
          <p className="text-sm font-medium">{confirm?.title}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={workspace.busy}
              onClick={() => {
                if (!confirm) return;
                const action = confirm;
                void workspace
                  .perform(async () => {
                    if (action.kind === "delete-live") return deleteConsoleSession(action.id);
                    if (action.kind === "delete") return deleteSavedConsoleSession(action.id);
                    if (action.kind === "close") return closeConsoleSession(action.id);
                    return controlConsoleSession(action.id, action.kind === "drain" ? "workers/stop" : "clear");
                  }, action.id)
                  .then((result) => {
                    if (!result) return;
                    setConfirm(null);
                    if (action.kind === "clear") workspace.setRootDraft("");
                    if (action.kind === "delete" && savedMode && sessionId === action.id) {
                      workspace.forgetDrafts(action.id);
                      navigate("/chats", { replace: true });
                    }
                    if (action.kind === "delete-live") {
                      workspace.forgetDrafts(action.id);
                      if (sessionId === action.id) {
                        if (embedded)
                          onCloseDockChat?.(chatResourceKey({ backendId: client.backendId, id: action.id }));
                        else {
                          setActiveSession(null);
                          navigate("/chats", { replace: true });
                        }
                      }
                    }
                  });
              }}
            >
              {confirm?.kind === "delete-live" || confirm?.kind === "delete"
                ? "Delete"
                : confirm?.kind === "clear"
                  ? "Clear"
                  : confirm?.kind === "drain"
                    ? "Stop"
                    : "Close"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(exported)}
        onOpenChange={(open) => {
          if (!open) setExported(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {exportKind === "worker" ? v("Export sub-agent {mission}") : v("Export {mission}")}
            </DialogTitle>
            <DialogDescription>May contain sensitive data. Check before sharing.</DialogDescription>
            {dialogError}
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (!exported) return;
                void navigator.clipboard.writeText(exported.text).then(
                  () => setCopyStatus("Copied"),
                  () => setCopyStatus("Couldn't copy. Select the text below or download it."),
                );
              }}
            >
              <Copy className="size-3" />
              Copy
            </Button>
            <Button variant="outline" size="sm" onClick={() => download("json")}>
              <Download className="size-3" />
              JSON
            </Button>
            <Button variant="outline" size="sm" onClick={() => download("txt")}>
              <Download className="size-3" />
              Text
            </Button>
          </div>
          {copyStatus && (
            <p role="status" className="text-xs text-muted-foreground">
              {copyStatus}
            </p>
          )}
          <Textarea
            className="h-[45dvh] w-full resize-none rounded-[var(--radius-control)] border border-border bg-muted/20 p-3 font-mono text-xs leading-5"
            readOnly
            value={exported?.text ?? ""}
            aria-label={v("{Mission} text")}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={capOpen} onOpenChange={setCapOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep going</DialogTitle>
            <DialogDescription>0 hit its output limit. Tell it what's left to do.</DialogDescription>
            {dialogError}
          </DialogHeader>
          <Textarea
            className="min-h-28 rounded-[var(--radius-control)] border border-border bg-background p-3 text-sm"
            value={continuation}
            onChange={(event) => setContinuation(event.target.value)}
            aria-label="What's left to do"
          />
          <Button
            disabled={workspace.busy || !continuation.trim() || Boolean(active)}
            onClick={() => {
              if (!sessionId) return;
              void workspace
                .perform(() =>
                  webFetchJson<{ session: DesktopConsoleSession }>(
                    `/api/console/sessions/${encodeURIComponent(sessionId)}/continue`,
                    { method: "POST", body: JSON.stringify({ text: continuation.trim() }) },
                  ),
                )
                .then((result) => {
                  if (result) setCapOpen(false);
                });
            }}
          >
            Continue
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(feedback?.previewId)}
        onOpenChange={(open) => {
          if (!open) {
            void workspace.perform(() =>
              webFetchJson<FeedbackResult>("/api/console/feedback", {
                method: "POST",
                body: JSON.stringify({ action: "cancel" }),
              }),
            );
            setFeedback(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Send feedback?</DialogTitle>
            <DialogDescription>Nothing has been sent yet. This is exactly what will be sent.</DialogDescription>
            {dialogError}
          </DialogHeader>
          <pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(feedback?.preview, null, 2)}
          </pre>
          <Button
            disabled={workspace.busy}
            onClick={() => {
              if (!feedback?.previewId) return;
              void workspace
                .perform(() =>
                  webFetchJson<FeedbackResult>("/api/console/feedback", {
                    method: "POST",
                    body: JSON.stringify({ action: "send", previewId: feedback.previewId }),
                  }),
                )
                .then((result) => {
                  if (result) {
                    setFeedback(null);
                    setNotice(
                      result.error ?? (result.submitted ? "Feedback sent. Thank you!" : "Feedback wasn't sent."),
                    );
                  }
                });
            }}
          >
            Send feedback
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Commands</DialogTitle>
            <DialogDescription>Type / in the message box to use these.</DialogDescription>
            {dialogError}
          </DialogHeader>
          <div className="space-y-2">
            {SLASH_COMMANDS.map((command) => (
              <Button
                variant="outline"
                key={command.name}
                className="h-auto w-full flex-col items-start whitespace-normal p-3 text-left"
                onClick={() => {
                  workspace.setDraft(
                    `/${command.name}${command.name === "feedback" || command.name === "explain" ? " " : ""}`,
                  );
                  setHelpOpen(false);
                }}
              >
                <span className="font-mono text-xs">/{command.name}</span>
                <span className="mt-1 text-xs leading-5 text-muted-foreground">{command.description}</span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </ChatHostSelectionScope>
  );
}
