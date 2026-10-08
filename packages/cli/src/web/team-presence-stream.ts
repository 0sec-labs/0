import type { IncomingMessage, ServerResponse } from "node:http";
import { TeamAuth, TeamAuthError, getSessionId } from "./team-auth.js";
import { CollaborationService, type CollaborationEvent } from "./collaboration.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_CHANGES = 32;

/** Local authenticated push transport. Caller must authorize origin and control token first. */
export function handleTeamPresenceStream(
  req: IncomingMessage, res: ServerResponse, url: URL,
  auth: TeamAuth, collaboration: CollaborationService | undefined,
  options: { keepAliveMs?: number } = {},
): boolean {
  if (url.pathname !== "/api/team/events") return false;
  if (req.method !== "GET") throw new TeamAuthError("Use GET for team events.", 405);
  if (!auth.enabled || !collaboration) throw new TeamAuthError("Team mode is not configured.", 404);
  const sessionId = getSessionId(req);
  const original = auth.resolveSessionId(sessionId);
  if (!sessionId || !original) throw new TeamAuthError("Sign in to this workspace.");
  // Verify the room service belongs to this same authenticated workspace before sending headers.
  const initial = collaboration.overview(sessionId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    "Connection": "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
  });
  res.flushHeaders?.();
  let closed = false;
  let blocked = false;
  let pendingPresence: string | undefined;
  const pendingChanges = new Map<string, { kind: string; id: string }>();
  let allChanged = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = (end: boolean) => {
    if (closed) return;
    closed = true; unsubscribe?.();
    if (timer) clearInterval(timer);
    req.removeListener("aborted", onDisconnect);
    req.socket?.removeListener("close", onDisconnect);
    res.removeListener("close", onDisconnect);
    res.removeListener("error", onDisconnect);
    res.removeListener("drain", onDrain);
    pendingPresence = undefined; pendingChanges.clear();
    if (end && !res.writableEnded && !res.destroyed) res.end();
  };
  const onDisconnect = () => cleanup(false);
  const authorized = (): boolean => {
    const actor = auth.resolveSessionId(sessionId);
    if (!actor || actor.workspaceId !== original.workspaceId || actor.userId !== original.userId) { cleanup(true); return false; }
    return !closed;
  };
  const frame = (event: string, data: unknown): string => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  const write = (body: string): boolean => {
    if (!authorized()) return false;
    if (Buffer.byteLength(body) > MAX_FRAME_BYTES) { cleanup(true); return false; }
    try { blocked = !res.write(body); return !blocked; }
    catch { cleanup(false); return false; }
  };
  const publishPresence = () => {
    if (!authorized()) return;
    let body: string;
    try { body = frame("presence", collaboration.overview(sessionId)); } catch { cleanup(true); return; }
    if (Buffer.byteLength(body) > MAX_FRAME_BYTES) { cleanup(true); return; }
    if (blocked) pendingPresence = body;
    else write(body);
  };
  const publishChanged = (event: Extract<CollaborationEvent, { type: "changed" }>) => {
    if (!authorized()) return;
    if (!blocked) { write(frame("changed", { kind: event.kind, id: event.id })); return; }
    if (allChanged) return;
    pendingChanges.set(event.kind + ":" + event.id, { kind: event.kind, id: event.id });
    if (pendingChanges.size > MAX_PENDING_CHANGES) { pendingChanges.clear(); allChanged = true; }
  };
  const onDrain = () => {
    if (!authorized()) return;
    blocked = false;
    if (pendingPresence) { const body = pendingPresence; pendingPresence = undefined; if (!write(body)) return; }
    if (allChanged) { allChanged = false; write(frame("changed", { all: true })); return; }
    for (const [key, change] of pendingChanges) { pendingChanges.delete(key); if (!write(frame("changed", change))) return; }
  };
  req.on("aborted", onDisconnect);
  req.socket?.on("close", onDisconnect);
  res.on("close", onDisconnect);
  res.on("error", onDisconnect);
  res.on("drain", onDrain);
  unsubscribe = collaboration.subscribe(event => { if (event.type === "presence") publishPresence(); else publishChanged(event); });
  timer = setInterval(publishPresence, Math.max(10, Math.min(10000, options.keepAliveMs ?? 10000)));
  timer.unref?.();
  write(frame("presence", initial));
  return true;
}
