import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { DesktopConsoleSession } from "@0/shared";
import { useBackendApi } from "@/api";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useConsoleWorkspace } from "@/console/use-console-workspace";
import { Conversation, Composer } from "@/console/conversation";
import { AgentsPanel } from "@/console/agents-panel";
import { ActivityIndicator } from "@/console/loading-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type EditorSession = { id: string; savedId?: string };
export type EditorResource = { kind: "workflow" | "skill"; id: string; name: string };

/** Shared chat editor: real console tools, drafts, approvals, and durable history. */
export function EditorChat({ resource, readOnly, onResourceChange, initialPrompt }: { resource: EditorResource; readOnly: boolean; onResourceChange?: (id: string) => void; initialPrompt?: string }) {
  const api = useBackendApi();
  const key = `${resource.kind}:${resource.id}`;
  const [legacySessionId] = usePersistentState<string | null>(`${resource.kind}-editor:${resource.id}`, null);
  const [sessions, setSessions] = usePersistentState<Record<string, EditorSession | null>>("0-editor-chat-sessions", {});
  const storedSession = Object.hasOwn(sessions, key) ? sessions[key] : legacySessionId ? { id: legacySessionId } : null;
  const sessionId = storedSession?.id;
  const durableId = storedSession?.savedId ?? sessionId;
  const setSession = (session: DesktopConsoleSession | null) => setSessions(previous => {
    const next = session ? { id: session.id, ...(session.savedId ? { savedId: session.savedId } : {}) } : null;
    if (Object.hasOwn(previous, key) && previous[key]?.id === next?.id && previous[key]?.savedId === next?.savedId) return previous;
    return { ...previous, [key]: next };
  });
  const request = useRef<Promise<DesktopConsoleSession> | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const recovering = useRef(new Set<string>());
  const [resuming, setResuming] = useState(false);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const workspace = useConsoleWorkspace(sessionId ?? undefined, workerId);
  useEffect(() => {
    if (sessionId || readOnly) return;
    let mounted = true;
    request.current ??= api.createConsoleSession({ title: `Edit ${resource.name}`, ...(resource.kind === "workflow" ? { workflowId: resource.id } : { skillId: resource.id }) });
    request.current.then(session => { if (mounted) { setSession(session); setError(""); } }).catch(cause => { if (mounted) setError(cause instanceof Error ? cause.message : "Could not open editor chat."); });
    return () => { mounted = false; };
  }, [sessionId, readOnly, resource.id, attempt]);
  const liveSession = sessionId ? workspace.sessions.find(session => session.status !== "closed" && (session.id === sessionId || session.savedId === durableId)) : undefined;
  useEffect(() => {
    if (liveSession && liveSession.id !== sessionId) {
      if (sessionId) workspace.remapDrafts(sessionId, liveSession.id);
      setSession(liveSession);
    }
  }, [liveSession?.id, sessionId]);
  const resumableId = sessionId && durableId && !readOnly && workspace.sessionsLoaded && workspace.savedLoaded && !liveSession && workspace.saved.some(session => session.id === durableId) ? durableId : null;
  useEffect(() => {
    if (!resumableId || recovering.current.has(resumableId)) return;
    recovering.current.add(resumableId);
    setResuming(true);
    api.resumeConsoleSession(resumableId, {}).then(session => {
      workspace.remapDrafts(sessionId ?? resumableId, session.id);
      setSession(session);
      setError("");
    }).catch(cause => setError(cause instanceof Error ? cause.message : "Could not resume editor chat.")).finally(() => setResuming(false));
  }, [resumableId]);
  const snapshot = workspace.snapshot;
  const seeded = useRef(false);
  useEffect(() => {
    if (!snapshot || !initialPrompt || seeded.current) return;
    seeded.current = true;
    if (!snapshot.messages.length && !workspace.rootDraft.trim()) workspace.setRootDraft(initialPrompt);
  }, [snapshot?.session.id, initialPrompt]);
  const boundId = resource.kind === "workflow" ? snapshot?.session.workflowId : snapshot?.session.skillId;
  useEffect(() => {
    if (!snapshot || !boundId) return;
    if (resource.kind === "skill" && boundId !== resource.id && onResourceChange) {
      setSessions(previous => ({ ...previous, [`skill:${boundId}`]: { id: snapshot.session.id, savedId: snapshot.session.savedId } }));
      onResourceChange(boundId);
    } else if (boundId === resource.id) setSession(snapshot.session);
  }, [boundId, snapshot?.session.id, snapshot?.session.savedId, resource.id]);
  const active = snapshot && ["working", "waiting"].includes(snapshot.session.status);
  const send = (worker = false) => {
    if (!snapshot || readOnly || boundId !== resource.id) return;
    const text = (worker ? workspace.draft : workspace.rootDraft).trim();
    const attachments = worker ? workspace.attachments : workspace.rootAttachments;
    if (!text && !attachments.length) return;
    void workspace.send({ text, attachments: attachments.map(({ kind, value, name }) => ({ kind, value, name })), mode: active && !worker ? "steer" : "send", ...(worker && workerId ? { workerId } : {}) });
  };
  const stop = () => { if (sessionId) void workspace.perform(() => api.controlConsoleSession(sessionId, "cancel")); };
  if (readOnly) return <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">You can view this item. Editing requires workspace access.</div>;
  const contextMismatch = Boolean(snapshot && boundId !== resource.id);
  return <div className="flex h-full min-h-0 flex-col" aria-label={`Edit ${resource.kind} in chat`}>
    {!resuming && (error || workspace.error || contextMismatch) && <div role="alert" className="space-y-2 p-4 text-xs text-destructive"><p>{error || workspace.error || "Reconnect this chat to edit the current item."}</p><Button size="sm" variant="ghost" onClick={() => { request.current = null; setSession(null); setError(""); workspace.dismissError(); setAttempt(value => value + 1); }}>Reconnect chat</Button></div>}
    {resuming ? <div className="grid flex-1 place-items-center"><ActivityIndicator label="Resuming editor…" /></div> : !snapshot || contextMismatch ? !error && !workspace.error && !contextMismatch && <div className="grid flex-1 place-items-center"><ActivityIndicator label="Opening editor…" /></div> : <Conversation workspace={workspace} worker={undefined} sendBehavior="steer" emptyState={<div className="max-w-xs space-y-3 text-center"><MessageSquare className="mx-auto size-6 text-muted-foreground" /><h2 className="text-lg font-medium tracking-tight">What would you like to change?</h2><p className="text-sm leading-6 text-muted-foreground">Describe a change. See it take shape beside this chat.</p></div>} composerPlaceholder="Ask for a change…" onSubmitRoot={() => send()} onSubmit={() => send()} onStopRoot={stop} onStop={stop} onResolve={(id, response) => void workspace.perform(() => api.resolveConsoleDecision(snapshot.session.id, id, response))} resumeCap={() => void workspace.send({ text: "Continue the edit from where you stopped.", mode: "send" })} onSelectWorker={id => { setWorkerId(id); setAgentsOpen(true); }} agentsOpen={agentsOpen} onCloseAgents={() => setAgentsOpen(false)} />}
    {snapshot && <Dialog open={agentsOpen} onOpenChange={setAgentsOpen}><DialogContent className="flex h-[80dvh] flex-col gap-0 overflow-hidden p-0"><DialogTitle className="sr-only">Agent activity</DialogTitle><AgentsPanel embedded snapshot={snapshot} selectedWorkerId={workerId} onSelect={setWorkerId}>{snapshot.workers.find(worker => worker.id === workerId) && <Composer canWrite={!readOnly} workspace={workspace} snapshot={snapshot} worker={snapshot.workers.find(worker => worker.id === workerId)} sendBehavior="steer" onSubmit={() => send(true)} onStop={() => { if (workerId) void workspace.perform(() => api.stopConsoleWorker(snapshot.session.id, workerId)); }} />}</AgentsPanel></DialogContent></Dialog>}
  </div>;
}
