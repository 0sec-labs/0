import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { consoleErrorMessage, needsProviderSignIn } from "./provider-error";
import { ArrowDown, ArrowUp, ChevronDown, Plus, FolderSearch, ListChecks, ShieldCheck, Square, Wrench } from "lucide-react";
import type { ConsoleSessionSnapshot, ConsoleWorker, DesktopConsoleDecisionResponse } from "@0/shared";
import { SLASH_COMMANDS } from "@0/shared/dist/slash-commands.js";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/provider-icon";
import { AgentOnboarding } from "./agent-onboarding";
import { BrandMark } from "@/components/brand-mark";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import type { ModelsResponse } from "@/components/console-control/contracts";
import { configureConsoleSession, webFetchJson, removeConsoleQueuedMessage } from "@/api";
import { Markdown } from "./markdown";
import { ComposerPickerSurface, IntegrationPicker, useIntegrationPicker } from "./integration-picker";
import { ActivityIndicator, LoadingDots } from "./loading-state";
import { ApprovalPanel } from "./approvals";
import { ActivityRow } from "./activity-row";
import { toolCallStatus } from "./tool-call-status";
import { reduceConversation, type ToolCallState } from "./transcript";
import type { ConsoleWorkspace } from "./use-console-workspace";

export function ToolResult({ call }: { call: ToolCallState }) {
  const argumentsText = useMemo(() => typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2) ?? "", [call.arguments]);
  const resultText = useMemo(() => typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2) ?? "", [call.result]);
  const status = toolCallStatus(call);
  return (
    <ActivityRow icon={<Wrench />} title={call.name} status={status} running={call.isRunning} failed={status === "Error"}>
      <div className="space-y-3">
        <div><div className="mb-1 text-muted-foreground">Input</div><pre tabIndex={0} aria-label={`${call.name} input`} className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">{argumentsText}</pre></div>
        {call.result !== undefined && <div><div className="mb-1 text-muted-foreground">Output</div><pre tabIndex={0} aria-label={`${call.name} output`} className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono">{resultText}</pre></div>}
        {call.isRunning && <ActivityIndicator label="Running tool…" />}
      </div>
    </ActivityRow>
  );
}

