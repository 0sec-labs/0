import { openAppSearch } from "@/components/command-palette";
import { BackendConnectionPicker } from "@/components/backend-connection-picker";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { findCommand, SLASH_COMMANDS } from "@0/shared/dist/slash-commands.js";
import type { ConsolePublicExport, DesktopConsoleSession, HarnessSnapshot } from "@0/shared";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared/dist/desktop-console.js";
import { Copy, Download, Menu, MoreHorizontal, PanelRight, Plus, Square, Trash2, Pencil, Eraser, X } from "lucide-react";
import { useBackendApi } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { usePersistentState } from "@/lib/use-persistent-state";
import { ConversationSkeleton } from "@/console/loading-state";
import { consoleErrorMessage, needsProviderSignIn } from "@/console/provider-error";
import { TeamCollaboration } from "@/console/team-collaboration";
import { Conversation } from "@/console/conversation";
import { AgentActivity } from "@/console/agent-activity";
import { ConsoleInspector } from "@/console/inspector";
import { ConsoleSessionRail } from "@/console/session-rail";
import { addFindingToDraft } from "@/console/finding-context";
import type { FindingRecord } from "@/types";
import { useConsoleWorkspace } from "@/console/use-console-workspace";
import type { SettingsResponse } from "@/components/console-control/contracts";

interface FeedbackResult { saved: boolean; path?: string; submitted: boolean; previewId?: string; preview?: { url: string; body: unknown; headers: unknown; warnings: string[] }; error?: string }
type ConfirmAction = { kind: "close" | "clear" | "delete" | "delete-live" | "drain"; id: string; title: string };

