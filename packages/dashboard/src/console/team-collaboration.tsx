import { useEffect, useRef, useState } from "react";
import { teamInitials, type TeamClient, type TeamPresence, type TeamRoomKind } from "@/lib/team-client";
import { useTeamOverview } from "./team-overview";

export function TeamPresenceAvatars({ presence, compact = false }: { presence: TeamPresence[]; compact?: boolean }) {
  const members = presence.filter(member => member.viewing);
  if (!members.length) return null;
  return <div className="flex shrink-0 -space-x-1.5" aria-label={`${members.length} viewing`}>
    {members.slice(0, compact ? 3 : 6).map(member => <span key={member.userId} title={`${member.displayName} · ${member.typing ? "typing" : "viewing"}`} aria-label={`${member.displayName} ${member.typing ? "typing" : "viewing"}`} className={`relative grid shrink-0 place-items-center rounded-full border-2 border-background bg-muted font-medium ${compact ? "size-6 text-[9px]" : "size-7 text-[10px]"}`}>
      {teamInitials(member.displayName)}
      {member.typing && <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-primary motion-safe:animate-pulse" />}
    </span>)}
    {members.length > (compact ? 3 : 6) && <span className="grid size-6 place-items-center rounded-full border-2 border-background bg-muted text-[9px]">+{members.length - (compact ? 3 : 6)}</span>}
  </div>;
}
export interface TeamCollaborationProps {
  sessionId?: string;
  room?: { kind: TeamRoomKind; id: string };
  client: TeamClient;
  draft?: string;
  onWriteAccessChange?: (canWrite: boolean) => void;
}
/** Independent collaboration: presence never reserves or controls another member's chat. */
export function TeamCollaboration({ sessionId, room, client, draft = "", onWriteAccessChange }: TeamCollaborationProps) {
  const kind = room?.kind ?? "conversation";
  const id = room?.id ?? sessionId ?? "";
  const owner = `${client.backendId}:${kind}:${id}`;
  const [state, setState] = useState<{ owner: string; presence: TeamPresence[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const typingUntil = useRef(0);
  const onWriteRef = useRef(onWriteAccessChange);
  const heartbeatRef = useRef<() => void>(() => {});
  const overview = useTeamOverview(client, { enabled: Boolean(id) });
  onWriteRef.current = onWriteAccessChange;
  useEffect(() => {
    if (draftRef.current === draft) return;
    typingUntil.current = Date.now() + 4000; draftRef.current = draft;
    const timer = window.setTimeout(() => heartbeatRef.current(), 200);
    const stopped = window.setTimeout(() => heartbeatRef.current(), 4200);
    return () => { window.clearTimeout(timer); window.clearTimeout(stopped); };
  }, [draft]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setError(null); typingUntil.current = 0; onWriteRef.current?.(false);
    let pending = false;
    let queued = false;
    const heartbeat = async () => {
      if (controller.signal.aborted) return;
      if (pending) { queued = true; return; }
      pending = true;
      const viewing = document.visibilityState === "visible";
      const input = { viewing, typing: viewing && Boolean(draftRef.current.trim()) && Date.now() < typingUntil.current };
      try {
        if (kind === "conversation") {
          const next = await client.presence(id, input, controller.signal);
          if (!controller.signal.aborted) { setState({ owner, presence: next.presence }); onWriteRef.current?.(next.canWrite); setError(null); }
        } else {
          const next = await client.roomPresence(kind, id, input, controller.signal);
          if (!controller.signal.aborted) { setState({ owner, presence: next.rooms.find(item => item.kind === kind && item.id === id)?.presence ?? [] }); onWriteRef.current?.(next.viewer.role !== "viewer"); setError(null); }
        }
      } catch (cause) {
        if (!controller.signal.aborted) { setError("Live presence is reconnecting…"); setState(null); onWriteRef.current?.(false); }
      } finally { pending = false; if (queued && !controller.signal.aborted) { queued = false; void heartbeat(); } }
    };
    heartbeatRef.current = () => { void heartbeat(); };
    void heartbeat();
    const timer = window.setInterval(() => { void heartbeat(); }, 10000);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      controller.abort(); heartbeatRef.current = () => {}; window.clearInterval(timer); document.removeEventListener("visibilitychange", heartbeat);
      onWriteRef.current?.(false);
      // A separate authenticated request leaves this tab's room; other tabs remain present.
      void client.leavePresence(kind, id).catch(() => { /* Expiry remains the fallback when leaving cannot reach the server. */ });
    };
  }, [client, kind, id, owner]);
  const presence = overview.isError ? [] : overview.data ? overview.data.rooms.find(item => item.kind === kind && item.id === id)?.presence ?? [] : state?.owner === owner ? state.presence : [];
  return error ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">{error}</p> : presence.some(member => member.viewing) ? <section aria-label="Team presence" className="flex items-center gap-2 px-4 py-2"><TeamPresenceAvatars presence={presence} /></section> : null;
}
