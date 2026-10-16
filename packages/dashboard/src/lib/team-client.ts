/** Authenticated team presence; identity and write access come from the server. */
export type TeamRoomKind = "conversation" | "report" | "workflow";
export interface TeamViewer { userId: string; displayName: string; role: "owner" | "editor" | "viewer" }
export interface TeamPresence { userId: string; displayName: string; viewing: boolean; typing: boolean; updatedAt: number }
export interface TeamSnapshot {
  conversationId: string; workspaceId: string; viewer: TeamViewer; canWrite: boolean; revision: number;
  members: Array<TeamViewer & { joinedAt: number }>; presence: TeamPresence[];
}
export interface TeamWorkspacePresence {
  workspaceId: string; viewer: TeamViewer;
  rooms: Array<{ kind: TeamRoomKind; id: string; presence: TeamPresence[] }>;
}
export type TeamChange = { kind: TeamRoomKind; id: string } | { all: true };
export type TeamStreamEvent = { type: "presence"; overview: TeamWorkspacePresence } | { type: "changed"; change: TeamChange };
export interface TeamClient {
  readonly backendId: string;
  readonly clientId: string;
  snapshot(id: string, signal?: AbortSignal): Promise<TeamSnapshot>;
  presence(id: string, input: { typing: boolean; viewing: boolean }, signal?: AbortSignal): Promise<TeamSnapshot>;
  overview(signal?: AbortSignal): Promise<TeamWorkspacePresence>;
  roomPresence(kind: TeamRoomKind, id: string, input: { typing: boolean; viewing: boolean }, signal?: AbortSignal): Promise<TeamWorkspacePresence>;
  leavePresence(kind: TeamRoomKind, id: string): Promise<void>;
  subscribeOverview(onOverview: (overview: TeamWorkspacePresence) => void, options: { signal: AbortSignal; onError?: (error: Error) => void; onConnectionChange?: (connected: boolean) => void; onChanged?: (change: TeamChange) => void }): Promise<void>;
}

const MAX_EVENT_BYTES = 1024 * 1024;
function validOverview(value: unknown): value is TeamWorkspacePresence {
  if (!value || typeof value !== "object") return false;
  const row = value as TeamWorkspacePresence;
  if (typeof row.workspaceId !== "string" || !row.workspaceId || !row.viewer || typeof row.viewer.userId !== "string" || typeof row.viewer.displayName !== "string" || !["owner", "editor", "viewer"].includes(row.viewer.role) || !Array.isArray(row.rooms) || row.rooms.length > 1000) return false;
  return row.rooms.every(room => room && ["conversation", "report", "workflow"].includes(room.kind) && typeof room.id === "string" && Boolean(room.id) && Array.isArray(room.presence) && room.presence.length <= 500 && room.presence.every(member => member && typeof member.userId === "string" && typeof member.displayName === "string" && typeof member.viewing === "boolean" && typeof member.typing === "boolean" && Number.isFinite(member.updatedAt)));
}
/** Incremental SSE framing; malformed JSON events are ignored, oversized events fail. */
export class TeamPresenceEventParser {
  #buffer = "";
  push(text: string): TeamStreamEvent[] {
    this.#buffer += text;
    const output: TeamStreamEvent[] = [];
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/.exec(this.#buffer))) {
      const frame = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
      if (new TextEncoder().encode(frame).byteLength > MAX_EVENT_BYTES) throw new Error("Team presence event exceeds 1 MiB.");
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r\n|\r|\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!["message", "presence", "changed"].includes(event) || !data.length) continue;
      try {
        const value: unknown = JSON.parse(data.join("\n"));
        if (event === "changed" && value && typeof value === "object") {
          const change = value as Record<string, unknown>;
          if (change.all === true) output.push({ type: "changed", change: { all: true } });
          else if (["conversation", "report", "workflow"].includes(String(change.kind)) && typeof change.id === "string" && change.id) output.push({ type: "changed", change: { kind: change.kind as TeamRoomKind, id: change.id } });
        } else if (validOverview(value)) output.push({ type: "presence", overview: value });
      } catch { /* Malformed frames cannot break the live feed. */ }
    }
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_EVENT_BYTES) throw new Error("Team presence event exceeds 1 MiB.");
    return output;
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
/** Transport stays bound to the owning backend and its authenticated session. */
export function createTeamClient(backendId: string, transport: (path: string, init?: RequestInit) => Promise<Response>): TeamClient {
  // getRandomValues also works on an HTTP development origin where randomUUID is absent.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  const clientId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const route = (id: string) => `/api/team/conversations/${encodeURIComponent(id)}`;
  async function request<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await transport(path, { method: input === undefined ? "GET" : "POST", ...(input === undefined ? {} : { body: JSON.stringify(input) }), headers: { "Content-Type": "application/json" }, signal });
    signal?.throwIfAborted();
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Team request failed (${response.status}).`);
    }
    if (!response.headers.get("Content-Type")?.includes("json")) throw new Error("Team backend returned a non-JSON response.");
    return await response.json() as T;
  }
  const snapshot = async (id: string, signal?: AbortSignal) => {
    const next = await request<TeamSnapshot>(route(id), undefined, signal);
    if (next.conversationId !== id) throw new Error("Team response belongs to another conversation.");
    return next;
  };
  const overview = (signal?: AbortSignal) => request<TeamWorkspacePresence>("/api/team/presence", undefined, signal);
  return { backendId, clientId, snapshot, overview,
    async subscribeOverview(onOverview, { signal, onError, onConnectionChange, onChanged }) {
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          // Reconcile changes missed while disconnected before attaching the live feed.
          const initial = await overview(signal);
          signal.throwIfAborted();
          if (validOverview(initial)) onOverview(initial);
          if (signal.aborted) return;
          onChanged?.({ all: true });
          signal.throwIfAborted();
          const response = await transport("/api/team/events", { signal, headers: { Accept: "text/event-stream" } });
          signal.throwIfAborted();
          if (!response.ok || !response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) throw new Error(`Team live updates unavailable (${response.status}).`);
          onConnectionChange?.(true);
          const reader = response.body.getReader();
          const cancel = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          const decoder = new TextDecoder();
          const parser = new TeamPresenceEventParser();
          try {
            while (!signal.aborted) {
              const { done, value } = await reader.read();
              if (signal.aborted) return;
              if (done) throw new Error("Team live connection closed.");
              for (const next of parser.push(decoder.decode(value, { stream: true }))) {
                if (signal.aborted) return;
                if (next.type === "presence") onOverview(next.overview);
                else onChanged?.(next.change);
                backoff = 1000;
              }
            }
          } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } catch (cause) {
          if (signal.aborted) return;
          onConnectionChange?.(false);
          onError?.(cause instanceof Error ? cause : new Error("Team live updates unavailable."));
        }
        await pause(backoff, signal);
        backoff = Math.min(backoff * 2, 15000);
      }
    },
    async presence(id, input, signal) { await request(`${route(id)}/presence`, { ...input, clientId }, signal); return snapshot(id, signal); },
    async roomPresence(kind, id, input, signal) { await request(`/api/team/rooms/${kind}/${encodeURIComponent(id)}/presence`, { ...input, clientId }, signal); return overview(signal); },
    async leavePresence(kind, id) {
      await request(kind === "conversation" ? `${route(id)}/presence` : `/api/team/rooms/${kind}/${encodeURIComponent(id)}/presence`, { typing: false, viewing: false, clientId }, AbortSignal.timeout(5000));
    },
  };
}
export function teamInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toLocaleUpperCase() || "?";
}
