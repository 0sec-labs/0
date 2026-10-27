import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { recoveredProviderError } from "./connection-recovery";
import { consoleErrorMessage, needsProviderSignIn, needsModelSourceReconnect } from "./provider-error";
import { ArrowDown, ArrowUp, Box, Monitor, ChevronDown, Plus, FolderSearch, ListChecks, ShieldCheck, Square, Wrench } from "lucide-react";
import type { ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleDecisionResponse } from "@0/shared";
import { SLASH_COMMANDS } from "@0/shared/dist/slash-commands.js";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/provider-icon";
import { ReasoningPicker, REASONING_LABELS } from "./reasoning-picker";
import { BackendConnectionPicker } from "@/components/backend-connection-picker";
import { FilePathPicker } from "./file-path-picker";
import { HomeAnalytics } from "./home-analytics";
import { QueuedMessages } from "./queued-messages";
import { ModePicker } from "./mode-picker";
type SendBehavior = "queue" | "steer";
import { AgentOnboarding } from "./agent-onboarding";
import { BrandMark } from "@/components/brand-mark";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { createBackendApi, useBackendApi } from "@/api";
import { configureChatRuntime, modelCatalogOwner, usesLocalModels } from "./model-source";
import { backendRouteHref, chatResourceKey } from "./chat-host";
import { useTeamAccess } from "@/components/team-access";
import { Markdown } from "./markdown";
import { ComposerPickerSurface, IntegrationPicker, useIntegrationPicker } from "./integration-picker";
import { ActivityIndicator, ConversationSkeleton, LoadingDots } from "./loading-state";
import { ApprovalPanel } from "./approvals";
import { ActivityRow } from "./activity-row";
import { homeSuggestions, selectedWorkspacePath } from "./home-context";
import type { ProjectResponse } from "@/components/console-control/contracts";
import { ToolActivity } from "./tool-activity";
import { useComposerAttachments } from "./composer-attachments";
import { InlineImage, transcriptToolImages } from "./inline-image";
import { WorkerTree, isCancellation } from "./worker-tree";
import { workersForTurn } from "./worker-turns";
import { reduceConversation } from "./transcript";
import type { ConsoleWorkspace } from "./use-console-workspace";

