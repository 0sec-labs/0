import { NewChatButton } from "@/components/new-chat-button";
import { dockWorkspaceStorageKey } from "@/console/dock-chat-state";
import { ChatDetailsPopover } from "@/console/chat-details-popover";
import { isRequestCancellation } from "@/lib/request-cancellation";
import { setWebTheme } from "@/lib/web-theme";
import { useAppNotice } from "@/components/app-notice";
import { staleSessionRecovery, type SessionAlias } from "@/console/session-recovery";
import { Textarea } from "@/components/ui/textarea";
import { createPortal } from "react-dom";
import { useSidebarHistory } from "@/components/sidebar-history";
import { openAppSearch } from "@/components/command-palette";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";
import { useQuery, useQueryClient, QueryClientProvider } from "@tanstack/react-query";
import { findCommand, SLASH_COMMANDS } from "@0/shared/dist/slash-commands.js";
import type { ConsoleSessionSnapshot, ConsolePublicExport, DesktopConsoleSession, HarnessSnapshot, ConsoleCreateSessionInput } from "@0/shared";
import { BackendDescriptorSchema, parseBackendHandshake } from "@0/shared/dist/backend-protocol.js";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared/dist/desktop-console.js";
import { Copy, Download, Menu, MoreHorizontal, Info, Square, Trash2, Pencil, Eraser, X, Users, Globe } from "lucide-react";
import { createBackendApi, localControlFetch, useBackendApi } from "@/api";
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
import { consoleErrorMessage, needsProviderSignIn, needsModelSourceReconnect } from "@/console/provider-error";
import { TeamCollaboration } from "@/console/team-collaboration";
import { AgentsPanel } from "@/console/agents-panel";
import { BrowserPreviews } from "@/console/browser-previews";
import { DockWorkspace, type DockPanelId } from "@/console/dock-workspace";
import { reconcileDockChatState } from "@/console/dock-chat-state";
import { Conversation, Composer } from "@/console/conversation";

import { ConsoleInspector } from "@/console/inspector";
import { ConsoleSessionRail } from "@/console/session-rail";
import { addFindingToDraft } from "@/console/finding-context";
import type { FindingRecord } from "@/types";
import { consoleSnapshotKey, useConsoleWorkspace } from "@/console/use-console-workspace";
import type { SettingsResponse } from "@/components/console-control/contracts";

interface FeedbackResult { saved: boolean; path?: string; submitted: boolean; previewId?: string; preview?: { url: string; body: unknown; headers: unknown; warnings: string[] }; error?: string }
type ConfirmAction = { kind: "close" | "clear" | "delete" | "delete-live" | "drain"; id: string; title: string };