export function ConsolePage() {
  const { client, teamClient, archiveConsoleSession, closeConsoleSession, configureConsoleSession, controlConsoleSession, deleteConsoleSession, deleteSavedConsoleSession, exportConsoleSession, resolveConsoleDecision, resumeConsoleSession, stopConsoleWorker, webFetchJson } = useBackendApi();
  const team = useTeamAccess();
  const readOnlyTeam = team.enabled && team.user?.role === "viewer";
  const { sessionId } = useParams<{ sessionId: string }>();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const workerId = search.get("worker");
  const workspace = useConsoleWorkspace(sessionId, workerId);
  const settingsQuery = useQuery({ queryKey: ["console-settings"], queryFn: ({ signal }) => webFetchJson<SettingsResponse>("/api/console/settings", { signal }), refetchInterval: 5000 });
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
  const findingId = search.get("finding");
  const requestedIntent = search.get("intent");
  const controlsQuery = sessionId ? `?session=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(`/console/${sessionId}${workerId ? `?worker=${encodeURIComponent(workerId)}` : ""}`)}` : "?return=/console";
  const active = snapshot && ["working", "waiting"].includes(snapshot.session.status);
  const visibleError = workspace.error && workspace.error !== snapshot?.lastOutcome?.error ? workspace.error : undefined;
  const dialogError = workspace.error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">{workspace.error}</p>;

  useEffect(() => {
    if (!snapshot?.todos?.todos.length || !wide) return;
    const key = snapshot.session.id;
    if (!observedPlans.current.has(key)) {
      observedPlans.current.add(key);
      setInspectOpen(true);
    }
  }, [snapshot?.session.id, snapshot?.todos, wide]);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = settingsQuery.data?.settings.reduceMotion === true ? "true" : "false";
  }, [settingsQuery.data?.settings.reduceMotion]);
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
  const findBlankSession = () => team.enabled ? undefined : workspace.sessions.find((item) => item.id === sessionId && isBlankSession(item)) ?? workspace.sessions.find(isBlankSession);
  const createSession = async () => {
    if (readOnlyTeam) { const available = workspace.sessions.find(item => item.status !== "closed"); if (available) navigate(`/console/${available.id}`); return; }
    if (creatingSession.current) return;
    setRailOpen(false);
    const blank = findBlankSession();
    if (blank) {
      if (blank.id !== sessionId) navigate(`/console/${blank.id}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: !sessionId });
      else if (search.get("new") === "1") navigate(`/console/${blank.id}`, { replace: true });
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-autocomplete="list"]')?.focus());
      return;
    }
    creatingSession.current = true;
    try {
      const created = await workspace.create({ title: "New chat", role: "audit", autonomyMode: DEFAULT_AUTONOMY_MODE });
      if (created) navigate(`/console/${created.id}${search.get("search") === "1" ? "?search=1" : ""}`);
    } finally { creatingSession.current = false; }
  };
  useEffect(() => {
    if (sessionId || findingId || search.get("new") === "1" || !workspace.sessionsLoaded || openingInitialChat.current) return;
    openingInitialChat.current = true;
    const existing = workspace.sessions.find(item => item.id === activeSession && item.status !== "closed");
    if (existing) navigate(`/console/${existing.id}${search.get("search") === "1" ? "?search=1" : ""}`, { replace: true });
    else void createSession();
  }, [sessionId, findingId, search, workspace.sessionsLoaded, activeSession]);
  useEffect(() => {
    if (search.get("search") !== "1" || !sessionId) return;
    openAppSearch("chats");
    const next = new URLSearchParams(search); next.delete("search"); setSearch(next, { replace: true });
  }, [sessionId, search, setSearch]);
  useEffect(() => {
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
    void workspace.create({ findingId, findingIntent }).then((created) => {
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
  const submit = async () => {
    const text = workspace.draft.trim();
    if (!text || workspace.busy) return;
    setNotice("");
    if (text.length > 32000) { setNotice("Message is too long (max 32,000 characters)."); return; }
    const command = findCommand(text);
    if (command.isSlash) {
      if (command.isUnknown) { setNotice(`Unknown command /${command.rawName}. Type /help to see commands.`); return; }
      const destinations: Record<string, string> = { onboard: "/setup", capabilities: "/tools", tools: "/tools", settings: "/settings", keybindings: "/settings", theme: "/settings", connect: "/connections", model: "/models", history: "/runs", findings: "/findings", launcher: "/audits", ops: "/dashboard", hackstore: "/plugins", scope: "/project", doctor: "/doctor", fix: "/fix" };
      const name = command.command!;
      if (workerId && (name === "clear" || name === "exit")) { setNotice(`Switch back to the main conversation to use /${name}.`); return; }
      if (name === "help") { setHelpOpen(true); workspace.setDraft(""); return; }
      if (name === "new-chat") { void createSession(); return; }
      if (name === "sessions") { setRailOpen(true); workspace.setDraft(""); return; }
      if (name === "status" || name === "usage") { setInspectOpen(true); workspace.setDraft(""); return; }
      if (name === "chat") { navigate(sessionId ? `/console/${sessionId}` : "/console"); workspace.setDraft(""); return; }
      if (name === "back") { workspace.setDraft(""); navigate(-1); return; }
      if (name === "copy") { if (sessionId) { await openExport(sessionId, false, true, workerId ?? undefined); workspace.setDraft(""); } return; }
      if (name === "clear" || name === "exit") { if (sessionId) setConfirm({ kind: name === "clear" ? "clear" : "close", id: sessionId, title: snapshot?.title ?? "this conversation" }); return; }
      if (name === "model" && command.args && sessionId) { const result = await workspace.perform(() => configureConsoleSession(sessionId, { runtime: { model: command.args } })); if (result) workspace.setDraft(""); return; }
      if (name === "theme" && command.args) {
        const result = await workspace.perform(async () => {
          const changed = await webFetchJson<SettingsResponse>("/api/console/settings", { method: "PATCH", body: JSON.stringify({ key: "theme", value: command.args, scope: "global" }) });
          if (changed.persisted === false) throw new Error("Couldn't save the theme.");
          await settingsQuery.refetch();
          return changed;
        });
        if (result) { workspace.setDraft(""); setNotice(`Theme set to ${command.args}.`); }
        return;
      }
      if (name === "feedback") {
        if (command.args === "cancel") { const result = await workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "cancel" }) })); if (result) { setFeedback(null); workspace.setDraft(""); setNotice("Feedback cancelled."); } return; }
        if (command.args === "send") { if (!feedback?.previewId) setNotice("Use /feedback submit <message> first."); else setNotice("Review your feedback in the dialog, then send it."); return; }
        const submitFeedback = command.args.startsWith("submit ");
        const message = submitFeedback ? command.args.slice(7).trim() : command.args;
        if (!message) { setNotice("Use /feedback <message> to save it, or /feedback submit <message> to send it."); return; }
        const result = await workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ message, submit: submitFeedback }) }));
        if (result) { workspace.setDraft(""); if (result.previewId) setFeedback(result); else setNotice(result.error ?? `Feedback saved${result.path ? ` to ${result.path}` : ""}. Nothing was sent.`); }
        return;
      }
      if (name === "explain") {
        if (!sessionId || active) { setNotice("Wait until 0 finishes, then try again."); return; }
        if (!command.args && !snapshot?.messages.length) { setNotice("Nothing to explain yet. Use /explain <topic>."); return; }
        const topic = command.args ? `Explain "${command.args}"` : "Explain your previous result";
        await workspace.send({ text: `${topic} like I am five years old. Use 3–5 very short sentences, mostly under 12 words each. Use familiar everyday words and one simple comparison. No jargon, acronyms, code, headings, or baby talk. Say what happened, why it matters, and one thing to do next. Keep the facts accurate and say plainly what is not yet confirmed. Explain only; do not run new tests or tools.`, mode: "send", ...(workerId ? { workerId } : {}) });
        return;
      }
      if (destinations[name]) {
        let extra = name === "theme" ? "&tab=appearance" : name === "keybindings" ? "&tab=keybindings" : "";
        if (name === "fix" && command.args) {
          if (command.args === "cancel") extra = "&intent=cancel";
          else if (command.args.startsWith("publish ")) extra = `&finding=${encodeURIComponent(command.args.slice(8).trim())}&intent=publish`;
          else extra = `&finding=${encodeURIComponent(command.args)}`;
        }
        workspace.setDraft("");
        navigate(`${destinations[name]}${controlsQuery}${extra}`);
        return;
      }
      setNotice(`/${name} isn't available here.`);
      return;
    }
    if (!sessionId || (workerId && !worker)) { setNotice("Pick a conversation first."); return; }
    await workspace.send({ text, mode: workerId ? "send" : active ? mode : "send", ...(workerId ? { workerId } : {}) });
  };
  const onAddFinding = (finding: FindingRecord) => {
    workspace.setRootDraft(addFindingToDraft(workspace.rootDraft, finding));
    setRailOpen(false);
    if (snapshot) navigate(`/console/${snapshot.session.id}`);
    setNotice("Finding added to your draft. Review it, then send.");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".console-composer textarea")?.focus());
  };
  const rail = <ConsoleSessionRail workspace={workspace} selectedId={sessionId} onCreate={() => { setRailOpen(false); void createSession(); }} onRename={(session) => { setRename(session); setRenameValue(session.title || session.target); }} onArchiveLive={(session) => { void workspace.perform(() => archiveConsoleSession(session.id), session.id).then(result => { if (result && sessionId === session.id) { setActiveSession(null); navigate("/console", { replace: true }); } }); }} onArchive={(saved, archived) => { void workspace.perform(() => archiveConsoleSession(saved.id, true, archived), saved.id); }} onResume={(saved) => { if (readOnlyTeam) { navigate(`/console/saved/${saved.id}`); return; } void workspace.perform(() => resumeConsoleSession(saved.id, {}), saved.id).then(created => { if (created) { setRailOpen(false); navigate(`/console/${created.id}`); } }); }} onDelete={(saved) => setConfirm({ kind: "delete", id: saved.id, title: saved.summary || saved.target || "this conversation" })} onExport={(id, saved) => void openExport(id, saved)} onSelect={() => setRailOpen(false)} onDeleteLive={(session) => setConfirm({kind: "delete-live", id: session.id, title: session.title || session.target || "this conversation"})} />;
  const inspector = snapshot && <ConsoleInspector onAddFinding={onAddFinding} snapshot={snapshot} busy={workspace.busy} stagePrompt={(text) => { workspace.setRootDraft(text); navigate(`/console/${snapshot.session.id}`); setNotice("Added a draft message. Review it, then send."); }} onScope={() => navigate(`/project${controlsQuery}`)} onDrain={() => setConfirm({ kind: "drain", id: snapshot.session.id, title: snapshot.title })} onHarness={(providerId, event) => {
    const generationId = snapshot.harness?.generationId;
    if (!generationId) { setNotice("Tools aren't ready yet."); return; }
    void workspace.perform(() => webFetchJson<{ snapshot: HarnessSnapshot; requestedPrompt?: string }>(`/api/console/sessions/${encodeURIComponent(snapshot.session.id)}/harness`, { method: "POST", body: JSON.stringify({ generationId, providerId, event }) })).then((result) => {
      if (result?.requestedPrompt) { workspace.setRootDraft(result.requestedPrompt); navigate(`/console/${snapshot.session.id}`); setNotice("Added a draft message. Review it, then send."); }
    });
  }} />;

  return <>
    <div data-reduced-motion={settingsQuery.data?.settings.reduceMotion === true ? "true" : undefined} className="console-frame flex min-w-0 overflow-hidden bg-background">
      <aside ref={sessionRailElement} className="hidden w-64 shrink-0  lg:block">{rail}</aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2  px-3 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="Open conversations" className="lg:hidden" onClick={() => setRailOpen(true)}><Menu className="size-4" /></Button><div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold">{snapshot?.title || "Chat"}</h1>{snapshot && team.enabled && client.backendId === "local" && <TeamCollaboration sessionId={snapshot.session.id} client={teamClient} draft={workspace.draft} />}</div></div>
          <div className="flex items-center gap-1">{!snapshot && <BackendConnectionPicker />}{snapshot && <AgentActivity sendBehavior={mode} onSendBehaviorChange={setMode} snapshot={snapshot} workerId={workerId} active={["working", "waiting"].includes(snapshot.session.status)} onSelect={(id) => { const next = new URLSearchParams(search); if (id) next.set("worker", id); else next.delete("worker"); setSearch(next); }} />}<Button size="icon-sm" variant="ghost" className="lg:hidden" aria-label="New chat" onClick={() => void createSession()}><Plus className="size-4" /></Button>{snapshot && <><DropdownMenu><DropdownMenu.Trigger aria-label="Chat actions" className="flex size-8 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><button type="button"><MoreHorizontal className="size-4" /></button></DropdownMenu.Trigger><DropdownMenu.Content align="end">
<DropdownMenu.Item icon={<Pencil className="size-4" />} onClick={() => { setRename(snapshot.session); setRenameValue(snapshot.title); }}>Rename</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Copy className="size-4" />} onClick={() => void openExport(snapshot.session.id, false, true, workerId ?? undefined)}>Copy chat</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Download className="size-4" />} onClick={() => void openExport(snapshot.session.id, false, false, workerId ?? undefined)}>Export</DropdownMenu.Item>
<DropdownMenu.Item disabled={!canExport} icon={<Eraser className="size-4" />} onClick={() => setConfirm({ kind: "clear", id: snapshot.session.id, title: snapshot.title })}>Clear chat</DropdownMenu.Item>
<DropdownMenu.Item icon={<X className="size-4" />} onClick={() => setConfirm({ kind: "close", id: snapshot.session.id, title: snapshot.title })}>Close chat</DropdownMenu.Item>
<DropdownMenu.Item variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm({ kind: "delete-live", id: snapshot.session.id, title: snapshot.title })}>Delete chat</DropdownMenu.Item>
</DropdownMenu.Content></DropdownMenu><Button size="icon-sm" variant={inspectOpen ? "secondary" : "ghost"} aria-label="Details" onClick={() => setInspectOpen((value) => !value)}><PanelRight className="size-4" /></Button></>}</div>
        </header>
        {(visibleError || notice) && <div role={visibleError ? "alert" : "status"} className={`flex shrink-0 items-start justify-between gap-3  px-4 py-3 text-xs leading-5 ${visibleError ? "bg-destructive/5 text-destructive" : "bg-muted/30 text-muted-foreground"}`}><div className="whitespace-pre-wrap break-words">{visibleError ? consoleErrorMessage(visibleError) : notice}</div>{visibleError && needsProviderSignIn(visibleError) && <Button asChild size="sm"><Link to={`/connections${controlsQuery}`}>Manage connection</Link></Button>}<Button size="sm" variant="ghost" onClick={() => { workspace.dismissError(); if (workspace.error) workspace.refresh(); setNotice(""); }}>Dismiss</Button></div>}
        {snapshot?.focusedFinding && <details className="shrink-0  bg-muted/10 px-4 py-3 text-xs" open={search.get("intent") === "impact"}><summary className="cursor-pointer font-medium">{snapshot.focusedFinding.title} · {snapshot.focusedFinding.severity}</summary><div className="max-h-64 space-y-3 overflow-auto pt-3"><p className="whitespace-pre-wrap">{snapshot.focusedFinding.description}</p><div><div className="font-medium">Impact</div>{snapshot.focusedFinding.impactAssessment ? <pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(snapshot.focusedFinding.impactAssessment, null, 2)}</pre> : <p className="mt-1 text-muted-foreground">Not assessed yet.</p>}</div><Button size="sm" variant="outline" asChild><Link to={`/fix${controlsQuery}&finding=${encodeURIComponent(snapshot.focusedFinding.id)}`}>Prepare a fix</Link></Button></div></details>}
        {workspace.loading || (!sessionId && !workspace.error && !readOnlyTeam) ? <ConversationSkeleton /> : snapshot ? workerId && !worker ? <div className="grid flex-1 place-items-center p-8 text-center"><div><h2 className="text-base font-medium">This sub-agent has ended</h2><Button className="mt-4" variant="outline" onClick={() => navigate(`/console/${snapshot.session.id}`)}>Back</Button></div></div> : <Conversation sendBehavior={mode} workspace={workspace} worker={worker} onSubmit={() => void submit()} onStop={() => void workspace.perform(() => worker ? stopConsoleWorker(snapshot.session.id, worker.id) : controlConsoleSession(snapshot.session.id, "cancel"))} onResolve={(id, response) => void workspace.perform(() => resolveConsoleDecision(snapshot.session.id, id, response))} resumeCap={() => setCapOpen(true)} /> : <div className="console-enter grid flex-1 place-items-center overflow-auto p-6"><div className="max-w-xl text-center"><BrandMark className="mx-auto mb-6" /><h1 className="font-heading text-2xl font-medium">Hi! What do you want me to do?</h1>{sessionId && <p role="alert" className="mt-3 text-sm text-destructive">Couldn't load this conversation. Your draft is saved.</p>}<div className="mt-6 flex justify-center gap-3"><KumoButton variant="primary" size="base" className="text-sm" disabled={workspace.busy || readOnlyTeam} onClick={() => void createSession()}><Plus className="size-4" />New chat</KumoButton><Button variant="ghost" onClick={() => setRailOpen(true)}>History</Button></div></div></div>}
      </section>
      {wide && snapshot && <aside className="console-details-panel shrink-0 overflow-hidden" data-open={inspectOpen} aria-hidden={!inspectOpen} inert={!inspectOpen}><div className="h-full w-80 overflow-y-auto">{inspector}</div></aside>}
    </div>
    <Sheet open={railOpen} onOpenChange={setRailOpen}><SheetContent side="left" className="flex w-80 flex-col p-0"><SheetHeader className=" px-4 py-4 pr-12"><SheetTitle>Chats</SheetTitle><SheetDescription className="sr-only">Current and past chats</SheetDescription></SheetHeader><div className="min-h-0 flex-1">{rail}</div></SheetContent></Sheet>
    <Sheet open={inspectOpen && !wide && Boolean(snapshot)} onOpenChange={setInspectOpen}><SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-md"><SheetHeader className=" px-4 py-4 pr-12"><SheetTitle>Details</SheetTitle><SheetDescription className="sr-only">Workspace, model, usage and plan</SheetDescription></SheetHeader>{inspector}</SheetContent></Sheet>

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
                if (sessionId === action.id) { setActiveSession(null); navigate("/console", { replace: true }); }
              }
            });
          }}>{confirm?.kind === "delete-live" || confirm?.kind === "delete" ? "Delete" : confirm?.kind === "clear" ? "Clear" : confirm?.kind === "drain" ? "Stop" : "Close"}</Button>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(exported)} onOpenChange={(open) => { if (!open) setExported(null); }}><DialogContent className="max-h-[90dvh] sm:max-w-3xl"><DialogHeader><DialogTitle>{exportKind === "worker" ? "Export sub-agent conversation" : "Export chat"}</DialogTitle><DialogDescription>May contain sensitive data. Check before sharing.</DialogDescription>{dialogError}</DialogHeader><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { if (!exported) return; void navigator.clipboard.writeText(exported.text).then(() => setCopyStatus("Copied"), () => setCopyStatus("Couldn't copy. Select the text below or download it.")); }}><Copy className="size-3" />Copy</Button><Button variant="outline" size="sm" onClick={() => download("json")}><Download className="size-3" />JSON</Button><Button variant="outline" size="sm" onClick={() => download("txt")}><Download className="size-3" />Text</Button></div>{copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p>}<textarea className="h-[45dvh] w-full resize-none rounded-lg border border-border bg-muted/20 p-3 font-mono text-xs leading-5" readOnly value={exported?.text ?? ""} aria-label="Chat text" /></DialogContent></Dialog>
    <Dialog open={capOpen} onOpenChange={setCapOpen}><DialogContent><DialogHeader><DialogTitle>Keep going</DialogTitle><DialogDescription>0 hit its output limit. Tell it what's left to do.</DialogDescription>{dialogError}</DialogHeader><textarea className="min-h-28 rounded-lg border border-border bg-background p-3 text-sm" value={continuation} onChange={(event) => setContinuation(event.target.value)} aria-label="What's left to do" /><Button disabled={workspace.busy || !continuation.trim() || Boolean(active)} onClick={() => { if (!sessionId) return; void workspace.perform(() => webFetchJson<{ session: DesktopConsoleSession }>(`/api/console/sessions/${encodeURIComponent(sessionId)}/continue`, { method: "POST", body: JSON.stringify({ text: continuation.trim() }) })).then((result) => { if (result) setCapOpen(false); }); }}>Continue</Button></DialogContent></Dialog>
    <Dialog open={Boolean(feedback?.previewId)} onOpenChange={(open) => { if (!open) { void workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "cancel" }) })); setFeedback(null); } }}><DialogContent className="max-h-[90dvh] overflow-auto"><DialogHeader><DialogTitle>Send feedback?</DialogTitle><DialogDescription>Nothing has been sent yet. This is exactly what will be sent.</DialogDescription>{dialogError}</DialogHeader><pre className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(feedback?.preview, null, 2)}</pre><Button disabled={workspace.busy} onClick={() => { if (!feedback?.previewId) return; void workspace.perform(() => webFetchJson<FeedbackResult>("/api/console/feedback", { method: "POST", body: JSON.stringify({ action: "send", previewId: feedback.previewId }) })).then((result) => { if (result) { setFeedback(null); setNotice(result.error ?? (result.submitted ? "Feedback sent. Thank you!" : "Feedback wasn't sent.")); } }); }}>Send feedback</Button></DialogContent></Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Commands</DialogTitle><DialogDescription>Type / in the message box to use these.</DialogDescription>{dialogError}</DialogHeader><div className="space-y-2">{SLASH_COMMANDS.map((command) => <button key={command.name} className="block w-full rounded-lg border border-border p-3 text-left hover:bg-muted/30" onClick={() => { workspace.setDraft(`/${command.name}${command.name === "feedback" || command.name === "explain" ? " " : ""}`); setHelpOpen(false); }}><div className="font-mono text-xs">/{command.name}</div><div className="mt-1 text-xs leading-5 text-muted-foreground">{command.description}</div></button>)}</div></DialogContent></Dialog>
  </>;
}