function WorkerConversation({ worker }: { worker: ConsoleWorker }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border p-4 text-sm"><div className="font-medium">{worker.name}</div><p className="mt-2 whitespace-pre-wrap text-muted-foreground">{worker.task}</p></div>
      {worker.operatorMessages?.length ? <details className="rounded-lg border border-border p-3 text-xs" open><summary className="cursor-pointer text-muted-foreground">Your messages to {worker.name}</summary><div className="mt-3 space-y-3">{worker.operatorMessages.map((message) => <div key={message.id} className="rounded-md bg-muted/30 p-3"><div className="mb-1 text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleTimeString()}</div><div className="whitespace-pre-wrap break-words">{message.text}</div></div>)}</div></details> : null}
      {worker.transcript.map((turn) => <article key={turn.turn} className="console-entry space-y-3">
        {turn.reasoning_summary && <details className="rounded-lg border border-border p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Reasoning</summary><p className="mt-2 whitespace-pre-wrap">{turn.reasoning_summary}</p></details>}
        {turn.tools?.map((tool) => <ToolResult key={tool.callIndex} call={{ id: tool.call.id ?? `${turn.turn}-${tool.callIndex}`, name: tool.call.name, arguments: tool.call.arguments, result: tool.result, isRunning: tool.running ?? false }} />)}
        {turn.assistant && <Markdown text={turn.assistant} />}
      </article>)}
      {["running", "queued", "parked"].includes(worker.status) && <ActivityIndicator waiting={worker.status !== "running"} label={worker.status === "queued" ? "Queued" : worker.status === "parked" ? "Waiting for you" : "Working…"} />}
      {worker.summary && <Markdown text={worker.summary} />}
      {worker.error && <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{worker.error}</div>}
    </div>
  );
}

export function Conversation({ workspace, worker, onResolve, onSubmit, onStop, resumeCap }: {
  workspace: ConsoleWorkspace;
  worker: ConsoleWorker | undefined;
  onResolve: (decisionId: string, response: DesktopConsoleDecisionResponse) => void;
  onSubmit: () => void;
  onStop: () => void;
  resumeCap: () => void;
}) {
  const snapshot = workspace.snapshot;
  const turns = useMemo(() => snapshot ? reduceConversation(snapshot) : [], [snapshot]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const conversationKey = `${snapshot?.session.id ?? ""}:${worker?.id ?? "root"}`;
  useLayoutEffect(() => {
    nearBottom.current = true;
    setShowJump(false);
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [conversationKey]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const viewport = scroller.current;
      if (!viewport) return;
      if (nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
      else setShowJump(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [conversationKey]);
  if (!snapshot) return null;
  const active = ["working", "waiting"].includes(snapshot.session.status);
  const empty = !worker && turns.length === 0 && snapshot.pendingDecisions.length === 0;
  return (
    <div className={`relative flex min-h-0 flex-1 flex-col ${empty ? "justify-center pb-20" : ""}`}>
      <div ref={scroller} className={`min-h-0 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6 ${empty ? "flex-none" : "flex-1"}`} onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        if (nearBottom.current) setShowJump(false);
      }} aria-label={worker ? `${worker.name} conversation` : "Conversation"}>
        <div ref={content} className="mx-auto max-w-3xl space-y-7">
          {worker ? <WorkerConversation worker={worker} /> : turns.length ? turns.map((turn) => <article key={turn.id} className="console-entry space-y-3">
            {turn.user.text && <div className="ml-auto max-w-[92%] rounded-2xl rounded-br-sm bg-muted/50 px-4 py-3 text-sm whitespace-pre-wrap break-words">{turn.user.text}</div>}
            {turn.reasoningText && <details className="rounded-lg border border-border bg-muted/10 p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Reasoning</summary><div className="mt-3 whitespace-pre-wrap leading-6">{turn.reasoningText}</div></details>}
            {turn.toolCalls.map((call) => <ToolResult key={call.id} call={call} />)}
            {turn.decisions.filter((decision) => decision.resolved).map((decision) => <ActivityRow key={decision.id} icon={<ShieldCheck />} title={`${decision.title} · ${decision.approved === undefined ? "closed" : decision.approved ? "approved" : "declined"}`} status=""><ApprovalPanel decision={decision} busy={workspace.busy} onResolve={(response) => onResolve(decision.id, response)} /></ActivityRow>)}
            {turn.assistantText && <Markdown text={turn.assistantText} />}
            {turn.notices.map((notice, index) => <p key={index} className="border-l-2 border-border pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{notice}</p>)}
            {turn.error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm whitespace-pre-wrap text-destructive">{consoleErrorMessage(turn.error)}{needsProviderSignIn(turn.error) && <Button asChild variant="default" size="sm" className="mt-3 flex w-fit"><Link to={`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`}>Manage connection</Link></Button>}</div>}
            {turn.isWorking && <ActivityIndicator waiting={snapshot.session.status === "waiting"} label={snapshot.session.status === "waiting" ? "Waiting for your decision" : turn.toolCalls.some((call) => call.isRunning) ? "Running tools…" : turn.assistantText ? "Responding…" : "Thinking…"} />}
          </article>) : <div className="py-4 text-center"><div className="mb-8 flex justify-center"><AgentOnboarding sessionId={snapshot.session.id} /></div><BrandMark className="mb-7" /><h2 className="font-heading text-xl">What would you like to work on?</h2></div>}
          {snapshot.lastOutcome?.outputCap && !worker && <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm"><div className="font-medium">0 hit its output limit</div><Button className="mt-3" size="sm" disabled={workspace.busy || active} onClick={resumeCap}>Keep going</Button></div>}
          {snapshot.pendingDecisions.map((decision) => <div key={decision.id} className="space-y-2"><ApprovalPanel decision={decision} busy={workspace.busy} onResolve={(response) => onResolve(decision.id, response)} /></div>)}
        </div>
      </div>
      {showJump && <Button variant="secondary" size="sm" className="absolute bottom-[10rem] left-1/2 z-10 -translate-x-1/2 shadow-lg" onClick={() => { const node = scroller.current; if (node) node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); nearBottom.current = true; setShowJump(false); }}><ArrowDown className="size-3.5" />Latest</Button>}
      <Composer workspace={workspace} snapshot={snapshot} worker={worker} onSubmit={onSubmit} onStop={onStop} />
      {empty && !workspace.draft && <ContextSuggestions snapshot={snapshot} onChoose={prompt => { workspace.setDraft(prompt); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus()); }} />}

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
    { icon: ListChecks, text: "Plan an assessment", prompt: "Help me plan a security assessment. Ask for the target, authorized scope, and time and cost limits." },
  ];
  return <div aria-label="Suggested prompts" className="mx-auto w-full max-w-3xl space-y-1 px-3 pt-3 sm:px-6">{suggestions.map(({ icon: Icon, text, prompt }) => <button key={text} type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onChoose(prompt)}><Icon className="size-4 shrink-0" /><span className="truncate">{text}</span></button>)}</div>;
}

const COMMAND_SUMMARIES: Record<string, string> = {
  help: "Browse commands", capabilities: "Explore what 0 can do", status: "Check this conversation", tools: "Browse available tools",
  "new-chat": "Start a new conversation", onboard: "Open guided setup", clear: "Clear this conversation", history: "Browse previous runs",
  findings: "Review findings", fix: "Prepare a fix for review", copy: "Export this conversation", sessions: "Switch conversations",
  explain: "Get a simpler explanation", feedback: "Share feedback", settings: "Manage preferences", keybindings: "View keyboard shortcuts",
  theme: "Change appearance", model: "Choose a model", chat: "Return to chat", ops: "Open dashboard", hackstore: "Browse integrations",
  connect: "Connect a provider", usage: "Check usage and cost", back: "Go back", scope: "Manage approved scope", doctor: "Check your setup", exit: "Close this conversation",
};

function Composer({ workspace, snapshot, worker, onSubmit, onStop }: { workspace: ConsoleWorkspace; snapshot: ConsoleSessionSnapshot; worker?: ConsoleWorker; onSubmit: () => void; onStop: () => void }) {
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
  const modelCatalog = useQuery({ queryKey: ["console-models", snapshot.runtime?.providerId], enabled: modelsOpen, queryFn: ({ signal }) => webFetchJson<ModelsResponse>("/api/console/models", { signal }) });
  const [pathOpen, setPathOpen] = useState(false);
  const [path, setPath] = useState("");
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
  const closed = snapshot.session.status === "closed";
  const workerReadOnly = Boolean(worker && !["running", "queued", "parked"].includes(worker.status));
  const canSend = Boolean(workspace.draft.trim()) && workspace.draft.length <= 32000 && !workspace.busy && !closed && !workerReadOnly;
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    const resize = () => {
      node.style.height = "0px";
      node.style.height = `${Math.max(32, Math.min(node.scrollHeight, 240))}px`;
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
      {snapshot.queuedMessages.length > 0 && <details className="mb-2 rounded-lg border border-border px-3 py-2 text-xs">
        <summary className="cursor-pointer">{snapshot.queuedMessages.length} queued message{snapshot.queuedMessages.length === 1 ? "" : "s"}</summary>
        <ol className="mt-2 space-y-2">{snapshot.queuedMessages.map((message) => <li key={message.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-2"><div className="min-w-0 whitespace-pre-wrap break-words">{message.text}</div><Button variant="outline" size="xs" disabled={workspace.busy} onClick={() => void workspace.perform(() => removeConsoleQueuedMessage(snapshot.session.id, message.id))}>Remove</Button></li>)}</ol>
        <Button className="mt-3" variant="outline" size="xs" disabled={workspace.busy} onClick={() => void workspace.perform(() => removeConsoleQueuedMessage(snapshot.session.id))}>Remove all</Button>
      </details>}
      {pathOpen && <form className="mb-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (!path.trim()) return; workspace.setDraft(`${workspace.draft}${workspace.draft ? "\n" : ""}Local path reference: ${path.trim()}`); setPath(""); setPathOpen(false); textarea.current?.focus(); }}><Input aria-label="File or folder path" autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path/to/file-or-folder" /><Button type="submit" size="sm" disabled={!path.trim()}>Add</Button><Button type="button" variant="ghost" size="sm" onClick={() => setPathOpen(false)}>Cancel</Button></form>}
      <div className="relative console-composer grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2 p-3 focus-within:ring-2 focus-within:ring-primary/10">
        <IntegrationPicker picker={integrations} />
        <ComposerPickerSurface open={commandsOpen} label="Commands" className="right-0">
          <div id="composer-command-list" role="listbox" aria-label="Slash commands" className="max-h-[280px] overflow-y-auto overscroll-contain">
            {commands.length ? commands.map((command, index) => <button key={command.name} id={`composer-command-${index}`} type="button" role="option" aria-selected={index === commandIndex} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-100 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-primary ${index === commandIndex ? "bg-muted" : "hover:bg-muted/60"}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setCommandIndex(index)} onClick={() => selectCommand(command.name)}>
              <span className="min-w-28 shrink-0 font-medium">/{command.name}</span><span className="truncate text-muted-foreground">{COMMAND_SUMMARIES[command.name] ?? command.description.replace(/ \(TUI:.*\)/, "")}</span>
            </button>) : <p className="px-3 py-3 text-sm text-muted-foreground">No matching commands. Try /help.</p>}
          </div>
        </ComposerPickerSurface>
        <textarea rows={1} autoComplete="off" data-1p-ignore data-lpignore="true" ref={textarea} aria-autocomplete="list" aria-controls={integrations.open ? integrations.textareaProps["aria-controls"] : commandsOpen ? "composer-command-list" : undefined} aria-expanded={commandsOpen || integrations.open} aria-activedescendant={integrations.open ? integrations.textareaProps["aria-activedescendant"] : commandsOpen && commands.length ? `composer-command-${commandIndex}` : undefined} title="Enter to send · Shift+Enter for a new line" aria-label={worker ? `Message ${worker.name}` : "Message 0"} className="col-start-2 row-start-1 block min-h-8 max-h-60 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground" value={workspace.draft} disabled={closed} placeholder={closed ? "This conversation is closed." : worker ? `Message ${worker.name}…` : active ? "Add a message…" : "Ask 0… / for commands"} onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onChange={(event) => { setCaret(event.target.selectionStart); workspace.setDraft(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={(event) => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (integrations.onKeyDown(event)) return; if (commandsOpen) { if (event.key === "Escape") { event.preventDefault(); setCommandsDismissed(true); return; } if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length); return; } if (commands.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); selectCommand(commands[commandIndex]!.name); return; } } if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) onSubmit(); } }} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); setPasteNotice("Files can't be pasted. Use + to add a file path instead."); } else { const text = event.clipboardData.getData("text/plain"); setPasteNotice(text.length + workspace.draft.length > 32000 ? "Message is too long. Shorten it to under 32,000 characters." : ""); } }} />
        <div className="contents"><Button variant="ghost" size="icon-sm" className="col-start-1 row-start-1 self-end" title="Add a file path" aria-label="Add a file path" disabled={closed} onClick={() => setPathOpen((value) => !value)}><Plus className="size-5" /></Button><div className="col-start-3 row-start-1 flex items-center gap-2 self-end">{!worker && <DropdownMenu onOpenChange={setModelsOpen}><DropdownMenu.Trigger aria-label="Choose model" disabled={active || workspace.busy || closed} className="flex max-w-20 sm:max-w-40 items-center gap-1 rounded-full px-2 py-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"><button type="button"><span className="truncate">{snapshot.runtime?.model || "Model"}</span><ChevronDown className="size-3 shrink-0" /></button></DropdownMenu.Trigger><DropdownMenu.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="w-[300px] max-w-[calc(100vw-24px)] max-h-[min(256px,var(--available-height))] rounded-3xl overflow-y-auto overscroll-contain p-2 font-sans"><div className="sticky top-0 z-10 bg-popover pb-2"><Input className="h-8 rounded-xl px-3 text-sm" aria-label="Search models" placeholder="Search models and providers" value={modelFilter} onChange={event => setModelFilter(event.target.value)} onKeyDown={event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }} /></div>
          {modelCatalog.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">Loading models…</div>}
          {modelCatalog.error && <div className="max-w-64 px-3 py-2 text-sm text-muted-foreground">{consoleErrorMessage(modelCatalog.error instanceof Error ? modelCatalog.error.message : "Could not load models")}</div>}
          {modelCatalog.data?.models.filter(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase())).map((model) => <DropdownMenu.Item key={`${model.provider}:${model.id}`} aria-label={`${model.id} ${model.provider}`} title={`${model.id} · ${model.provider}`} icon={<ProviderIcon providerId={model.provider} className="size-4 shrink-0" />} selected={model.id === snapshot.runtime?.model && model.provider === snapshot.runtime?.providerId} className="h-9 gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors duration-100 motion-reduce:transition-none" onClick={() => void workspace.perform(() => configureConsoleSession(snapshot.session.id, { runtime: { providerId: model.provider, model: model.id } }))}><span className="min-w-0 flex-1 truncate text-sm leading-5">{model.id}</span></DropdownMenu.Item>)}
          {modelCatalog.data && modelCatalog.data.models.length > 0 && !modelCatalog.data.models.some(model => `${model.id} ${model.provider}`.toLowerCase().includes(modelFilter.toLowerCase())) && <div className="px-3 py-3 text-sm text-muted-foreground">No models match your search.</div>}
          {modelCatalog.data?.diagnostics.map(item => <div key={item.providerId} className="max-w-72 px-3 py-2 text-xs text-muted-foreground">{consoleErrorMessage(item.message)}</div>)}
          {modelCatalog.data && modelCatalog.data.models.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">Connect a provider to choose a model.</div>}
          <DropdownMenu.Item icon={<Plus className="size-4 shrink-0" />} className="gap-3 rounded-xl px-3 py-2 text-sm" onClick={() => navigate(`/connections?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`)}>Connect a provider</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Wrench className="size-4 shrink-0" />} className="gap-3 rounded-xl px-3 py-2 text-sm" onClick={() => navigate(`/models?session=${snapshot.session.id}&return=${encodeURIComponent(`/console/${snapshot.session.id}`)}`)}>Model settings</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu>}<span hidden={workspace.draft.length < 30000} className={`text-xs ${workspace.draft.length > 32000 ? "text-destructive" : "text-muted-foreground"}`}>{workspace.draft.length.toLocaleString()} / 32,000</span>{active && <Button variant="outline" size="sm" disabled={workspace.busy} onClick={onStop}><Square className="size-3" />Stop</Button>}<Button size="icon-sm" aria-label={workspace.busy ? "Sending message" : "Send message"} aria-busy={workspace.busy} disabled={!canSend} onClick={onSubmit}>{workspace.busy ? <LoadingDots className="scale-75" /> : <ArrowUp className="size-4" />}</Button></div></div>
      </div>
      {workerReadOnly && <p role="status" className="mt-2 text-xs text-muted-foreground">This sub-agent is done. Switch to the main conversation to continue.</p>}
      {pasteNotice && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{pasteNotice}</p>}
    </div>
  </div>;
}