type EmbeddedDockView = { actions: ReactNode; panels: Record<DockPanelId, ReactNode>; activePanel: DockPanelId | null; select: (panel:DockPanelId|null)=>void };
interface ConsolePageProps {
  embeddedSessionId?:string; embeddedBackendId?:string;
  onOpenDockChat?:(id:string,title:string,backendId?:string)=>void;
  onCloseDockChat?:(key:string)=>void;
  onDockViewChange?:(key:string,view:EmbeddedDockView)=>void;
  onDockRosterChange?:(backendId:string,sessions:DesktopConsoleSession[])=>void;
  onDockSessionResolved?:(backendId:string,oldId:string,session:DesktopConsoleSession)=>void;
}
export function ConsolePage(props:ConsolePageProps = {}) {
  const {client}=useBackendApi();
  const [query]=useSearchParams();
  const owner=useTeamAccess();
  const accountKey=`${owner.user?.workspaceId??"personal"}:${owner.user?.userId??"personal"}`;
  const backendId=props.embeddedBackendId ?? query.get("host") ?? client.backendId;
  return <ChatBackendScope key={`${backendId}:${accountKey}`} backendId={backendId}><ConsolePageContent {...props} /></ChatBackendScope>;
}
function ConsolePageContent({embeddedSessionId,embeddedBackendId,onOpenDockChat,onCloseDockChat,onDockViewChange,onDockRosterChange,onDockSessionResolved}:ConsolePageProps) {
  const scopedApi=useBackendApi();
  const { client, teamClient, archiveConsoleSession, closeConsoleSession, configureConsoleSession, controlConsoleSession, deleteConsoleSession, deleteSavedConsoleSession, exportConsoleSession, resolveConsoleDecision, resumeConsoleSession, stopConsoleWorker, webFetchJson, getConsoleSnapshot } = scopedApi;
  const queryClient=useQueryClient();
  const backendRegistry=useBackendSelection();
  const team = useTeamAccess();
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const sessionId = embeddedSessionId ?? routeSessionId;
  const embedded = Boolean(embeddedSessionId);
  const [search, setSearch] = useSearchParams();
  const routeNavigate=useNavigate();
  const navigate=useCallback(((to:To|number,options?:NavigateOptions)=>{
    if(typeof to === "number")return routeNavigate(to);
    if(typeof to === "string" && /^\/console(?:[/?#]|$)/.test(to)) {
      const owned=new URL(to,window.location.origin);owned.searchParams.set("host",client.backendId);
      return routeNavigate(`${owned.pathname}${owned.search}${owned.hash}`,options);
    }
    return routeNavigate(to,options);
  }) as NavigateFunction,[routeNavigate,client.backendId]);
  const [embeddedWorkerId,setEmbeddedWorkerId] = useState<string|null>(null);
  const workerId = embedded ? embeddedWorkerId : search.get("worker");
  const workspace = useConsoleWorkspace(sessionId, workerId);
  const [sessionAliases, setSessionAliases] = usePersistentState<Record<string, SessionAlias>>("0-console-session-aliases", {});
  const recoveryAttempt = useRef<string | null>(null);
  const [recoveringSession, setRecoveringSession] = useState(false);
  useEffect(() => {
    if (!workspace.sessionsLoaded) return;
    setSessionAliases(previous => {
      const next = { ...previous }; let changed = false;
      for (const session of workspace.sessions) {
        const alias = { savedId: session.savedId ?? session.id, messageCount: session.messageCount };
        if (next[session.id]?.savedId !== alias.savedId || next[session.id]?.messageCount !== alias.messageCount) { next[session.id] = alias; changed = true; }
      }
      return changed ? next : previous;
    });
  }, [workspace.sessionsLoaded, workspace.sessions, setSessionAliases]);
  useEffect(() => {
    if (!sessionId || !workspace.sessionsLoaded || !workspace.savedLoaded) return;
    const plan = staleSessionRecovery(sessionId, workspace.sessions, workspace.saved, sessionAliases);
    if (!plan) return;
    const key = `${client.backendId}:${sessionId}`;
    if (recoveryAttempt.current === key) return;
    recoveryAttempt.current = key;
    const recover = async () => {
      setRecoveringSession(true);
      try {
      let replacement = plan.kind === "live" ? workspace.sessions.find(session => session.id === plan.id) : undefined;
      if (!replacement && plan.kind === "saved") {
        if (readOnlyTeam) { if(!embedded) navigate(`/console/saved/${plan.id}`, { replace: true }); return; }
        replacement = await workspace.perform(() => resumeConsoleSession(plan.id, {}), sessionId);
      }
      if (!replacement && plan.kind === "blank" && !readOnlyTeam) replacement = await createOwnedSession({});
      if (!replacement) return;
      workspace.remapDrafts(sessionId, replacement.id);
      setSessionAliases(previous => ({ ...previous, [sessionId]: { savedId: plan.durableId, messageCount: replacement!.messageCount }, [replacement!.id]: { savedId: replacement!.savedId ?? plan.durableId, messageCount: replacement!.messageCount } }));
      workspace.dismissError();
      if(embedded) onDockSessionResolved?.(client.backendId,sessionId,replacement);
      else navigate(`/console/${replacement.id}${search.toString() ? `?${search}` : ""}`, { replace: true });
      } finally { setRecoveringSession(false); }
    };
    void recover();
  }, [embedded, sessionId, workspace.sessionsLoaded, workspace.savedLoaded, workspace.sessions, workspace.saved, sessionAliases, client.backendId, readOnlyTeam, navigate, resumeConsoleSession, search]);
  const dockLegacyKey = `0-console-dock-view:${sessionId ?? "new"}`;
  const durableSessionId = workspace.sessions.find(session => session.id === sessionId)?.savedId ?? (sessionId ? sessionAliases[sessionId]?.savedId : undefined) ?? sessionId;
  // Embedded views must never reconcile the root layout out of the shared store.
  const dockPersistenceKey = dockWorkspaceStorageKey({ backendId: client.backendId, embeddedSessionId, workspaceId: team.user?.workspaceId, userId: team.user?.userId });
  const [extraChatIds,setExtraChatIds] = usePersistentState<Array<{id:string;title:string;savedId?:string;backendId?:string}>>(`${dockPersistenceKey}:chats`, [], { legacyKey: `${dockLegacyKey}:chats` });
  const [activeChatId,setActiveChatId] = usePersistentState<string|null>(`${dockPersistenceKey}:active-chat`, null, { legacyKey: `${dockLegacyKey}:active-chat` });
  const [hostRosters,setHostRosters]=useState<Record<string,DesktopConsoleSession[]>>({});
  const [pendingChatSelection, setPendingChatSelection] = useState<(PendingChatSelection & { paneKey: string | null }) | null>(null);
  const pendingChatRef = useRef<typeof pendingChatSelection>(null);
  const pendingPrimary = pendingChatSelection?.paneKey === null;
  const showPendingChat = useCallback((selection: PendingChatSelection | null) => { const next = selection ? { ...selection, paneKey: activeChatId } : null; pendingChatRef.current = next; setPendingChatSelection(next); }, [activeChatId]);
  const isPendingChatCurrent = useCallback((selection: PendingChatSelection) => pendingChatRef.current?.id === selection.id && pendingChatRef.current?.backendId === selection.backendId, []);
  useEffect(() => { pendingChatRef.current = null; setPendingChatSelection(null); }, [sessionId, client.backendId]);
  // Only tab reconciliation sees these references; they grant no chat capabilities.
  const [openingChats, setOpeningChats] = useState<Record<string, { backendId: string; session: DesktopConsoleSession }>>({});
  const pendingHostRemaps=useRef<Record<string,string|null>>({});
  const updateHostRoster=useCallback((backendId:string,sessions:DesktopConsoleSession[])=>setHostRosters(previous=>JSON.stringify(previous[backendId])===JSON.stringify(sessions)?previous:{...previous,[backendId]:sessions}),[]);
  const resolveDockSession=useCallback((backendId:string,oldId:string,session:DesktopConsoleSession)=>{
    const oldKey=chatResourceKey({backendId,id:oldId}),newKey=chatResourceKey({backendId,id:session.id});
    pendingHostRemaps.current[oldKey]=newKey;
    setHostRosters(previous=>({...previous,[backendId]:[...(previous[backendId]??[]).filter(item=>item.id!==oldId && item.id!==session.id),session]}));
    setExtraChatIds(previous=>previous.map(item=>{const ref=parseChatResourceKey(item.id,item.backendId??client.backendId);return ref && chatResourceKey(ref)===oldKey?{id:session.id,backendId,title:session.title||item.title,savedId:session.savedId}:item;}));
    setActiveChatId(previous=>previous===oldKey?newKey:previous);
  },[client.backendId,setExtraChatIds,setActiveChatId]);
  const [embeddedViews,setEmbeddedViews] = useState<Record<string,EmbeddedDockView>>({});
  const updateEmbeddedView = useCallback((id:string,view:EmbeddedDockView)=>setEmbeddedViews(current=>({...current,[id]:view})),[]);
  const closeDockChat = (id:string) => { if (pendingChatRef.current?.paneKey === id) showPendingChat(null); setExtraChatIds(current=>current.filter(item=>chatResourceKey({backendId:item.backendId??client.backendId,id:item.id})!==id)); setActiveChatId(current=>current===id?null:current);setEmbeddedViews(previous=>{const next={...previous};delete next[id];return next;}); };
  const openDockChat = (id:string,title:string,backendId=client.backendId) => {
    const key=chatResourceKey({backendId,id});
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-console-resource="${CSS.escape(key)}"] textarea[aria-autocomplete="list"]:not(:disabled)`)?.focus({preventScroll:true})));
    if (onOpenDockChat) { onOpenDockChat(id,title,backendId); return; }
    if(!routeSessionId && backendId===client.backendId){const next=new URLSearchParams(search);next.delete("new");next.set("host",backendId);navigate(`/console/${id}?${next}`);return;}
    if (id===routeSessionId && backendId===client.backendId) {setActiveChatId(null);return;}
    const insert=(savedId?:string)=>{setExtraChatIds(current=>current.some(item=>item.id===id && (item.backendId??client.backendId)===backendId)?current:[...current,{id,title,backendId,savedId}]);setActiveChatId(key);};
    const snapshotKey = consoleSnapshotKey(backendId, id, team.user?.workspaceId, team.user?.userId);
    const cached = backendId === client.backendId ? queryClient.getQueryData<ConsoleSessionSnapshot>(snapshotKey) : undefined;
    const known=(backendId===client.backendId?workspace.sessions:hostRosters[backendId])?.find(session=>session.id===id) ?? cached?.session;
    if (!known) {
      // Mount the selected view now, retaining its tab until background validation
      // supplies an authoritative roster entry. Never wait for a host handshake here.
      const session: DesktopConsoleSession = { id, title, target: "", role: "audit", autonomyMode: DEFAULT_AUTONOMY_MODE, status: "ready", scopeConfigured: false, localScopeConfigured: false, createdAt: "", updatedAt: "" };
      setOpeningChats(previous => ({ ...previous, [key]: { backendId, session } }));
      insert();
      const verify = backendId === client.backendId
        ? queryClient.fetchQuery({ queryKey: snapshotKey, queryFn: ({ signal }) => getConsoleSnapshot(id, signal), staleTime: 1000, gcTime: 300_000 })
        : runOnHost(backendId, api => api.getConsoleSnapshot(id));
      void verify.then(value => {
        if (backendId === client.backendId) queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], previous => [...(previous ?? []).filter(item => item.id !== id), value.session]);
        else setHostRosters(previous => ({ ...previous, [backendId]: [...(previous[backendId] ?? []).filter(item => item.id !== id), value.session] }));
      }).catch(error => {
        if (isRequestCancellation(error)) return;
        setOpeningChats(previous => { const next = { ...previous }; delete next[key]; return next; });
        setNotice(error instanceof Error ? error.message : "Couldn't open that chat.");
      });
      return;
    }
    if (backendId === client.backendId && !workspace.sessions.some(item => item.id === id)) queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"], previous => [...(previous ?? []).filter(item => item.id !== id), known]);
    insert(known.savedId);
  };
  const replaceChatInPlace = (id: string, title: string, backendId = client.backendId) => {
    const key = chatResourceKey({ backendId, id });
    if (activeChatId && key !== chatResourceKey({ backendId: client.backendId, id: sessionId ?? "" })) {
      if (extraChatIds.some(item => chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) === key)) { setActiveChatId(key); return; }
      const old = activeChatId;
      pendingHostRemaps.current[old] = key;
      setExtraChatIds(items => items.map(item => chatResourceKey({ backendId: item.backendId ?? client.backendId, id: item.id }) === old ? { id, title, backendId } : item));
      setActiveChatId(key);
      return;
    }
    setActiveChatId(null);
    routeNavigate(backendRouteHref(backendId, `/console/${encodeURIComponent(id)}`));
  };
  const runOnHost = async <T,>(backendId:string,action:(api:ReturnType<typeof createBackendApi>)=>Promise<T>):Promise<T> => {
    if(backendId===client.backendId)return action(scopedApi);
    let descriptor=backendRegistry?.backends.find(item=>item.id===backendId);
    if(backendId!=="local"){
      if(!descriptor)throw new Error("Host is no longer registered.");
      const response=await localControlFetch(`/api/backends/${encodeURIComponent(backendId)}/handshake`,{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`Host connection returned ${response.status}.`);
      const value=await response.json() as {backend?:unknown;handshake?:unknown;error?:string};
      const owner=BackendDescriptorSchema.parse(value.backend);
      if(owner.id!==backendId || owner.status!=="connected" || !value.handshake)throw new Error(value.error || owner.error || "Host is disconnected.");
      const handshake=parseBackendHandshake(value.handshake);
      descriptor={...owner,protocolVersion:handshake.protocolVersion,capabilities:handshake.capabilities,platform:handshake.platform};
    }
    const scoped=createBackendApi(backendId,descriptor);
    try{return await action(scoped);}finally{scoped.client.dispose();}
  };
  const createOwnedSession=(configuration:ConsoleCreateSessionInput)=>workspace.perform(()=>createChatOnExecutionHost(client.backendId,configuration),undefined);
  const createChatOnHost = async(backendId:string) => {
    if(backendId===client.backendId){await createSession();return;}
    try {const created=await createChatOnExecutionHost(backendId,{title:"New chat",role:"audit",autonomyMode:DEFAULT_AUTONOMY_MODE});setHostRosters(previous=>({...previous,[backendId]:[...(previous[backendId]??[]).filter(item=>item.id!==created.id),created]}));onDockSessionResolved?.(backendId,created.id,created);replaceChatInPlace(created.id,created.title||"New chat",backendId);}
    catch(error){if (isRequestCancellation(error)) return;setNotice(error instanceof Error?error.message:"Couldn't open a chat on that computer.");}
  };
  const settingsQuery = useQuery({ queryKey: ["console-settings", client.backendId, team.user?.workspaceId, team.user?.userId], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }), refetchInterval: 5000 });
  useEffect(() => {
    setOpeningChats(previous => {
      const retained = Object.entries(previous).filter(([, opening]) => !(opening.backendId === client.backendId ? workspace.sessions : hostRosters[opening.backendId])?.some(item => item.id === opening.session.id));
      return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained);
    });
  }, [workspace.sessions, hostRosters, client.backendId]);
  const dockChatState = useMemo(() => {
    const sessions = [...workspace.sessions];
    const sessionsByBackend = { ...hostRosters };
    for (const opening of Object.values(openingChats)) {
      const roster = opening.backendId === client.backendId ? sessions : sessionsByBackend[opening.backendId] = [...(sessionsByBackend[opening.backendId] ?? [])];
      if (!roster.some(item => item.id === opening.session.id)) roster.push(opening.session);
    }
    return reconcileDockChatState({ chats: extraChatIds, activeChatId, sessions, primarySessionId: sessionId, defaultBackendId: client.backendId, primaryBackendId: client.backendId, sessionsByBackend });
  }, [extraChatIds, activeChatId, workspace.sessions, sessionId, client.backendId, hostRosters, openingChats]);
  const dockRemap = useRef<{key: string; ids: Record<string,string|null>}>({ key: dockPersistenceKey, ids: {} });
  if (dockRemap.current.key !== dockPersistenceKey) dockRemap.current = { key: dockPersistenceKey, ids: {} };
  Object.assign(dockRemap.current.ids, dockChatState.chatIdRemap,pendingHostRemaps.current);
  const dockChatsNormalized = JSON.stringify(extraChatIds) === JSON.stringify(dockChatState.chats) && activeChatId === dockChatState.activeChatId;
  useEffect(() => {
    if (!workspace.sessionsLoaded || dockChatsNormalized) return;
    setExtraChatIds(dockChatState.chats);
    setActiveChatId(dockChatState.activeChatId);
  }, [workspace.sessionsLoaded, dockChatsNormalized, dockChatState, setExtraChatIds, setActiveChatId]);
  useEffect(()=>{
    if(!embedded || !workspace.sessionsLoaded || !workspace.savedLoaded || !onDockRosterChange) return;
    if(sessionId && staleSessionRecovery(sessionId,workspace.sessions,workspace.saved,sessionAliases)) return;
    onDockRosterChange(client.backendId,workspace.sessions);
  },[embedded,workspace.sessionsLoaded,workspace.savedLoaded,workspace.sessions,workspace.saved,onDockRosterChange,client.backendId,sessionId,sessionAliases]);
  const snapshot = workspace.snapshot;
  const worker = snapshot?.workers.find((item) => item.id === workerId);
  const canExport = workerId
    ? Boolean(worker?.transcript.length || worker?.operatorMessages?.length)
    : Boolean(snapshot?.messages.some(message => message.content.length > 0));
  const [activeSession, setActiveSession] = usePersistentState<string | null>("0-console-active-session", null);
  const creatingSession = useRef(false);
  const sessionRailElement = useRef<HTMLElement>(null);
  const openingInitialChat = useRef(false);
  const requestedNewSession = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = usePersistentState(`${dockPersistenceKey}:agents`, false, { legacyKey: `${dockLegacyKey}:agents` });
  const [browserOpen, setBrowserOpen] = usePersistentState(`${dockPersistenceKey}:browser`, false, { legacyKey: `${dockLegacyKey}:browser` });
  const restoreDockState = useCallback((state: {openPanels: DockPanelId[]; activePanel: DockPanelId | null; activeChatId: string | null}) => {
    const selected = state.activePanel ?? state.openPanels[0] ?? null;
    setAgentsOpen(selected === "agents");
    setInspectOpen(selected === "details");
    setBrowserOpen(selected === "browser");
    setActiveChatId(state.activeChatId);
  }, [setAgentsOpen, setInspectOpen, setBrowserOpen, setActiveChatId]);
  const selectWorker = (id: string | null) => { if (embedded) { setEmbeddedWorkerId(id); setAgentsOpen(true); setInspectOpen(false); setBrowserOpen(false); return; } const next = new URLSearchParams(search); if (id) next.set("worker", id); else next.delete("worker"); setSearch(next); setAgentsOpen(true); setInspectOpen(false); setBrowserOpen(false); };
  const closeAgents = () => { if (embedded) { setEmbeddedWorkerId(null); setAgentsOpen(false); return; } const next = new URLSearchParams(search); next.delete("worker"); setSearch(next); setAgentsOpen(false); };
  useEffect(() => { if (workerId) setInspectOpen(false); }, [workerId]);
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
  const [continuation, setContinuation] = useState("Continue the remaining task from the preserved conversation and plan. Do not repeat completed work.");
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null);
  const staged = useRef(new Set<string>());
  const focused = useRef<string | null>(null);
  const findingId = embedded ? null : search.get("finding");
  const requestedIntent = embedded ? null : search.get("intent");
  const controlsQuery = sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}${workerId ? `?worker=${encodeURIComponent(workerId)}` : ""}`)}` : "?return=/console";
  const active = snapshot && ["working", "waiting"].includes(snapshot.session.status);
  const visibleError = !recoveringSession && workspace.error && !recoveredProviderError(workspace.error, workspace.connectionRecovery) && workspace.error !== snapshot?.lastOutcome?.error ? workspace.error : undefined;
  useAppNotice(embedded ? null : visibleError ? { id: `console:${sessionId}`, message: consoleErrorMessage(visibleError), kind: "error", onDismiss: () => { workspace.dismissError(); if (workspace.error) workspace.refresh(); setNotice(""); }, action: needsModelSourceReconnect(visibleError) && workspace.reconnectModelSource ? { label: workspace.modelSourceRecovery?.checking ? "Reconnecting…" : "Reconnect model source", onClick: () => void workspace.reconnectModelSource?.() } : needsProviderSignIn(visibleError) ? { label: "Manage connection", href: `/connections${controlsQuery}` } : undefined } : notice ? { id: `console:${sessionId}`, message: notice, kind: "status", onDismiss: () => setNotice("") } : null);
  const dialogError = workspace.error && <p role="alert" className="rounded-[var(--radius-control)] border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">{workspace.error}</p>;

  useEffect(() => {
    if (!snapshot?.todos?.todos.length || !wide) return;
    const key = snapshot.session.id;
    if (!observedPlans.current.has(key)) {
      observedPlans.current.add(key);
    }
  }, [snapshot?.session.id, snapshot?.todos, wide]);

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
  useEffect(() => {
    if (embedded) return;
    if (sessionId) setActiveSession(sessionId);
    else if (!findingId && search.get("new") !== "1" && activeSession && workspace.sessions.some((item) => item.id === activeSession && item.status !== "closed")) navigate(`/console/${activeSession}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: true });
  }, [sessionId, activeSession, workspace.sessions, findingId, navigate, setActiveSession, search]);
  // A conversation is blank until its first message; reuse one instead of piling up empty entries.
  const isBlankSession = (item: DesktopConsoleSession) => {
    const live = snapshot?.session.id === item.id ? snapshot : undefined;
    const session = live?.session ?? item;
    if (session.status !== "ready" || session.messageCount !== 0) return false;
    return !live || (live.messages.length === 0 && live.queuedMessages.length === 0 && !live.stagedPrompt && !live.events.some((event) => event.type === "user"));
  };
  const findBlankSession = () => team.enabled ? undefined : workspace.sessions.find((item) => isBlankSession(item) && !item.target && (!item.title || /^(new chat|new conversation|new session)$/i.test(item.title)));
  const createSession = async () => {
    if (readOnlyTeam) { const available = workspace.sessions.find(item => item.status !== "closed"); if (available) openDockChat(available.id,available.title || "Chat"); return; }
    if (creatingSession.current) return;
    setRailOpen(false);
    const blank = findBlankSession();
    if (blank) {
      if (blank.id !== sessionId) replaceChatInPlace(blank.id,blank.title || "New chat");
      else if (!embedded) { setActiveChatId(null); if (search.get("new") === "1") navigate(`/console/${blank.id}`, { replace:true }); }
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-console-session="${CSS.escape(blank.id)}"] textarea[aria-autocomplete="list"]`)?.focus());
      return;
    }
    creatingSession.current = true;
    try {
      const created = await createOwnedSession({ title: "New chat", role: "audit", autonomyMode: DEFAULT_AUTONOMY_MODE });
      if (created) { queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"],previous=>[...(previous??[]).filter(item=>item.id!==created.id),created]);onDockSessionResolved?.(client.backendId,created.id,created);replaceChatInPlace(created.id,created.title || "New chat"); }
    } finally { creatingSession.current = false; }
  };
  useEffect(() => {
    if (embedded || sessionId || findingId || search.get("new") === "1" || !workspace.sessionsLoaded || openingInitialChat.current) return;
    openingInitialChat.current = true;
    const existing = workspace.sessions.find(item => item.id === activeSession && item.status !== "closed");
    if (existing) navigate(`/console/${existing.id}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: true });
    else void createSession();
  }, [sessionId, findingId, search, workspace.sessionsLoaded, activeSession]);
  useEffect(() => {
    if (embedded || search.get("search") !== "1" || !sessionId) return;
    openAppSearch("chats");
    const next = new URLSearchParams(search); next.delete("search"); setSearch(next, { replace: true });
  }, [sessionId, search, setSearch]);
  useEffect(() => {
    if (embedded) return;
    if (search.get("new") !== "1") { requestedNewSession.current = false; return; }
    if (requestedNewSession.current || !workspace.sessionsLoaded) return;
    requestedNewSession.current = true;
    void createSession();
  }, [search, workspace.sessionsLoaded]);
  useEffect(() => {
    if (!findingId) { focused.current = null; return; }
    const requestKey = `${findingId}:${requestedIntent ?? "investigate"}`;
    if (focused.current === requestKey) return;
    focused.current = requestKey;
    const findingIntent = requestedIntent === "verify" || requestedIntent === "draft_fix" || requestedIntent === "impact" ? requestedIntent : "investigate";
    void createOwnedSession({ findingId, findingIntent }).then((created) => {
      if (created && focused.current === requestKey) navigate(`/console/${created.id}${findingIntent === "impact" ? "?intent=impact" : ""}`, { replace: true });
    });
  }, [findingId, requestedIntent]);
  useEffect(() => {
    if (workerId || !snapshot?.stagedPrompt || staged.current.has(snapshot.session.id)) return;
    staged.current.add(snapshot.session.id);
    if (!workspace.draft) workspace.setDraft(snapshot.stagedPrompt);
  }, [snapshot?.session.id, snapshot?.stagedPrompt, workerId]);

  const openExport = async (id: string, saved = false, copy = false, addressedWorker?: string) => {
    const result = await workspace.perform(() => exportConsoleSession(id, saved, addressedWorker), id);
    if (!result) return;
    setExported(result);
    setExportKind(addressedWorker ? "worker" : "root");
    setCopyStatus("");
    if (copy) {
      try { await navigator.clipboard.writeText(result.text); setCopyStatus("Copied"); }
      catch { setCopyStatus("Couldn't copy. Select the text below or download it."); }
    }
  };
  const download = (format: "json" | "txt") => {
    if (!exported) return;
    const blob = new Blob([format === "json" ? JSON.stringify(exported.messages, null, 2) : exported.text], { type: format === "json" ? "application/json" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `0-conversation-${sessionId ?? "saved"}.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const submit = async (forceRoot = false) => {
    const messageWorkerId = forceRoot ? null : workerId;
    const messageWorkspace = forceRoot ? { ...workspace, draft: workspace.rootDraft, attachments: workspace.rootAttachments, setDraft: workspace.setRootDraft, setAttachments: workspace.setRootAttachments } : workspace;
    const text = messageWorkspace.draft.trim();
    if ((!text && !messageWorkspace.attachments.length) || messageWorkspace.busy) return;
    if (messageWorkerId && messageWorkspace.attachments.length) { setNotice("Attachments are available in the main conversation."); return; }
    setNotice("");
    if (text.length > 32000) { setNotice("Message is too long (max 32,000 characters)."); return; }
    const command = findCommand(text);
    if (command.isSlash && !messageWorkspace.attachments.length) {
      if (command.isUnknown) { setNotice(`Unknown command /${command.rawName}. Type /help to see commands.`); return; }
      const destinations: Record<string, string> = { onboard: "/onboarding", capabilities: "/tools", tools: "/tools", settings: "/settings", keybindings: "/settings", theme: "/settings", connect: "/connections", model: "/models", history: "/runs", findings: "/findings", launcher: "/audits", ops: "/dashboard", skills: "/skills", hackstore: "/plugins", scope: "/project", doctor: "/doctor", fix: "/fix" };
      const name = command.command!;
      if (messageWorkerId && (name === "clear" || name === "exit")) { setNotice(`Switch back to the main conversation to use /${name}.`); return; }
      if (name === "help") { setHelpOpen(true); messageWorkspace.setDraft(""); return; }
      if (name === "new-chat") { void createSession(); return; }
      if (name === "sessions") { setRailOpen(true); messageWorkspace.setDraft(""); return; }
      if (name === "status" || name === "usage") { setInspectOpen(true); messageWorkspace.setDraft(""); return; }
      if (name === "chat") { if(embedded) closeAgents(); else navigate(sessionId ? `/console/${sessionId}` : "/console"); messageWorkspace.setDraft(""); return; }
      if (name === "back") { messageWorkspace.setDraft(""); navigate(-1); return; }
      if (name === "copy") { if (sessionId) { await openExport(sessionId, false, true, messageWorkerId ?? undefined); messageWorkspace.setDraft(""); } return; }
      if (name === "clear" || name === "exit") { if (sessionId) setConfirm({ kind: name === "clear" ? "clear" : "close", id: sessionId, title: snapshot?.title ?? "this conversation" }); return; }
      if (name === "model" && command.args && sessionId) { const result = await messageWorkspace.perform(() => configureChatRuntime(scopedApi,sessionId,{model:command.args},snapshot?.runtime)); if (result) messageWorkspace.setDraft(""); return; }
      if (name === "theme" && command.args) {
        const appearance = command.args.trim().toLowerCase();
        if (appearance !== "light" && appearance !== "dark") { setNotice("Use /theme light or /theme dark for browser appearance."); return; }
        setWebTheme(appearance);
        messageWorkspace.setDraft("");
        setNotice(`Web appearance set to ${appearance}.`);
        return;
      }
      if (name === "feedback") {
        if (command.args === "cancel") { const result = await messageWorkspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "cancel" }) })); if (result) { setFeedback(null); messageWorkspace.setDraft(""); setNotice("Feedback cancelled."); } return; }
        if (command.args === "send") { if (!feedback?.previewId) setNotice("Use /feedback submit <message> first."); else setNotice("Review your feedback in the dialog, then send it."); return; }
        const submitFeedback = command.args.startsWith("submit ");
        const message = submitFeedback ? command.args.slice(7).trim() : command.args;
        if (!message) { setNotice("Use /feedback <message> to save it, or /feedback submit <message> to send it."); return; }
        const result = await messageWorkspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ message, submit: submitFeedback }) }));
        if (result) { messageWorkspace.setDraft(""); if (result.previewId) setFeedback(result); else setNotice(result.error ?? `Feedback saved${result.path ? ` to ${result.path}` : ""}. Nothing was sent.`); }
        return;
      }
      if (name === "explain") {
        if (!sessionId || active) { setNotice("Wait until 0 finishes, then try again."); return; }
        if (!command.args && !snapshot?.messages.length) { setNotice("Nothing to explain yet. Use /explain <topic>."); return; }
        const topic = command.args ? `Explain "${command.args}"` : "Explain your previous result";
        await messageWorkspace.send({ text: `${topic} like I am five years old. Use 3–5 very short sentences, mostly under 12 words each. Use familiar everyday words and one simple comparison. No jargon, acronyms, code, headings, or baby talk. Say what happened, why it matters, and one thing to do next. Keep the facts accurate and say plainly what is not yet confirmed. Explain only; do not run new tests or tools.`, mode: "send", ...(messageWorkerId ? { workerId: messageWorkerId } : {}) });
        return;
      }
      if (destinations[name]) {
        let extra = name === "theme" ? "#setting-web-theme" : name === "keybindings" ? "&tab=keybindings" : "";
        if (name === "fix" && command.args) {
          if (command.args === "cancel") extra = "&intent=cancel";
          else if (command.args.startsWith("publish ")) extra = `&finding=${encodeURIComponent(command.args.slice(8).trim())}&intent=publish`;
          else extra = `&finding=${encodeURIComponent(command.args)}`;
        }
        messageWorkspace.setDraft("");
        navigate(`${destinations[name]}${controlsQuery}${extra}`);
        return;
      }
      setNotice(`/${name} isn't available here.`);
      return;
    }
    if (!sessionId || (messageWorkerId && !worker)) { setNotice("Pick a conversation first."); return; }
    await messageWorkspace.send({ text, attachments: messageWorkspace.attachments.map(({ kind, value, name }) => ({ kind, value, name })), mode: messageWorkerId ? "send" : active ? "steer" : "send", ...(messageWorkerId ? { workerId: messageWorkerId } : {}) });
  };
  const onAddFinding = (finding: FindingRecord) => {
    workspace.setRootDraft(addFindingToDraft(workspace.rootDraft, finding));
    setRailOpen(false);
    if (snapshot && !embedded) navigate(`/console/${snapshot.session.id}`);
    setNotice("Finding added to your draft. Review it, then send.");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus());
  };
  const activeResource=activeChatId?parseChatResourceKey(activeChatId,client.backendId):undefined;
  const rail = <HostSidebarChatHistory selectedId={pendingChatSelection?.id??activeResource?.id??sessionId} selectedBackendId={pendingChatSelection?.backendId??activeResource?.backendId??client.backendId} onPendingChatChange={showPendingChat} isPendingChatCurrent={isPendingChatCurrent} onOpenDockChat={replaceChatInPlace} onCreate={backendId=>void createChatOnHost(backendId)} onSelect={()=>setRailOpen(false)} />;

  const inspector = snapshot && <ConsoleInspector onAddFinding={onAddFinding} snapshot={snapshot} busy={workspace.busy} stagePrompt={(text) => { workspace.setRootDraft(text); if (!embedded) navigate(`/console/${snapshot.session.id}`); setNotice("Added a draft message. Review it, then send."); }} onScope={() => navigate(`/project${controlsQuery}`)} onDrain={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })} onHarness={(providerId, event) => {
    const generationId = snapshot.harness?.generationId;
    if (!generationId) { setNotice("Tools aren't ready yet."); return; }
    void workspace.perform(() => webFetchJson<{ snapshot: HarnessSnapshot; requestedPrompt?: string }>(`/api/console/sessions/${encodeURIComponent(snapshot.session.id)}/harness`, { method: "POST", body: JSON.stringify({ generationId, providerId, event }) })).then((result) => {
      if (result?.requestedPrompt) { workspace.setRootDraft(result.requestedPrompt); if (!embedded) navigate(`/console/${snapshot.session.id}`); setNotice("Added a draft message. Review it, then send."); }
    });
  }} />;

  const chatActions = <div className="flex items-center gap-1">
    <Tooltip content="Open conversations"><Button variant="ghost" size="icon-sm" aria-label="Open conversations" className="lg:hidden" onClick={() => setRailOpen(true)}><Menu className="size-4" /></Button></Tooltip>
    {snapshot && team.enabled && client.backendId === "local" && <TeamCollaboration sessionId={snapshot.session.id} client={teamClient} draft={workspace.draft} />}
    {snapshot && <DropdownMenu><Tooltip content="Chat menu"><DropdownMenu.Trigger aria-label="Chat menu" className="flex size-8 items-center justify-center rounded-[var(--radius-control)] hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><Button type="button" variant="ghost" size="icon-sm"><MoreHorizontal className="size-4" /></Button></DropdownMenu.Trigger></Tooltip><DropdownMenu.Content align="end">
<DropdownMenu.Item icon={<Globe className="size-4" />} onClick={() => { closeAgents(); setInspectOpen(false); setBrowserOpen(true); }}>Browser preview</DropdownMenu.Item>

{snapshot.workers.length > 0 && <DropdownMenu.Item icon={<Users className="size-4" />} onClick={() => { setAgentsOpen(true); setInspectOpen(false); setBrowserOpen(false); }}>Agents</DropdownMenu.Item>}

<DropdownMenu.Item icon={<Pencil className="size-4" />} onClick={() => { setRename(snapshot.session); setRenameValue(snapshot.title); }}>Rename</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Copy className="size-4" />} onClick={() => void openExport(snapshot.session.id, false, true, workerId ?? undefined)}>Copy chat</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Download className="size-4" />} onClick={() => void openExport(snapshot.session.id, false, false, workerId ?? undefined)}>Export</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Eraser className="size-4" />} onClick={() => setConfirm({ kind: "clear", id: snapshot.session.id, title: snapshot.title })}>Clear chat</DropdownMenu.Item>
<DropdownMenu.Item icon={<X className="size-4" />} onClick={() => setConfirm({ kind: "close", id: snapshot.session.id, title: snapshot.title })}>Close chat</DropdownMenu.Item>
<DropdownMenu.Item variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm({ kind: "delete-live", id: snapshot.session.id, title: snapshot.title })}>Delete chat</DropdownMenu.Item>
</DropdownMenu.Content></DropdownMenu>}
  </div>;

  const chatContent = <section data-console-resource={sessionId?chatResourceKey({backendId:client.backendId,id:sessionId}):undefined} data-console-session={sessionId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {agentsOpen && <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-border"><div className="flex items-center justify-between px-4 py-2"><span className="text-xs font-medium">{agentsOpen ? "Agents" : "Browser views"}</span><Button variant="ghost" size="icon-xs" aria-label="Close chat activity" onClick={() => { closeAgents(); setBrowserOpen(false); }}><X className="size-3.5" /></Button></div>{agentsOpen && snapshot ? <AgentsPanel embedded snapshot={snapshot} selectedWorkerId={workerId} onSelect={selectWorker} onStopAll={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })} /> : snapshot ? <div className="px-4 pb-4"><BrowserPreviews snapshot={snapshot} emptyState /></div> : null}</div>}


        {snapshot?.focusedFinding && <Disclosure key={snapshot.focusedFinding.id} className="shrink-0 bg-muted/10 px-4 py-3 text-xs" defaultOpen={search.get("intent") === "impact"} summary={<>{snapshot.focusedFinding.title} · {snapshot.focusedFinding.severity}</>} triggerClassName="cursor-pointer font-medium"><div className="max-h-64 space-y-3 overflow-auto pt-3"><p className="whitespace-pre-wrap">{snapshot.focusedFinding.description}</p><div><div className="font-medium">Impact</div>{snapshot.focusedFinding.impactAssessment ? <pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(snapshot.focusedFinding.impactAssessment, null, 2)}</pre> : <p className="mt-1 text-muted-foreground">Not assessed yet.</p>}</div><Button size="sm" variant="outline" asChild><Link to={`/fix${controlsQuery}&finding=${encodeURIComponent(snapshot.focusedFinding.id)}`}>Prepare a fix</Link></Button></div></Disclosure>}
        {recoveringSession || workspace.loading || (!sessionId && !workspace.error && !readOnlyTeam) ? <ConversationSkeleton /> : snapshot ? workerId && !worker ? <div className="grid flex-1 place-items-center p-8 text-center"><div><h2 className="text-base font-medium">This sub-agent has ended</h2><Button className="mt-4" variant="outline" onClick={() => navigate(`/console/${snapshot.session.id}`)}>Back</Button></div></div> : <Conversation detailsControl={<ChatDetailsPopover open={inspectOpen} onOpenChange={setInspectOpen} contextPercent={snapshot.contextInputTokens !== undefined && (snapshot.contextWindowTokens ?? snapshot.runtime?.contextWindowTokens) ? Math.round(snapshot.contextInputTokens / (snapshot.contextWindowTokens ?? snapshot.runtime?.contextWindowTokens)! * 100) : undefined}>{inspector}</ChatDetailsPopover>} onSubmitRoot={() => void submit(true)} onStopRoot={() => void workspace.perform(() => controlConsoleSession(snapshot.session.id, "cancel"))} onDrainAgents={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })} onOpenDetails={() => { closeAgents(); setBrowserOpen(false); setInspectOpen(true); }} agentsOpen={agentsOpen} onCloseAgents={closeAgents} onSelectWorker={selectWorker} sendBehavior={mode} workspace={workspace} worker={worker} onSubmit={() => void submit()} onStop={() => void workspace.perform(() => worker ? stopConsoleWorker(snapshot.session.id, worker.id) : controlConsoleSession(snapshot.session.id, "cancel"))} onResolve={(id, response) => void workspace.perform(() => resolveConsoleDecision(snapshot.session.id, id, response))} resumeCap={() => setCapOpen(true)} /> : <div className="console-enter grid flex-1 place-items-center overflow-auto p-6"><div className="max-w-xl text-center"><BrandMark className="mx-auto mb-6" /><h1 className="font-heading text-2xl font-medium">Hi! What do you want me to do?</h1>{sessionId && <p className="mt-3 text-sm text-muted-foreground">Your draft is saved. Open History to choose a saved conversation.</p>}<div className="mt-6 flex justify-center gap-3"><NewChatButton variant="default" disabled={workspace.busy || readOnlyTeam} onClick={() => void createSession()} /><Button variant="ghost" onClick={() => setRailOpen(true)}>History</Button></div></div></div>}
      </section>;

  const pendingChatContent = <section data-pending-chat={pendingChatSelection?.id} aria-label={pendingChatSelection ? `Opening ${pendingChatSelection.title}` : undefined} className="flex h-full min-h-0 flex-col"><ConversationSkeleton /></section>;

  const dockPanels: Record<DockPanelId,ReactNode> = {
        agents: snapshot ? <AgentsPanel embedded snapshot={snapshot} selectedWorkerId={workerId} onSelect={selectWorker} onStopAll={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })}>{worker && <Composer canWrite={!readOnlyTeam} sendBehavior={mode} workspace={workspace} snapshot={snapshot} worker={worker} onSubmit={() => void submit()} onStop={() => void workspace.perform(() => stopConsoleWorker(snapshot.session.id, worker.id))} />}</AgentsPanel> : null,
        details: <div className="h-full overflow-y-auto">{inspector}</div>,
        browser: snapshot ? <div className="h-full overflow-y-auto p-4"><BrowserPreviews snapshot={snapshot} emptyState /></div> : null,
      };
  const dockActive: DockPanelId|null = browserOpen ? "browser" : null;
  const selectDockPanel = (panel:DockPanelId|null) => {
        if (panel === "agents") { setAgentsOpen(true); setInspectOpen(false); setBrowserOpen(false); }
        else { closeAgents(); setInspectOpen(panel === "details"); setBrowserOpen(panel === "browser"); }
      };
  const bindChatNode=(node:ReactNode)=><BackendApiContext value={scopedApi}><QueryClientProvider client={queryClient}><BackendSelectionContext value={backendRegistry}><ChatHostSelectionScope backendId={client.backendId} reconnect={backendRegistry?.reconnect} onSelectHost={(host:string)=>void createChatOnHost(host)}>{node}</ChatHostSelectionScope></BackendSelectionContext></QueryClientProvider></BackendApiContext>;
  useEffect(() => {
    if (embeddedSessionId && onDockViewChange) onDockViewChange(chatResourceKey({backendId:client.backendId,id:embeddedSessionId}),{actions:bindChatNode(chatActions),panels:{agents:bindChatNode(dockPanels.agents),details:bindChatNode(dockPanels.details),browser:bindChatNode(dockPanels.browser)},activePanel:dockActive,select:selectDockPanel});
  }, [embeddedSessionId,onDockViewChange,snapshot,workerId,agentsOpen,inspectOpen,browserOpen,workspace.draft,workspace.busy,workspace.error,scopedApi,queryClient,backendRegistry]);
  const historySlot = useSidebarHistory();
  const ownerView = activeChatId ? embeddedViews[activeChatId] : undefined;
  return <ChatHostSelectionScope backendId={client.backendId} reconnect={backendRegistry?.reconnect} onSelectHost={(host:string)=>void createChatOnHost(host)}>
    {embedded ? chatContent : <div className="console-frame flex min-w-0 overflow-hidden bg-background">
      {historySlot ? createPortal(rail,historySlot) : <aside ref={sessionRailElement} className="hidden w-64 shrink-0 lg:block">{rail}</aside>}
      <DockWorkspace primarySessionId={sessionId} primaryBackendId={client.backendId} persistenceKey={dockPersistenceKey} legacyPersistenceKey={dockLegacyKey} restoreReady={workspace.sessionsLoaded && dockChatsNormalized} chatIdRemap={dockRemap.current.ids} onRestoreLayoutState={restoreDockState} primaryTitle={pendingPrimary ? pendingChatSelection!.title : snapshot?.messages.some(message => message.role === "user" || message.role === "assistant") ? snapshot.title || "Chat" : "New chat"} primaryClosable={Boolean(snapshot?.messages.some(message => message.role === "user" || message.role === "assistant"))} onClosePrimary={replacement => { showPendingChat(null); if (replacement) routeNavigate(backendRouteHref(replacement.backendId, `/console/${encodeURIComponent(replacement.id)}`)); else navigate(`/console?new=1&host=${encodeURIComponent(client.backendId)}`); }} chat={pendingPrimary ? pendingChatContent : chatContent} actions={pendingPrimary ? undefined : chatActions} panels={ownerView?.panels ?? dockPanels} activePanel={pendingChatSelection ? null : ownerView?.activePanel ?? (activeChatId ? null : dockActive)} onActivePanelChange={ownerView?.select ?? selectDockPanel}
        extraChats={dockChatState.chats.map(item=>{const backendId=item.backendId??client.backendId,key=chatResourceKey({backendId,id:item.id});return {...item,backendId,title:pendingChatSelection?.paneKey===key?pendingChatSelection.title:item.title,actions:pendingChatSelection?.paneKey===key?undefined:embeddedViews[key]?.actions,content:pendingChatSelection?.paneKey===key?pendingChatContent:<ConsolePage embeddedSessionId={item.id} embeddedBackendId={backendId} onOpenDockChat={openDockChat} onDockViewChange={updateEmbeddedView} onCloseDockChat={closeDockChat} onDockRosterChange={updateHostRoster} onDockSessionResolved={resolveDockSession} />};})} activeChatId={activeChatId} onActiveChatChange={id => { showPendingChat(null); setActiveChatId(id); }} onOpenChat={(id,title,saved,backendId=client.backendId,onResolved)=>{if(!saved){openDockChat(id,title,backendId);return;}void runOnHost(backendId,api=>api.resumeConsoleSession(id,{})).then(created=>{onResolved?.({backendId,id:created.id});if(backendId===client.backendId)queryClient.setQueryData<DesktopConsoleSession[]>(["console-sessions"],previous=>[...(previous??[]).filter(item=>item.id!==created.id),created]);else setHostRosters(previous=>({...previous,[backendId]:[...(previous[backendId]??[]).filter(item=>item.id!==created.id),created]}));openDockChat(created.id,created.title||title,backendId);}).catch(error=>{if (!isRequestCancellation(error)) setNotice(error instanceof Error?error.message:"Couldn't resume that chat.");});}} onCloseChat={closeDockChat} />

    </div>}
    <Sheet open={railOpen} onOpenChange={setRailOpen}><SheetContent side="left" className="console-sidebar-surface flex w-80 flex-col p-0"><SheetHeader className=" px-4 py-4 pr-12"><SheetTitle>Chats</SheetTitle><SheetDescription className="sr-only">Current and past chats</SheetDescription></SheetHeader><div className="min-h-0 flex-1">{rail}</div></SheetContent></Sheet>


    <Dialog open={Boolean(rename)} onOpenChange={(open) => { if (!open) setRename(null); }}><DialogContent><DialogHeader><DialogTitle>Rename chat</DialogTitle><DialogDescription className="sr-only">Choose a new name.</DialogDescription>{dialogError}</DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!rename || !renameValue.trim()) return; void workspace.perform(() => configureConsoleSession(rename.id, { title: renameValue.trim() }), rename.id).then((result) => { if (result) setRename(null); }); }}><Input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={200} aria-label="Chat name" /><Button disabled={!renameValue.trim() || workspace.busy}>Save</Button></form></DialogContent></Dialog>
    <Dialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirm?.kind === "delete-live" ? "Delete this conversation?" : confirm?.kind === "delete" ? "Delete this conversation?" : confirm?.kind === "clear" ? "Clear this conversation?" : confirm?.kind === "drain" ? "Stop all sub-agents?" : "Close this conversation?"}</DialogTitle>
          <DialogDescription>{confirm?.kind === "delete-live" ? "This stops it and permanently deletes its history. This can't be undone." : confirm?.kind === "delete" ? "This permanently deletes its history. This can't be undone." : confirm?.kind === "clear" ? "0 forgets the messages so far. Permissions stay the same." : confirm?.kind === "drain" ? "The conversation stays open." : "This stops any running work. You can resume it later from history."}</DialogDescription>
          {dialogError}
        </DialogHeader>
        <p className="text-sm font-medium">{confirm?.title}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="destructive" disabled={workspace.busy} onClick={() => {
            if (!confirm) return;
            const action = confirm;
            void workspace.perform(async () => {
              if (action.kind === "delete-live") return deleteConsoleSession(action.id);
              if (action.kind === "delete") return deleteSavedConsoleSession(action.id);
              if (action.kind === "close") return closeConsoleSession(action.id);
              return controlConsoleSession(action.id, action.kind === "drain" ? "workers/stop" : "clear");
            }, action.id).then((result) => {
              if (!result) return;
              setConfirm(null);
              if (action.kind === "clear") workspace.setRootDraft("");
              if (action.kind === "delete-live") {
                workspace.forgetDrafts(action.id);
                if (sessionId === action.id) { if (embedded) onCloseDockChat?.(chatResourceKey({backendId:client.backendId,id:action.id})); else { setActiveSession(null); navigate("/console", { replace: true }); } }
              }
            });
          }}>{confirm?.kind === "delete-live" || confirm?.kind === "delete" ? "Delete" : confirm?.kind === "clear" ? "Clear" : confirm?.kind === "drain" ? "Stop" : "Close"}</Button>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(exported)} onOpenChange={(open) => { if (!open) setExported(null); }}><DialogContent className="max-h-[90dvh] sm:max-w-3xl"><DialogHeader><DialogTitle>{exportKind === "worker" ? "Export sub-agent conversation" : "Export chat"}</DialogTitle><DialogDescription>May contain sensitive data. Check before sharing.</DialogDescription>{dialogError}</DialogHeader><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { if (!exported) return; void navigator.clipboard.writeText(exported.text).then(() => setCopyStatus("Copied"), () => setCopyStatus("Couldn't copy. Select the text below or download it.")); }}><Copy className="size-3" />Copy</Button><Button variant="outline" size="sm" onClick={() => download("json")}><Download className="size-3" />JSON</Button><Button variant="outline" size="sm" onClick={() => download("txt")}><Download className="size-3" />Text</Button></div>{copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p>}<Textarea className="h-[45dvh] w-full resize-none rounded-[var(--radius-control)] border border-border bg-muted/20 p-3 font-mono text-xs leading-5" readOnly value={exported?.text ?? ""} aria-label="Chat text" /></DialogContent></Dialog>
    <Dialog open={capOpen} onOpenChange={setCapOpen}><DialogContent><DialogHeader><DialogTitle>Keep going</DialogTitle><DialogDescription>0 hit its output limit. Tell it what's left to do.</DialogDescription>{dialogError}</DialogHeader><Textarea className="min-h-28 rounded-[var(--radius-control)] border border-border bg-background p-3 text-sm" value={continuation} onChange={(event) => setContinuation(event.target.value)} aria-label="What's left to do" /><Button disabled={workspace.busy || !continuation.trim() || Boolean(active)} onClick={() => { if (!sessionId) return; void workspace.perform(() => webFetchJson<{ session: DesktopConsoleSession }>(`/api/console/sessions/${encodeURIComponent(sessionId)}/continue`, { method: "POST", body: JSON.stringify({ text: continuation.trim() }) })).then((result) => { if (result) setCapOpen(false); }); }}>Continue</Button></DialogContent></Dialog>
    <Dialog open={Boolean(feedback?.previewId)} onOpenChange={(open) => { if (!open) { void workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "cancel" }) })); setFeedback(null); } }}><DialogContent className="max-h-[90dvh] overflow-auto"><DialogHeader><DialogTitle>Send feedback?</DialogTitle><DialogDescription>Nothing has been sent yet. This is exactly what will be sent.</DialogDescription>{dialogError}</DialogHeader><pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(feedback?.preview, null, 2)}</pre><Button disabled={workspace.busy} onClick={() => { if (!feedback?.previewId) return; void workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "send", previewId: feedback.previewId }) })).then((result) => { if (result) { setFeedback(null); setNotice(result.error ?? (result.submitted ? "Feedback sent. Thank you!" : "Feedback wasn't sent.")); } }); }}>Send feedback</Button></DialogContent></Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Commands</DialogTitle><DialogDescription>Type / in the message box to use these.</DialogDescription>{dialogError}</DialogHeader><div className="space-y-2">{SLASH_COMMANDS.map((command) => <Button variant="outline" key={command.name} className="h-auto w-full flex-col items-start whitespace-normal p-3 text-left" onClick={() => { workspace.setDraft(`/${command.name}${command.name === "feedback" || command.name === "explain" ? " " : ""}`); setHelpOpen(false); }}><span className="font-mono text-xs">/{command.name}</span><span className="mt-1 text-xs leading-5 text-muted-foreground">{command.description}</span></Button>)}</div></DialogContent></Dialog>
  </ChatHostSelectionScope>;
}
