import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { consoleErrorMessage, needsProviderSignIn } from "./provider-error";
import { ArrowDown, ArrowUp, Box, Monitor, ChevronDown, Plus, FolderSearch, ListChecks, ShieldCheck, Square, Wrench } from "lucide-react";
import type { ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleDecisionResponse } from "@0/shared";
import { SLASH_COMMANDS } from "@0/shared/dist/slash-commands.js";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/provider-icon";
import { ReasoningPicker } from "./reasoning-picker";
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
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { useBackendApi } from "@/api";
import { Markdown } from "./markdown";
import { ComposerPickerSurface, IntegrationPicker, useIntegrationPicker } from "./integration-picker";
import { ActivityIndicator, LoadingDots } from "./loading-state";
import { ApprovalPanel } from "./approvals";
import { ActivityRow } from "./activity-row";
import { ToolActivity } from "./tool-activity";
import { reduceConversation } from "./transcript";
import type { ConsoleWorkspace } from "./use-console-workspace";

function WorkerConversation({ worker }: { worker: ConsoleWorker }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border p-4 text-sm"><div className="font-medium">{worker.name}</div><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{worker.task}</p></div>
      {worker.operatorMessages?.length ? <details className="rounded-lg border border-border p-3 text-xs" open><summary className="cursor-pointer text-muted-foreground">Your messages to {worker.name}</summary><div className="mt-3 space-y-3">{worker.operatorMessages.map((message) => <div key={message.id} className="rounded-md bg-muted/30 p-3"><div className="mb-1 text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleTimeString()}</div><div className="whitespace-pre-wrap break-words">{message.text}</div></div>)}</div></details> : null}
      {worker.transcript.map((turn) => <article key={turn.turn} className="space-y-3">
        <ToolActivity calls={(turn.tools ?? []).map(tool => ({ id: tool.call.id ?? `${turn.turn}-${tool.callIndex}`, name: tool.call.name, arguments: tool.call.arguments, result: tool.result, isRunning: tool.running ?? false }))} reasoning={turn.reasoning_summary} working={Boolean(turn.tools?.some(tool => tool.running))} />
        {turn.assistant && <Markdown text={turn.assistant} />}
      </article>)}
      {["running", "queued", "parked"].includes(worker.status) && <ActivityIndicator waiting={worker.status !== "running"} label={worker.status === "queued" ? "Queued" : worker.status === "parked" ? "Waiting for you" : "Working…"} />}
      {worker.summary && <Markdown text={worker.summary} />}
      {worker.error && <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{worker.error}</div>}
    </div>
  );
}

export function Conversation({ workspace, worker, onResolve, onSubmit, onStop, resumeCap, sendBehavior }: {
  workspace: ConsoleWorkspace;
  worker: ConsoleWorker | undefined;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSubmit: () => void;
  onStop: () => void;
  resumeCap: () => void;
  sendBehavior: SendBehavior;
}) {
  const snapshot = workspace.snapshot;
  const turns = useMemo(() => snapshot ? reduceConversation(snapshot) : [], [snapshot]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const conversationKey = `${snapshot?.session.id ?? ""}:${worker?.id ?? "root"}`;
  useLayoutEffect(() => {
    nearBottom.current = true;
    setShowJump(false);
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [conversationKey, turns.length === 0]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const viewport = scroller.current;
      if (!viewport) return;
      if (nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
      else setShowJump(true);
      setMoreBelow(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [conversationKey, turns.length === 0]);
  if (!snapshot) return null;
  const active = ["working", "waiting"].includes(snapshot.session.status);
  const empty = !worker && turns.length === 0 && snapshot.pendingDecisions.length === 0;
  if (empty) return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Home">
    <section className="flex min-h-full flex-col justify-center pb-20 pt-8">
      <div className="mx-auto w-full max-w-3xl px-3 py-5 text-center sm:px-6">
        <div className="mb-8 flex justify-center"><AgentOnboarding /></div>
        <BrandMark className="mb-7" />
        <h2 className="font-heading text-xl">What would you like to hack and fix today?</h2>
      </div>
      <Composer sendBehavior={sendBehavior} workspace={workspace} snapshot={snapshot} worker={worker} onSubmit={onSubmit} onStop={onStop} />
      <ContextSuggestions snapshot={snapshot} onChoose={prompt => { workspace.setDraft(prompt); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus()); }} />
    </section>
    <HomeAnalytics />
  </div>;
  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${empty ? "justify-center pb-20" : ""}`}>
      <div ref={scroller} data-scrolled={scrolled} data-more-below={moreBelow} className={`console-transcript-scroller min-h-0 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 ${empty ? "flex-none" : "flex-1"}`} onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        setScrolled(node.scrollTop > 8);
        setMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 8);
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        if (nearBottom.current) setShowJump(false);
      }} aria-label={worker ? `${worker.name} conversation` : "Conversation"}>
        <div ref={content} className="mx-auto max-w-3xl space-y-7">
          {worker ? <WorkerConversation worker={worker} /> : turns.length ? turns.map((turn) => <article key={turn.id} className="space-y-3">
            {turn.user.text && <div className="ml-auto min-w-0 max-w-[92%] console-message-surface bg-muted/50 px-4 py-3 text-sm break-words [&_p]:whitespace-pre-wrap"><Markdown text={turn.user.text} /></div>}
            {(turn.toolCalls.length > 0 || turn.reasoningText) && <ToolActivity calls={turn.toolCalls} reasoning={turn.reasoningText} working={turn.isWorking} />}
            {turn.decisions.filter((decision) => decision.resolved).map((decision) => <ActivityRow key={decision.id} icon={<ShieldCheck />} title={`${decision.title} · ${decision.approved === undefined ? "closed" : decision.approved ? decision.kind === "operator-question" ? "answered" : "approved" : "declined"}`} status=""><ApprovalPanel decision={decision} busy={workspace.busy} onResolve={(response) => onResolve(decision.id, response)} /></ActivityRow>)}
            {turn.assistantText && <Markdown text={turn.assistantText} streaming={turn.isWorking && snapshot.session.status === "working"} />}
            {turn.notices.filter(notice => !notice.startsWith("Cancellation requested.")).map((notice, index) => <p key={index} className="border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{notice.startsWith("Cancellation requested.") ? "Stop requested" : notice}</p>)}
            {(turn.stopReason === "cancelled" || turn.error?.startsWith("Workbench cancelled")) && <p role="status" className="text-xs text-muted-foreground">Stopped</p>}
            {turn.error && !turn.error.startsWith("Workbench cancelled") && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm whitespace-pre-wrap text-destructive">{consoleErrorMessage(turn.error)}{needsProviderSignIn(turn.error) && <Button asChild variant="default" size="sm" className="mt-3 flex w-fit"><Link to={`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`}>Manage connection</Link></Button>}</div>}
            {turn.isWorking && (turn.notices.some(notice => notice.startsWith("Cancellation requested.")) || snapshot.session.status === "waiting" || (!turn.assistantText && turn.toolCalls.length === 0 && !turn.reasoningText)) && <ActivityIndicator waiting={snapshot.session.status === "waiting"} label={turn.notices.some(notice => notice.startsWith("Cancellation requested.")) ? "Stopping…" : snapshot.session.status === "waiting" ? "Waiting for your decision" : turn.toolCalls.some((call) => call.isRunning) ? "Running tools…" : turn.assistantText ? "Responding…" : "Thinking…"} />}
          </article>) : <div className="py-4 text-center"><div className="mb-8 flex justify-center"><AgentOnboarding /></div><BrandMark className="mb-7" /><h2 className="font-heading text-xl">What would you like to hack and fix today?</h2></div>}
          {snapshot.lastOutcome?.outputCap && !worker && <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><div className="font-medium">0 hit its output limit</div><Button className="mt-3" size="sm" disabled={workspace.busy || active} onClick={resumeCap}>Keep going</Button></div>}
          {snapshot.pendingDecisions.map((decision) => <div key={decision.id} className="space-y-2"><ApprovalPanel decision={decision} busy={workspace.busy} onResolve={(response) => onResolve(decision.id, response)} /></div>)}
        </div>
      </div>
      {showJump && <Button variant="secondary" size="sm" className="absolute bottom-[10rem] left-1/2 z-10 -translate-x-1/2 shadow-lg" onClick={() => { const node = scroller.current; if (node) node.scrollTo({ top: node.scrollHeight, behavior: document.documentElement.dataset.reducedMotion === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); nearBottom.current = true; setShowJump(false); }}><ArrowDown className="size-3.5" />Latest</Button>}
      <Composer sendBehavior={sendBehavior} workspace={workspace} snapshot={snapshot} worker={worker} onSubmit={onSubmit} onStop={onStop} />
      {empty && <ContextSuggestions snapshot={snapshot} onChoose={prompt => { workspace.setDraft(prompt); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus()); }} />}

    </div>
  );
}

function ContextSuggestions({ snapshot, onChoose }: { snapshot: ConsoleSessionSnapshot; onChoose: (prompt: string) => void }) {
  const target = snapshot.localScopePath || snapshot.session.target;
  const finding = snapshot.focusedFinding;
  const unfinished = snapshot.todos?.todos.find(todo => todo.status !== "completed" && todo.status !== "cancelled");
  const suggestions = finding ? [
    { icon: ShieldCheck, text: `Review the evidence for ${finding.title}`, prompt: `Review the stored evidence for the focused finding "${finding.title}" and explain what is confirmed and what needs verification.` },
    { icon: ListChecks, text: "Plan a verification", prompt: "Propose a bounded verification plan for the focused finding. Ask for any scope or permissions needed before executing." },
    { icon: FolderSearch, text: "Explore remediation options", prompt: "Explain remediation options for the focused finding, including a regression check. Start with a proposal." },
  ] : target ? [
    { icon: FolderSearch, text: `Review ${target}`, prompt: `Review ${target} for security issues. Start by outlining the scope and evidence to inspect.` },
    { icon: ShieldCheck, text: "Check dependencies and configuration", prompt: `Inspect dependencies and configuration for ${target}, and distinguish verified issues from unconfirmed concerns.` },
    { icon: ListChecks, text: unfinished ? `Continue: ${unfinished.content}` : "Create a focused review plan", prompt: unfinished ? `Continue the pending task: ${unfinished.content}. Use the preserved context and avoid repeating completed work.` : `Create a focused security review plan for ${target}, with explicit time and cost limits before execution.` },
  ] : [
    { icon: FolderSearch, text: "Review a codebase", prompt: "Help me review a codebase for security issues. Ask which local directory to use and establish the scope first." },
    { icon: ShieldCheck, text: "Investigate a security question", prompt: "Help me investigate a security question. Ask for the relevant evidence and constraints first." },
    { icon: ListChecks, text: "Plan a workflow", prompt: "Help me plan a security workflow. Ask for the target, authorized scope, and time and cost limits." },
  ];
  return <div aria-label="Suggested prompts" className="mx-auto w-full max-w-3xl space-y-1 px-3 pt-3 sm:px-6">{suggestions.map(({ icon: Icon, text, prompt }) => <Tooltip key={text} content={prompt} preview><button type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onChoose(prompt)}><Icon className="size-4 shrink-0" /><span className="truncate">{text}</span></button></Tooltip>)}</div>;
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

function Composer({ workspace, snapshot, worker, onSubmit, onStop, sendBehavior }: { sendBehavior: SendBehavior; workspace: ConsoleWorkspace; snapshot: ConsoleSessionSnapshot; worker?: ConsoleWorker; onSubmit: () => void; onStop: () => void }) {
  const { configureConsoleSession, webFetchJson } = useBackendApi();
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
  const modelCatalog = useQuery({ queryKey: ["console-models", "all", snapshot.runtime?.connectionIdentity], enabled: modelsOpen, queryFn: ({ signal }) => webFetchJson<ModelsResponse>("/api/console/models", { signal }) });
  const visibleModels = useMemo(() => {
    const rank = (model: ModelsResponse["models"][number]) => {
      if (model.provider === snapshot.runtime?.providerId && model.id === snapshot.runtime?.model) return 0;
      if (model.provider === snapshot.runtime?.providerId) return 1;
      if (model.provider === "openai") return 2;
      if (model.provider === "chatgpt-codex") return 3;
      return 4;
    };
    const models = new Map<string, ModelsResponse["models"][number]>();
    for (const model of (modelCatalog.isFetching || modelCatalog.isError ? [] : modelCatalog.data?.models ?? [])) {
      const key = `${model.provider}:${model.id}`;
      if (!models.has(key) || model.source === "account") models.set(key, model);
    }
    return [...models.values()]
      .filter(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b)
        || Number(/^gpt-[0-9]/.test(b.id)) - Number(/^gpt-[0-9]/.test(a.id))
        || b.id.localeCompare(a.id, undefined, { numeric: true })
        || a.provider.localeCompare(b.provider));
  }, [modelCatalog.data, modelCatalog.isFetching, modelCatalog.isError, modelFilter, snapshot.runtime?.providerId, snapshot.runtime?.model]);
  const [pasteNotice, setPasteNotice] = useState("");
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
  const environmentStatus = snapshot.execution?.status === "pending" ? (active ? "Starting" : "Not started") : snapshot.execution?.status ? snapshot.execution.status[0].toUpperCase() + snapshot.execution.status.slice(1) : undefined;
  const environmentSettings = `/settings?section=agents&session=${encodeURIComponent(snapshot.session.id)}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`;
  const closed = snapshot.session.status === "closed";
  const workerReadOnly = Boolean(worker && !["running", "queued", "parked"].includes(worker.status));
  const canSend = Boolean(workspace.draft.trim()) && workspace.draft.length <= 32000 && !workspace.busy && !closed && !workerReadOnly;
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
  return <div className="shrink-0  bg-background p-3 sm:px-6">
    <div className="mx-auto max-w-3xl">
      <div className="console-composer-stack">
      <div className="console-workspace-bar flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-1"><BackendConnectionPicker /><FilePathPicker workspace={workspace} sessionId={snapshot.session.id} cwd={snapshot.workspacePath ?? snapshot.scopeEnforcement.projectPath} workspaceDisabled={active || workspace.busy || closed || snapshot.workers.some(item => ["queued", "running", "parked"].includes(item.status))} disabled={closed} /></div>
        <Tooltip content="Change environment for new chats"><Link to={environmentSettings} aria-label={`Environment: ${environmentName}${environmentStatus ? ` ${environmentStatus}` : ""}. Change environment for new chats`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">{snapshot.execution?.backend === "smolvm" ? <Box aria-hidden="true" className="size-3.5" /> : <Monitor aria-hidden="true" className="size-3.5" />}<span>{environmentName}</span>{environmentStatus && <span className="text-muted-foreground/70">· {environmentStatus}</span>}<ChevronDown aria-hidden="true" className="size-3" /></Link></Tooltip>
        {stopping ? <span role="status" className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><LoadingDots />Stopping…</span> : startingWorkspace && <WorkspaceStartup message={snapshot.execution?.message} runId={snapshot.execution?.runId} />}
      </div>
      <div className="relative console-composer flex flex-col gap-3 p-3 focus-within:ring-2 focus-within:ring-primary/10">
        <IntegrationPicker picker={integrations} />
        <ComposerPickerSurface open={commandsOpen} label="Commands" className="right-0">
          <div id="composer-command-list" role="listbox" aria-label="Slash commands" className="max-h-[280px] overflow-y-auto overscroll-contain">
            {commands.length ? commands.map((command, index) => <button key={command.name} id={`composer-command-${index}`} type="button" role="option" aria-selected={index === commandIndex} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-100 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-primary ${index === commandIndex ? "bg-muted" : "hover:bg-muted/60"}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setCommandIndex(index)} onClick={() => selectCommand(command.name)}>
              <span className="min-w-28 shrink-0 font-medium">/{command.name}</span><span className="truncate text-muted-foreground">{COMMAND_SUMMARIES[command.name] ?? command.description.replace(/ \(TUI:.*\)/, "")}</span>
            </button>) : <p className="px-3 py-3 text-sm text-muted-foreground">No matching commands. Try /help.</p>}
          </div>
        </ComposerPickerSurface>
        <textarea rows={1} autoComplete="off" data-1p-ignore data-lpignore="true" ref={textarea} aria-autocomplete="list" aria-controls={integrations.open ? integrations.textareaProps["aria-controls"] : commandsOpen ? "composer-command-list" : undefined} aria-expanded={commandsOpen || integrations.open} aria-activedescendant={integrations.open ? integrations.textareaProps["aria-activedescendant"] : commandsOpen && commands.length ? `composer-command-${commandIndex}` : undefined} aria-label={worker ? `Message ${worker.name}` : "Message Zero"} className="block min-h-12 max-h-60 w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground" value={workspace.draft} disabled={closed} placeholder={closed ? "This conversation is closed." : worker ? `Message ${worker.name}…` : active ? "Add a message…" : "Ask Zero… / for commands"} onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onChange={(event) => { setCaret(event.target.selectionStart); workspace.setDraft(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (integrations.onKeyDown(event)) return; if (commandsOpen) { if (event.key === "Escape") { event.preventDefault(); setCommandsDismissed(true); return; } if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length); return; } if (commands.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); selectCommand(commands[commandIndex]!.name); return; } } if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSubmit(); } }} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); setPasteNotice("Files can't be pasted. Use + to add a file path instead."); } else { const text = event.clipboardData.getData("text/plain"); setPasteNotice(text.length + workspace.draft.length > 32000 ? "Message is too long. Shorten it to under 32,000 characters." : ""); } }} />
        <div className="flex flex-wrap items-center gap-1">{!worker && <ModePicker workspace={workspace} sessionId={snapshot.session.id} mode={snapshot.session.autonomyMode} disabled={active || workspace.busy || closed} />}<div className="ml-auto flex flex-wrap items-center justify-end gap-1">{!worker && <ReasoningPicker workspace={workspace} sessionId={snapshot.session.id} reasoning={snapshot.runtime?.reasoning} disabled={active || workspace.busy || closed} />}{!worker && <DropdownMenu onOpenChange={open => { setModelsOpen(open); if (open) setModelFilter(""); }}><Tooltip content="Choose model"><DropdownMenu.Trigger aria-label="Choose model" disabled={active || workspace.busy || closed} className="flex max-w-28 sm:max-w-44 items-center gap-2 rounded-full px-2 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"><button type="button">{snapshot.runtime?.providerId && <ProviderIcon providerId={snapshot.runtime.providerId} className="size-4 shrink-0" />}<span className="truncate">{snapshot.runtime?.model || "Model"}</span><ChevronDown className="size-3 shrink-0" /></button></DropdownMenu.Trigger></Tooltip><DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="w-[280px] max-w-[calc(100vw-24px)] max-h-[min(256px,var(--available-height))] rounded-lg flex flex-col overflow-hidden p-2 font-sans"><div className="shrink-0 pb-2"><Input className="h-8 rounded-xl px-3 text-sm" data-1p-ignore data-lpignore="true" autoComplete="off" aria-label="Search models" placeholder="Search models and providers" value={modelFilter} onChange={event => setModelFilter(event.target.value)} onKeyDown={event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }} /></div><div className="min-h-0 overflow-y-auto overscroll-contain">
          {modelCatalog.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">Loading models…</div>}
          {modelCatalog.error && <div className="max-w-64 px-3 py-2 text-sm text-muted-foreground">{consoleErrorMessage(modelCatalog.error instanceof Error ? modelCatalog.error.message : "Could not load models")}</div>}
          {visibleModels.map((model) => <DropdownMenu.Item key={`${model.provider}:${model.id}`} aria-label={`${model.id} ${model.provider}`} title={`${model.id} · ${model.provider}`} icon={<ProviderIcon providerId={model.provider} className="size-4 shrink-0" />} selected={model.id === snapshot.runtime?.model && model.provider === snapshot.runtime?.providerId} className="h-9 gap-2.5 rounded-xl px-3 py-2 text-sm focus-visible:ring-0 data-highlighted:bg-muted transition-colors duration-100 motion-reduce:transition-none" onClick={() => void workspace.perform(() => configureConsoleSession(snapshot.session.id, { runtime: { providerId: model.provider, model: model.id } }))}><span className="min-w-0 flex-1 truncate text-sm leading-5">{model.id}</span></DropdownMenu.Item>)}
          {modelCatalog.data && modelCatalog.data.models.length > 0 && !modelCatalog.data.models.some(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase())) && <div className="px-3 py-3 text-sm text-muted-foreground">No models match your search.</div>}
          {!modelCatalog.isFetching && modelCatalog.data?.diagnostics.filter(item => !modelFilter || item.providerId.toLowerCase().includes(modelFilter.toLowerCase())).map(item => <div key={item.providerId} role="status" className="max-w-80 whitespace-normal px-3 py-2 text-xs text-muted-foreground">{item.providerId}: {item.message}</div>)}
          {!modelCatalog.isFetching && modelCatalog.data && modelCatalog.data.models.length === 0 && !modelCatalog.data.diagnostics.length && <div className="px-3 py-2 text-sm text-muted-foreground">No models available. Manage connections below.</div>}
          <DropdownMenu.Item icon={<Plus className="size-4 shrink-0" />} className="gap-3 rounded-xl px-3 py-2 text-sm" onClick={() => navigate(`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`)}>Manage connections</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Wrench className="size-4 shrink-0" />} className="gap-3 rounded-xl px-3 py-2 text-sm" onClick={() => navigate(`/models?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`)}>Model settings</DropdownMenu.Item>
        </div></DropdownMenu.Content></DropdownMenu>}<span hidden={workspace.draft.length < 30000} className={`text-xs ${workspace.draft.length > 32000 ? "text-destructive" : "text-muted-foreground"}`}>{workspace.draft.length.toLocaleString()} / 32,000</span>{snapshot.queuedMessages.length > 0 && !worker && <QueuedMessages workspace={workspace} snapshot={snapshot} />}{active && <Button variant="outline" size="sm" disabled={workspace.busy || stopping} onClick={onStop}><Square className="size-3" />{stopping ? "Stopping…" : "Stop"}</Button>}<Button size="icon-sm" title={active && !worker ? sendBehavior === "queue" ? "Send when done" : "Interrupt and send" : "Send message"} aria-label={workspace.busy ? "Sending message" : "Send message"} aria-busy={workspace.busy} disabled={!canSend} onClick={onSubmit}>{workspace.busy ? <LoadingDots className="scale-75" /> : <ArrowUp className="size-4" />}</Button></div></div>
      </div>
      </div>
      {workerReadOnly && <p role="status" className="mt-2 text-xs text-muted-foreground">This sub-agent is done. Switch to the main conversation to continue.</p>}
      {pasteNotice && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{pasteNotice}</p>}
    </div>
  </div>;
}