export function Conversation({ detailsControl, emptyState, composerPlaceholder, workspace, worker, onResolve, onSubmit, onStop, resumeCap, sendBehavior, agentsOpen = false, onCloseAgents, onSelectWorker, onOpenDetails, onDrainAgents, onSubmitRoot, onStopRoot }: {
  detailsControl?: ReactNode;
  emptyState?: ReactNode;
  composerPlaceholder?: string;
  onSubmitRoot: () => void;
  onStopRoot: () => void;
  onOpenDetails?: () => void;
  onDrainAgents?: () => void;
  agentsOpen?: boolean;
  onCloseAgents?: () => void;
  onSelectWorker: (id: string | null) => void;
  workspace: ConsoleWorkspace;
  worker: ConsoleWorker | undefined;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSubmit: () => void;
  onStop: () => void;
  resumeCap: () => void;
  sendBehavior: SendBehavior;
}) {
  const snapshot = workspace.snapshot;
  const rootWorkspace = { ...workspace, draft: workspace.rootDraft, attachments: workspace.rootAttachments, setDraft: workspace.setRootDraft, setAttachments: workspace.setRootAttachments };
  const team = useTeamAccess();
  const { client } = useBackendApi();
  const teamEnabled = team.enabled && client.backendId === "local";
  const canWrite = !teamEnabled || Boolean(team.user && team.user.role !== "viewer");
  const turns = useMemo(() => snapshot ? reduceConversation(snapshot) : [], [snapshot]);
  const turnWorkers = useMemo(() => snapshot ? workersForTurn(snapshot, turns) : new Map<string, ConsoleWorker[]>(), [snapshot, turns]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const [visibleTurn, setVisibleTurn] = useState<string | null>(null);
  const updateVisibleTurn = () => {
    const viewport = scroller.current;
    if (!viewport) return;
    const anchor = viewport.getBoundingClientRect().top + Math.min(140, viewport.clientHeight * 0.25);
    const articles = Array.from(viewport.querySelectorAll<HTMLElement>("article[data-chat-turn]"));
    const current = articles.find(article => { const rect = article.getBoundingClientRect(); return rect.top <= anchor && rect.bottom > anchor; }) ?? articles.find(article => article.getBoundingClientRect().top > anchor) ?? articles.at(-1);
    if (current) setVisibleTurn(current.dataset.chatTurn ?? null);
  };
  const conversationKey = snapshot?.session.id ?? "root";
  useLayoutEffect(() => {
    nearBottom.current = true;
    setShowJump(false);
    const node = scroller.current;
    if (node) { node.scrollTop = node.scrollHeight; updateVisibleTurn(); }
  }, [conversationKey, turns.length === 0]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const viewport = scroller.current;
      if (!viewport) return;
      if (nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
      else setShowJump(true);
      updateVisibleTurn();
      setMoreBelow(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8);
    });
    observer.observe(node);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [conversationKey, turns.length === 0]);
  if (!snapshot) return workspace.loading ? <ConversationSkeleton /> : null;

  const active = ["working", "waiting"].includes(snapshot.session.status);
  const liveWorkers = snapshot.workers.filter(item => ["running", "queued", "parked"].includes(item.status));
  const showTasks = Boolean(active && snapshot.todos?.todos.some(item => !["completed", "cancelled"].includes(item.status)));
  const empty = !worker && turns.length === 0 && snapshot.pendingDecisions.length === 0 && snapshot.queuedMessages.length === 0;
  if (empty && emptyState) return <div className="flex min-h-0 flex-1 flex-col" aria-label="Editor chat">
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">{emptyState}</div>
    <Composer detailsControl={detailsControl} placeholder={composerPlaceholder} canWrite={canWrite} sendBehavior={sendBehavior} workspace={rootWorkspace} snapshot={snapshot} onSubmit={onSubmitRoot} onStop={onStopRoot} />
  </div>;
  if (empty) return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Home">
    <section className="flex min-h-full flex-col justify-center pb-20 pt-8">
      <div className="mx-auto w-full max-w-3xl px-3 py-5 text-center sm:px-6">
        <div className="mb-8 flex justify-center"><AgentOnboarding /></div>
        <BrandMark className="mb-7" />
        <h2 className="font-heading text-xl">What would you like to hack and fix today?</h2>
      </div>
      <Composer detailsControl={detailsControl} placeholder={composerPlaceholder} canWrite={canWrite} sendBehavior={sendBehavior} workspace={rootWorkspace} snapshot={snapshot} onSubmit={onSubmitRoot} onStop={onStopRoot} />
      <ContextSuggestions snapshot={snapshot} onChoose={prompt => { workspace.setRootDraft(prompt); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-console-resource="${CSS.escape(chatResourceKey({backendId:client.backendId,id:snapshot.session.id}))}"] .console-composer textarea`)?.focus()); }} />
    </section>
    <HomeAnalytics />
  </div>;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
    <div className={`console-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col ${empty ? "justify-center pb-20" : ""}`}>
      <div ref={scroller} data-scrolled={scrolled} data-more-below={moreBelow} className={`console-transcript-scroller min-h-0 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 ${empty ? "flex-none" : "flex-1"}`} onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        updateVisibleTurn();
        setScrolled(node.scrollTop > 8);
        setMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 8);
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        if (nearBottom.current) setShowJump(false);
      }} aria-label="Conversation">
        <div className="console-conversation-layout">
        <div ref={content} className="min-w-0 space-y-10">
          {turns.length ? turns.map((turn) => <article data-chat-turn={turn.id} id={`chat-${turn.id}`} key={turn.id} className="scroll-mt-6 space-y-5">
            {(turn.user.text || turn.user.attachments?.length) && <div className="ml-auto min-w-0 max-w-[92%] console-message-surface console-user-message px-4 py-3 text-sm break-words [&_p]:whitespace-pre-wrap">{turn.user.author && <p className="mb-1 text-xs text-muted-foreground">{turn.user.author.displayName}</p>}<Markdown text={turn.user.text} />{turn.user.attachments?.filter(item => item.kind === "image").map((item, index) => <InlineImage key={index} src={item.value} alt={item.name || "Attached image"} />)}</div>}
            {(turn.toolCalls.length > 0 || turn.reasoningText) && <ToolActivity calls={turn.toolCalls} reasoning={turn.reasoningText} working={turn.isWorking} startedAt={turn.startedAt} endedAt={turn.endedAt} />}
            {turn.decisions.filter((decision) => decision.resolved).map((decision) => <ActivityRow key={decision.id} icon={<ShieldCheck />} title={`${decision.title} · ${decision.approved === undefined ? "closed" : decision.approved ? decision.kind === "operator-question" ? "answered" : "approved" : "declined"}`} status=""><ApprovalPanel decision={decision} busy={workspace.busy || !canWrite} onResolve={(response) => onResolve(decision.id, response)} /></ActivityRow>)}
            {turn.assistantText && <Markdown text={turn.assistantText} streaming={turn.isWorking && snapshot.session.status === "working"} />}
            {turn.toolCalls.flatMap(call => transcriptToolImages(call.name, call.result)).map((img, index) => <InlineImage key={index} {...img} />)}
            <WorkerTree sessionId={snapshot.session.id} workers={turnWorkers.get(turn.id) ?? []} onSelect={onSelectWorker} />
            {turn.notices.filter(notice => !notice.startsWith("Cancellation requested.") && !notice.startsWith("Turn cancelled by operator")).map((notice, index) => <p key={index} className="border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{notice}</p>)}
            {(turn.stopReason === "cancelled" || turn.error?.startsWith("Workbench cancelled")) && <p role="status" className="text-xs text-muted-foreground">Stopped</p>}
            {turn.error && !turn.error.startsWith("Workbench cancelled") && !isCancellation(turn.error) && !recoveredProviderError(turn.error, workspace.connectionRecovery) && !(needsModelSourceReconnect(turn.error) && workspace.modelSourceRecovery?.healthy) && <div role="alert" className="rounded-[var(--radius-panel)] border border-destructive/30 bg-destructive/5 p-3 text-sm whitespace-pre-wrap text-destructive">{consoleErrorMessage(turn.error)}{needsModelSourceReconnect(turn.error) && workspace.reconnectModelSource && <Button type="button" variant="default" size="sm" className="mt-3 flex w-fit" disabled={!canWrite || workspace.busy || workspace.modelSourceRecovery?.checking || active} onClick={() => void workspace.reconnectModelSource?.()}>{workspace.modelSourceRecovery?.checking ? "Reconnecting…" : "Reconnect model source"}</Button>}{needsProviderSignIn(turn.error) && <Button asChild variant="default" size="sm" className="mt-3 flex w-fit"><Link to={`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`}>Manage connection</Link></Button>}</div>}
            {turn.isWorking && (turn.notices.some(notice => notice.startsWith("Cancellation requested.")) || snapshot.session.status === "waiting" || (!turn.assistantText && turn.toolCalls.length === 0 && !turn.reasoningText)) && <ActivityIndicator waiting={snapshot.session.status === "waiting"} label={turn.notices.some(notice => notice.startsWith("Cancellation requested.")) ? "Stopping…" : snapshot.session.status === "waiting" ? "Waiting for your decision" : turn.toolCalls.some((call) => call.isRunning) ? "Running tools…" : turn.assistantText ? "Responding…" : "Thinking…"} />}
          </article>) : <div className="py-4 text-center"><div className="mb-8 flex justify-center"><AgentOnboarding /></div><BrandMark className="mb-7" /><h2 className="font-heading text-xl">What would you like to hack and fix today?</h2></div>}
          {snapshot.lastOutcome?.outputCap && !worker && <div role="status" className="rounded-[var(--radius-panel)] border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><div className="font-medium">0 hit its output limit</div><Button className="mt-3" size="sm" disabled={workspace.busy || active || !canWrite} onClick={resumeCap}>Keep going</Button></div>}
          <QueuedMessages inline workspace={rootWorkspace} snapshot={snapshot} />
          {snapshot.pendingDecisions.map((decision) => <div key={decision.id} className="space-y-2"><ApprovalPanel decision={decision} busy={workspace.busy || !canWrite} onResolve={(response) => onResolve(decision.id, response)} /></div>)}
        </div>
        </div>
      </div>
      {turns.length > 2 && <nav aria-label="Turn navigation" className="absolute left-0 top-1/2 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col overflow-visible py-3 sm:flex">
        {turns.map((turn, index) => <Tooltip key={turn.id} preview delay={0} side="right" content={<span className="block w-72 max-w-[75vw] text-left leading-[18px]">
          <span className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>Turn {index + 1}{visibleTurn === turn.id ? " · Reading" : ""}</span><span>{turn.isWorking ? "Working" : turn.stopReason === "cancelled" ? "Stopped" : turn.endedAt ? new Date(turn.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</span></span>
          <span className="line-clamp-3 text-[13px] font-medium">{turn.user.text.slice(0, 240) || (turn.user.attachments?.length ? "Image attachment" : `Turn ${index + 1}`)}</span>
          {turn.assistantText && <span className="mt-2 line-clamp-4 text-[12px] text-muted-foreground">{turn.assistantText.replace(/[#*_`]/g, "").slice(0, 360)}</span>}
          <span className="mt-2 block text-[10px] text-muted-foreground/70">Click to jump here</span>
        </span>}><button type="button" aria-label={`Jump to turn ${index + 1}: ${turn.user.text.slice(0, 60)}`} aria-current={visibleTurn === turn.id ? "location" : undefined} data-active={visibleTurn === turn.id || undefined} className="console-turn-marker group flex h-3 w-5 items-center justify-center rounded-[var(--radius-control)] focus-visible:outline-2 focus-visible:outline-ring" onClick={() => document.getElementById(`chat-${turn.id}`)?.scrollIntoView({ block: "start", behavior: document.documentElement.dataset.reducedMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}><span className={`h-px transition-all duration-150 group-hover:w-3 group-hover:bg-foreground group-focus-visible:w-3 ${visibleTurn === turn.id ? "w-3 bg-foreground/85" : "w-1.5 bg-muted-foreground/35"}`} /></button></Tooltip>)}
      </nav>}

      {showJump && <Button variant="secondary" size="sm" className="absolute bottom-[10rem] left-1/2 z-10 -translate-x-1/2 shadow-lg" onClick={() => { const node = scroller.current; if (node) node.scrollTo({ top: node.scrollHeight, behavior: document.documentElement.dataset.reducedMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); nearBottom.current = true; setShowJump(false); }}><ArrowDown className="size-3.5" />Latest</Button>}
      {(liveWorkers.length > 0 || showTasks) ? <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-1 text-[11px] text-muted-foreground">
        {liveWorkers.length > 0 && <button type="button" onClick={() => onSelectWorker(null)} className="flex items-center gap-1.5 rounded-full bg-muted/40 px-2 py-1 hover:bg-muted/60"><span className="size-1.5 rounded-full bg-violet-400" />{liveWorkers.length} agents</button>}
        {showTasks && snapshot.todos ? <button type="button" onClick={onOpenDetails} className="flex items-center gap-1.5 rounded-full bg-muted/40 px-2 py-1 hover:bg-muted/60"><ListChecks className="size-3" />{snapshot.todos.done}/{snapshot.todos.total} tasks</button> : null}
      </div> : null}
      <Composer detailsControl={detailsControl} placeholder={composerPlaceholder} canWrite={canWrite} sendBehavior={sendBehavior} workspace={rootWorkspace} snapshot={snapshot} onSubmit={onSubmitRoot} onStop={onStopRoot} />
      {empty && <ContextSuggestions snapshot={snapshot} onChoose={prompt => { workspace.setRootDraft(prompt); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus()); }} />}

    </div>
    </div>
  );
}

