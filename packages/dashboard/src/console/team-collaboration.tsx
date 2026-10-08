import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Hand, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { teamInitials, type TeamClient, type TeamSnapshot } from "@/lib/team-client";

export interface TeamCollaborationProps {
  sessionId: string;
  client: TeamClient;
  draft: string;
  onControlChange?: (canControl: boolean) => void;
  onProposalSubmitted?: (submittedText: string) => void;
}

/** Real authenticated presence only. Lease secrets remain in the client adapter. */
export function TeamCollaboration({ sessionId, client, draft, onControlChange, onProposalSubmitted }: TeamCollaborationProps) {
  const [state, setState] = useState<{ owner: string; client: TeamClient; snapshot: TeamSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = useRef<AbortController | null>(null);
  const draftRef = useRef(draft);
  const typingUntil = useRef(0);
  const onControlRef = useRef(onControlChange);
  onControlRef.current = onControlChange;
  const snapshot = state?.owner === sessionId && state.client === client ? state.snapshot : null;
  const receive = useCallback((next: TeamSnapshot) => {
    if (next.conversationId !== sessionId) throw new Error("Team response belongs to another conversation.");
    setState(previous => previous?.owner === sessionId && previous.client === client && previous.snapshot.revision > next.revision ? previous : { owner: sessionId, client, snapshot: next });
  }, [sessionId, client]);

  useEffect(() => {
    if (draftRef.current !== draft) typingUntil.current = Date.now() + 4000;
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    onControlRef.current?.(snapshot?.canControl ?? false);
  }, [snapshot?.canControl]);
  useEffect(() => {
    const controller = new AbortController(); scope.current = controller;
    setError(null); setBusy(false); typingUntil.current = 0;
    onControlRef.current?.(false);
    let pending = false;
    const heartbeat = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      const viewing = document.visibilityState === "visible";
      try {
        const next = await client.presence(sessionId, { viewing, typing: viewing && Boolean(draftRef.current.trim()) && Date.now() < typingUntil.current }, controller.signal);
        if (!controller.signal.aborted) { receive(next); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Team connection unavailable."); setState(null); onControlRef.current?.(false); }
      } finally { pending = false; }
    };
    void heartbeat();
    const timer = window.setInterval(() => { void heartbeat(); }, 3000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", heartbeat); onControlRef.current?.(false); };
  }, [client, sessionId, receive]);

  const act = async (action: (signal: AbortSignal) => Promise<TeamSnapshot>) => {
    const current = scope.current;
    if (busy || !current || current.signal.aborted) return false;
    setBusy(true); setError(null);
    try {
      const next = await action(current.signal);
      if (current.signal.aborted) return false;
      receive(next); return true;
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Team action could not be completed.");
      return false;
    } finally { if (!current.signal.aborted) setBusy(false); }
  };

  if (!snapshot) return error ? <div role="alert" className="px-4 py-2 text-xs text-destructive">{error}</div> : null;
  const viewing = snapshot.presence.filter(member => member.viewing);
  const typing = viewing.filter(member => member.typing && member.userId !== snapshot.viewer.userId);
  const pending = snapshot.proposals.filter(proposal => proposal.status === "pending" || proposal.status === "dispatching" || proposal.status === "failed");
  const canClaim = !snapshot.controller && snapshot.viewer.role !== "viewer";

  return <section aria-label="Team collaboration" className="space-y-2 px-4 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex -space-x-1.5" aria-label={`${viewing.length} viewing`}>
          {viewing.slice(0, 6).map(member => <span key={member.userId} title={`${member.displayName}${member.typing ? " · typing" : " · viewing"}`} aria-label={`${member.displayName}${member.typing ? " typing" : " viewing"}`} className="relative grid size-7 shrink-0 place-items-center rounded-full border-2 border-background bg-muted text-[10px] font-medium">
            {teamInitials(member.displayName)}
            {member.typing && <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-primary motion-safe:animate-pulse" />}
          </span>)}
          {viewing.length > 6 && <span className="grid size-7 place-items-center rounded-full border-2 border-background bg-muted text-[10px]">+{viewing.length - 6}</span>}
        </div>
        <span className="truncate text-xs text-muted-foreground">{snapshot.controller ? snapshot.canControl ? "You control this chat" : `${snapshot.controller.displayName} controls this chat` : "No controller"}</span>
      </div>
      {snapshot.canControl ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(signal => client.control(sessionId, { action: "release", expectedRevision: snapshot.revision }, signal)); }}>Release control</Button>
        : canClaim ? <Button size="xs" variant="outline" disabled={busy} onClick={() => { void act(signal => client.control(sessionId, { action: "claim", expectedRevision: snapshot.revision }, signal)); }}><Hand aria-hidden="true" />Take control</Button> : null}
    </div>
    {typing.length > 0 && <p role="status" className="text-xs text-muted-foreground">{typing.map(member => member.displayName).join(", ")} {typing.length === 1 ? "is" : "are"} typing…</p>}
    {!snapshot.canControl && snapshot.viewer.role !== "viewer" && <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Suggest a message for the controller.</p><Button size="xs" variant="outline" disabled={busy || !draft.trim() || draft.length > 16000} onClick={() => { const submitted = draft; void act(signal => client.propose(sessionId, { text: submitted.trim() }, signal)).then(sent => { if (sent) onProposalSubmitted?.(submitted); }); }}><Send aria-hidden="true" />Propose message</Button></div>}
    {pending.length > 0 && <details className="rounded-xl border border-border px-3 py-2" open>
      <summary className="cursor-pointer text-xs text-muted-foreground">{pending.length} proposal{pending.length === 1 ? "" : "s"}</summary>
      <div className="mt-2 space-y-3">{pending.map(proposal => <article key={proposal.id} className="space-y-1.5">
        <div className="flex items-center justify-between gap-3"><span className="text-xs font-medium">{proposal.submittedBy.displayName}</span><span className="text-[10px] text-muted-foreground">{proposal.status === "dispatching" ? "Sending…" : proposal.status === "failed" ? "Failed" : "Pending"}</span></div>
        <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-sm">{proposal.text}</p>
        {proposal.error && <p className="text-xs text-destructive">{proposal.error}</p>}
        {snapshot.canControl && proposal.status === "pending" && <div className="flex gap-1"><Button size="xs" variant="secondary" disabled={busy} onClick={() => { void act(signal => client.decide(sessionId, proposal.id, { action: "accept", expectedRevision: snapshot.revision }, signal)); }}><Check aria-hidden="true" />Send</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(signal => client.decide(sessionId, proposal.id, { action: "reject", expectedRevision: snapshot.revision }, signal)); }}><X aria-hidden="true" />Dismiss</Button></div>}
      </article>)}</div>
    </details>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