function ContextSuggestions({ snapshot, onChoose }: { snapshot: ConsoleSessionSnapshot; onChoose: (prompt: string) => void }) {
  const {client,webFetchJson}=useBackendApi();
  const team=useTeamAccess();
  const path=selectedWorkspacePath(snapshot);
  const project=useQuery({queryKey:["chat-home-project",client.backendId,team.user?.workspaceId,team.user?.userId,snapshot.session.id,path],enabled:Boolean(path) && !snapshot.focusedFinding,staleTime:15000,retry:false,queryFn:({signal})=>webFetchJson<ProjectResponse>(`/api/console/project?path=${encodeURIComponent(path!)}`,{signal})});
  const suggestions=homeSuggestions(snapshot,project.data && path?{requestedPath:path,project:project.data}:undefined);
  const icons={code:FolderSearch,shield:ShieldCheck,plan:ListChecks};
  return <div aria-label="Suggested prompts" className="mx-auto w-full max-w-3xl space-y-1 px-3 pt-3 sm:px-6">{suggestions.map(suggestion=>{
    const Icon=icons[suggestion.icon];
    return <Tooltip key={suggestion.label} content={suggestion.hint}><Button type="button" variant="ghost" className="w-full justify-start gap-2.5 text-left font-normal text-muted-foreground" onClick={()=>onChoose(suggestion.prompt)}><Icon aria-hidden="true" className="size-4 shrink-0" /><span className="truncate">{suggestion.label}</span></Button></Tooltip>;
  })}</div>;
}

const COMMAND_SUMMARIES: Record<string, string> = {
  help: "Browse commands", capabilities: "Explore what 0 can do", status: "Check this conversation", tools: "Browse available tools",
  "new-chat": "Start a new conversation", onboard: "Open guided setup", clear: "Clear this conversation", history: "Browse run reports",
  findings: "Review findings", fix: "Prepare a fix for review", copy: "Export this conversation", sessions: "Switch conversations",
  explain: "Get a simpler explanation", feedback: "Share feedback", settings: "Manage preferences", keybindings: "View keyboard shortcuts",
  theme: "Change appearance", model: "Choose a model", chat: "Return to chat", ops: "Open dashboard", hackstore: "Browse plugins",
  connect: "Connect a provider", usage: "Check usage and cost", back: "Go back", scope: "Manage approved scope", doctor: "Check your setup", exit: "Close this conversation",
};

function WorkspaceStartup({ message, runId }: { message?: string; runId?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [runId]);
  return <Tooltip content="The first message starts an isolated VM and copies your workspace. Later messages reuse it while this chat stays open."><span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><LoadingDots />{message ?? "Starting workspace"}…{seconds >= 5 && <span className="tabular-nums">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>}</span></Tooltip>;
}

export function Composer({ detailsControl, placeholder, workspace, snapshot, worker, onSubmit, onStop, sendBehavior, canWrite }: { detailsControl?: ReactNode; placeholder?: string; canWrite: boolean; sendBehavior: SendBehavior; workspace: ConsoleWorkspace; snapshot: ConsoleSessionSnapshot; worker?: ConsoleWorker; onSubmit: () => void; onStop: () => void }) {
  const chatApi=useBackendApi();
  const { client, configureConsoleSession, webFetchJson } = chatApi;
  const team = useTeamAccess();
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const navigate = useNavigate();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [caret, setCaret] = useState(workspace.draft.length);
  const integrations = useIntegrationPicker({ draft: workspace.draft, caret, onSelect: (_plugin, replacement) => {
    workspace.setDraft(workspace.draft.slice(0, replacement.start) + replacement.text + workspace.draft.slice(replacement.end));
    const nextCaret = replacement.start + replacement.text.length;
    setCaret(nextCaret);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(nextCaret, nextCaret); });
  } });
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const modelOwner=modelCatalogOwner(client.backendId,snapshot.runtime);
  const localRelay=client.backendId!=="local" && usesLocalModels(snapshot.runtime);
  const localModels=useMemo(()=>modelOwner!==client.backendId?createBackendApi(modelOwner):undefined,[modelOwner,client.backendId]);
  const modelLeases=useRef(new Set<NonNullable<typeof localModels>>());
  useEffect(()=>{if(!localModels)return;modelLeases.current.add(localModels);return()=>{modelLeases.current.delete(localModels);queueMicrotask(()=>{if(!modelLeases.current.has(localModels))localModels.client.dispose();});};},[localModels]);
  const modelCatalog = useQuery({ queryKey: ["console-models", "all", modelOwner, team.user?.workspaceId, team.user?.userId], enabled: !team.enabled || Boolean(team.user), staleTime: 60_000, gcTime: 600_000, queryFn: ({ signal }) => (localModels?.webFetchJson ?? webFetchJson)<ModelsResponse>("/api/console/models", { signal }) });
  // The initial remote relay admits local ChatGPT/Codex models only; never offer an unsupported provider as ready.
  const catalogModels=(modelCatalog.data?.models??[]).filter(model=>!localRelay || model.provider==="chatgpt-codex");
  const modelDiagnostics=(modelCatalog.data?.diagnostics??[]).filter(item=>!localRelay || item.providerId==="chatgpt-codex");
  const visibleModels = useMemo(() => {
    const rank = (model: ModelsResponse["models"][number]) => {
      if (model.provider === snapshot.runtime?.providerId && model.id === snapshot.runtime?.model) return 0;
      if (model.provider === snapshot.runtime?.providerId) return 1;
      if (model.provider === "openai") return 2;
      if (model.provider === "chatgpt-codex") return 3;
      return 4;
    };
    const models = new Map<string, ModelsResponse["models"][number]>();
    for (const model of catalogModels) {
      const key = `${model.provider}:${model.id}`;
      if (!models.has(key) || model.source === "account") models.set(key, model);
    }
    return [...models.values()]
      .filter(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b)
        || Number(/^gpt-[0-9]/.test(b.id)) - Number(/^gpt-[0-9]/.test(a.id))
        || b.id.localeCompare(a.id, undefined, { numeric: true })
        || a.provider.localeCompare(b.provider));
  }, [modelCatalog.data, modelFilter, snapshot.runtime?.providerId, snapshot.runtime?.model,localRelay]);

  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandQuery = /^\/([^\s]*)$/.exec(workspace.draft)?.[1]?.toLowerCase();
  const commands = useMemo(() => commandQuery === undefined ? [] : SLASH_COMMANDS.filter((command) => command.name !== "launcher" && (command.name.startsWith(commandQuery) || command.aliases.some((alias) => alias.startsWith(commandQuery)))), [commandQuery]);
  const commandsOpen = !worker && commandQuery !== undefined && !commandsDismissed;
  useEffect(() => { setCommandIndex(0); setCommandsDismissed(false); }, [workspace.draft]);
  useEffect(() => { document.getElementById(`composer-command-${commandIndex}`)?.scrollIntoView({ block: "nearest" }); }, [commandIndex]);
  const selectCommand = (name: string) => { workspace.setDraft(`/${name} `); setCommandsDismissed(true); textarea.current?.focus(); };

  const active = worker ? ["running", "queued", "parked"].includes(worker.status) : ["working", "waiting"].includes(snapshot.session.status);
  const currentTurn = useMemo(() => reduceConversation(snapshot).at(-1), [snapshot]);
  const stopping = active && Boolean(currentTurn?.notices.some(notice => notice.startsWith("Cancellation requested.")));
  const startingWorkspace = active && !worker && snapshot.execution?.backend === "smolvm" && snapshot.execution.status === "pending";
  const environmentName = snapshot.execution?.backend === "smolvm" ? "SmolVM" : snapshot.execution?.backend === "local" ? "Local" : "Environment";
  const environmentStatus = snapshot.execution?.backend !== "smolvm" ? undefined : snapshot.execution.status === "pending" ? (active ? "Starting" : "Not started") : snapshot.execution.status[0].toUpperCase() + snapshot.execution.status.slice(1);
  const environmentSettings = `/settings?section=agents&session=${encodeURIComponent(snapshot.session.id)}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`;
  const closed = snapshot.session.status === "closed";
  const workerReadOnly = Boolean(worker && !["running", "queued", "parked"].includes(worker.status));
  const attachmentUI = useComposerAttachments({ attachments: workspace.attachments, onChange: workspace.setAttachments, disabled: !canWrite || workspace.busy || closed || workerReadOnly, worker: Boolean(worker) });
  const [composerFocused, setComposerFocused] = useState(false);
  const queuedShortcut = !worker && composerFocused && !workspace.draft.trim() && !workspace.attachments.length && !workspace.busy && canWrite && !closed && snapshot.queuedMessages.some(message => message.id === workspace.queuedShortcutId) ? workspace.queuedShortcutId : null;
  const showStop = active && !workspace.draft.trim() && !workspace.attachments.length;
  const submitAction = showStop ? stopping ? "Stopping response" : "Stop response" : active && !worker ? sendBehavior === "queue" ? "Queue message" : "Interrupt and send" : "Send message";
  const canSend = canWrite && !attachmentUI.loading && Boolean(workspace.draft.trim() || workspace.attachments.length) && workspace.draft.length <= 32000 && !workspace.busy && !closed && !workerReadOnly;
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    const resize = () => {
      node.style.height = "0px";
      node.style.height = `${Math.max(48, Math.min(node.scrollHeight, 240))}px`;
      node.style.overflowY = node.scrollHeight > 240 ? "auto" : "hidden";
    };
    resize();
    const observer = new ResizeObserver(entries => { if (entries.some(entry => entry.contentRect.width !== width)) { width = node.clientWidth; resize(); } });
    let width = node.clientWidth;
    observer.observe(node);
    return () => observer.disconnect();
  }, [workspace.draft]);
  if (workerReadOnly) return <div className="flex items-center justify-between gap-3 px-1 py-2 text-xs text-muted-foreground"><span>{worker?.status === "completed" ? "Complete" : "Stopped"}</span><Button variant="ghost" size="sm" onClick={() => navigate(`/console/${snapshot.session.id}`)}>Main conversation</Button></div>;
  return <div className={`shrink-0 bg-background ${worker ? "p-0" : "p-3 sm:px-6"}`}>
    <div className="mx-auto max-w-3xl">
      <div className="console-composer-stack">
      {!worker && <div className="console-workspace-bar flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-1"><BackendConnectionPicker /><FilePathPicker workspace={workspace} sessionId={snapshot.session.id} cwd={snapshot.workspacePath ?? snapshot.scopeEnforcement.projectPath} workspaceDisabled={!canWrite || active || workspace.busy || closed || snapshot.workers.some(item => ["queued", "running", "parked"].includes(item.status))} disabled={closed} /></div>
        {snapshot.execution?.backend === "smolvm" && <Tooltip content="Change environment for new chats"><Link to={environmentSettings} aria-label={`Environment: ${environmentName}${environmentStatus ? ` ${environmentStatus}` : ""}. Change environment for new chats`} className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">{snapshot.execution?.backend === "smolvm" ? <Box aria-hidden="true" className="size-3.5" /> : <Monitor aria-hidden="true" className="size-3.5" />}<span>{environmentName}</span>{environmentStatus && <span className="text-muted-foreground/70">· {environmentStatus}</span>}<ChevronDown aria-hidden="true" className="size-3" /></Link></Tooltip>}
        {stopping ? <span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><LoadingDots />Stopping…</span> : startingWorkspace && <WorkspaceStartup message={snapshot.execution?.message} runId={snapshot.execution?.runId} />}
      </div>}
      <div onDrop={attachmentUI.onDrop} onDragOver={attachmentUI.onDragOver} className="relative console-composer flex flex-col gap-2 p-3 focus-within:ring-2 focus-within:ring-primary/10">
        {attachmentUI.controls}
        <IntegrationPicker picker={integrations} />
        <ComposerPickerSurface open={commandsOpen} label="Commands" className="w-80 max-w-full">
          <div id="composer-command-list" role="listbox" aria-label="Slash commands" className="max-h-[280px] overflow-y-auto overscroll-contain">
            {commands.length ? commands.map((command, index) => <button key={command.name} id={`composer-command-${index}`} type="button" role="option" aria-selected={index === commandIndex} className={`ui-menu-item ui-menu-item--detail flex w-full items-center text-left focus-visible:outline-2 focus-visible:outline-ring ${index === commandIndex ? "bg-muted" : "hover:bg-muted/60"}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setCommandIndex(index)} onClick={() => selectCommand(command.name)}>
              <span className="min-w-28 shrink-0 font-medium">/{command.name}</span><span className="truncate text-muted-foreground">{COMMAND_SUMMARIES[command.name] ?? command.description.replace(/ \(TUI:.*\)/, "")}</span>
            </button>) : <p className="px-3 py-3 text-sm text-muted-foreground">No matching commands. Try /help.</p>}
          </div>
        </ComposerPickerSurface>
        <textarea autoFocus rows={1} autoComplete="off" data-1p-ignore data-lpignore="true" ref={textarea} aria-autocomplete="list" aria-controls={integrations.open ? integrations.textareaProps["aria-controls"] : commandsOpen ? "composer-command-list" : undefined} aria-expanded={commandsOpen || integrations.open} aria-activedescendant={integrations.open ? integrations.textareaProps["aria-activedescendant"] : commandsOpen && commands.length ? `composer-command-${commandIndex}` : undefined} aria-label={worker ? `Message ${worker.name}` : "Message Zero"} className="block min-h-9 max-h-60 w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground" value={workspace.draft} disabled={closed || readOnlyTeam} placeholder={closed ? "This conversation is closed." : worker ? "Message agent…" : active ? "Add a message…" : placeholder ?? "Ask Zero… / for commands"} onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onFocus={() => setComposerFocused(true)} onBlur={() => { setComposerFocused(false); workspace.dismissQueuedShortcut(); }} onChange={(event) => { workspace.dismissQueuedShortcut(); setCaret(event.target.selectionStart); workspace.setDraft(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (integrations.onKeyDown(event)) return; if (commandsOpen) { if (event.key === "Escape") { event.preventDefault(); setCommandsDismissed(true); return; } if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length); return; } if (commands.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); selectCommand(commands[commandIndex]!.name); return; } } if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSubmit(); else if (queuedShortcut && !event.repeat) void workspace.sendQueuedNow(queuedShortcut); } }} onPaste={attachmentUI.onPaste} />
        <div className="flex flex-wrap items-center gap-1">{!worker && <Tooltip content="Attach images or text files"><Button type="button" size="icon-sm" variant="ghost" aria-label="Attach images or text files" disabled={!canWrite || closed || workspace.busy || workerReadOnly || attachmentUI.loading} onClick={attachmentUI.open}><Plus className="size-4" /></Button></Tooltip>}{!worker && <ModePicker workspace={workspace} sessionId={snapshot.session.id} mode={snapshot.pendingConfiguration?.autonomyMode ?? snapshot.session.autonomyMode} deferred={active && snapshot.execution?.backend === "smolvm"} disabled={workspace.busy || closed || !canWrite} />}<div className="ml-auto flex flex-wrap items-center justify-end gap-1">{detailsControl}{!worker && <DropdownMenu onOpenChange={open => { setModelsOpen(open); if (open) setModelFilter(""); }}><Tooltip content={localRelay ? "Choose a model from local accounts" : "Choose model"}><DropdownMenu.Trigger aria-label="Choose model and thinking effort" disabled={active || workspace.busy || closed || !canWrite} className="flex max-w-44 sm:max-w-64 items-center gap-2 rounded-[var(--radius-control)] px-2 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"><button type="button">{snapshot.runtime?.providerId && <ProviderIcon providerId={snapshot.runtime.providerId} className="size-4 shrink-0" />}<span className="truncate">{snapshot.runtime?.model || "Model"}</span>{snapshot.runtime?.reasoning && snapshot.runtime.reasoning.options.length > 1 && <span className="shrink-0 text-muted-foreground/75">· {REASONING_LABELS[snapshot.runtime.reasoning.effort] ?? snapshot.runtime.reasoning.effort}</span>}<ChevronDown className="size-3 shrink-0" /></button></DropdownMenu.Trigger></Tooltip><DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="console-model-picker ui-menu-surface flex w-80 min-w-0 flex-col overflow-hidden font-sans"><ReasoningPicker inline workspace={workspace} sessionId={snapshot.session.id} reasoning={snapshot.runtime?.reasoning} disabled={active || workspace.busy || closed || !canWrite} />{localRelay && <p className="ui-menu-section">Local ChatGPT models</p>}<div className="shrink-0 pb-2"><Input className="h-8 rounded-[var(--radius-control)] px-3 text-sm" data-1p-ignore data-lpignore="true" autoComplete="off" autoFocus aria-label="Search models" placeholder="Search models and providers" value={modelFilter} onChange={event => setModelFilter(event.target.value)} onKeyDown={event => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
            }
            if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
          }} /></div><div className="min-h-0 overflow-y-auto overscroll-contain">
          {modelCatalog.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">Loading models…</div>}
          {modelCatalog.error && <div className="max-w-64 px-3 py-2 text-sm text-muted-foreground">{consoleErrorMessage(modelCatalog.error instanceof Error ? modelCatalog.error.message : "Could not load models")}</div>}
          {visibleModels.map((model) => <Tooltip key={`${model.provider}:${model.id}`} content={`${model.id} · ${model.provider}`} side="left"><DropdownMenu.Item aria-label={`${model.id} ${model.provider}`} icon={<ProviderIcon providerId={model.provider} className="size-4 shrink-0" />} selected={model.id === snapshot.runtime?.model && model.provider === snapshot.runtime?.providerId} className="ui-menu-item ui-menu-item--detail focus-visible:ring-0 data-highlighted:bg-muted" onClick={() => void workspace.perform(() => configureChatRuntime(chatApi,snapshot.session.id,{providerId:model.provider,model:model.id},snapshot.runtime))}><span className="min-w-0 flex-1"><span className="block truncate text-sm leading-5">{model.id}</span><span className="ui-menu-secondary block truncate">{model.provider === "chatgpt-codex" ? "ChatGPT" : model.provider === "openai" ? "OpenAI API" : model.provider}</span></span></DropdownMenu.Item></Tooltip>)}
          {modelCatalog.data && catalogModels.length > 0 && !catalogModels.some(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase())) && <div className="px-3 py-3 text-sm text-muted-foreground">No models match your search.</div>}
          {!modelCatalog.isFetching && modelDiagnostics.filter(item => !modelFilter || item.providerId.toLowerCase().includes(modelFilter.toLowerCase())).map(item => <div key={item.providerId} role="status" className="max-w-80 whitespace-normal px-3 py-2 text-xs text-muted-foreground">{item.providerId}: {item.message}</div>)}
          {!modelCatalog.isFetching && modelCatalog.data && catalogModels.length === 0 && !modelDiagnostics.length && <div className="px-3 py-2 text-sm text-muted-foreground">{localRelay ? "Connect ChatGPT locally to use models on this host." : "No models available. Manage connections below."}</div>}
          <DropdownMenu.Item icon={<Plus className="size-4 shrink-0" />} className="ui-menu-item" onClick={() => {if(localRelay)window.location.assign(backendRouteHref("local","/connections"));else navigate(`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`);}}>Manage connections</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Wrench className="size-4 shrink-0" />} className="ui-menu-item" onClick={() => {if(localRelay)window.location.assign(backendRouteHref("local","/models"));else navigate(`/models?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`);}}>Model settings</DropdownMenu.Item>
        </div></DropdownMenu.Content></DropdownMenu>}<span hidden={workspace.draft.length < 30000} className={`text-xs ${workspace.draft.length > 32000 ? "text-destructive" : "text-muted-foreground"}`}>{workspace.draft.length.toLocaleString()} / 32,000</span>{snapshot.queuedMessages.length > 0 && !worker && <QueuedMessages workspace={workspace} snapshot={snapshot} />}<Tooltip content={showStop ? submitAction : `${submitAction}. Shift+Enter for a new line.`} shortcut={showStop || commandsOpen || integrations.open ? undefined : "Enter"}><Button size="icon-sm" aria-label={showStop ? stopping ? "Stopping response" : "Stop response" : workspace.busy ? "Sending message" : "Send message"} aria-busy={workspace.busy || stopping} disabled={showStop ? workspace.busy || stopping || !canWrite : !canSend} onClick={showStop ? onStop : onSubmit}>{workspace.busy || stopping ? <LoadingDots className="scale-75" /> : showStop ? <Square className="size-3.5" /> : <ArrowUp className="size-4" />}</Button></Tooltip></div></div>
      </div>
      </div>
      {queuedShortcut && <p role="status" className="mt-2 px-1 text-xs text-muted-foreground">Queued. Press Enter again to send now and interrupt the current response.</p>}
      {workerReadOnly && <p role="status" className="mt-2 text-xs text-muted-foreground">This sub-agent is done. Switch to the main conversation to continue.</p>}

    </div>
  </div>;
}
