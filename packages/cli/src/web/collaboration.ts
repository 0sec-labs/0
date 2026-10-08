import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export class CollaborationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "CollaborationError"; }
}
const roleSchema = z.enum(["owner", "editor", "viewer"]);
const identitySchema = z.object({ workspaceId: z.string().min(1).max(256), userId: z.string().min(1).max(256), displayName: z.string().min(1).max(256), role: roleSchema }).strict();
export type CollaborationIdentity = z.infer<typeof identitySchema>;
const attributionSchema = z.object({ userId: z.string(), displayName: z.string() });
const memberSchema = attributionSchema.extend({ role: roleSchema, joinedAt: z.number() });
const resourceKindSchema = z.enum(["conversation", "report", "workflow"]);
export type CollaborationResourceKind = z.infer<typeof resourceKindSchema>;
export type CollaborationEvent = { type: "presence" } | { type: "changed"; kind: CollaborationResourceKind; id: string };
const roomSchema = z.object({
  kind: resourceKindSchema, id: z.string().min(1).max(160), revision: z.number().int().nonnegative(),
  createdBy: attributionSchema, createdAt: z.number(), members: z.array(memberSchema).max(1000),
});
const stateSchema = z.object({ schemaVersion: z.literal(2), workspaceId: z.string(), rooms: z.array(roomSchema).max(1000) }).strict();
type Room = z.infer<typeof roomSchema>;
export interface CollaborationPresence { userId: string; displayName: string; viewing: boolean; typing: boolean; updatedAt: number }
export interface CollaborationRoomSnapshot {
  kind: CollaborationResourceKind; id: string; workspaceId: string; revision: number;
  viewer: Omit<CollaborationIdentity, "workspaceId">; canWrite: boolean;
  members: z.infer<typeof memberSchema>[]; presence: CollaborationPresence[];
}
export interface CollaborationSnapshot extends Omit<CollaborationRoomSnapshot, "kind" | "id"> { conversationId: string }
export interface CollaborationOverview {
  workspaceId: string; viewer: Omit<CollaborationIdentity, "workspaceId">;
  rooms: Array<{ kind: CollaborationResourceKind; id: string; presence: CollaborationPresence[] }>;
}
export interface CollaborationOptions {
  workspaceId: string; stateDir: string;
  /** Trusted authentication adapter only. Never derive identity from a request body. */
  resolveSession: (serverSessionId: string) => CollaborationIdentity | null | undefined;
  now?: () => number; presenceMs?: number;
}
type PresenceEntry = CollaborationPresence & { sessionId: string };
const MAX_ROOM_PRESENCE = 512;

/** Local persisted room registry. Remote durable actor hosting is a separate adapter. */
export class CollaborationService {
  readonly #options: CollaborationOptions;
  readonly #path: string;
  readonly #lock: string;
  readonly #presence = new Map<string, Map<string, PresenceEntry>>();
  readonly #listeners = new Set<(event: CollaborationEvent) => void>();
  #expiryTimer?: ReturnType<typeof setInterval>;
  #presenceNotificationPending = false;
  readonly #presenceMs: number;
  constructor(options: CollaborationOptions) {
    if (!options.workspaceId || !options.stateDir || typeof options.resolveSession !== "function") throw new CollaborationError("Authenticated workspace collaboration is not configured.", 503);
    this.#options = options;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.#path = join(options.stateDir, createHash("sha256").update(options.workspaceId).digest("hex") + ".json");
    this.#lock = this.#path + ".lock";
    this.#presenceMs = Math.max(1000, Math.min(120000, options.presenceMs ?? 20000));
  }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  subscribe(listener: (event: CollaborationEvent) => void): () => void {
    this.#listeners.add(listener);
    if (!this.#expiryTimer) {
      this.#expiryTimer = setInterval(() => {
        for (const key of this.#presence.keys()) {
          const at = key.indexOf(":"); this.#presenceFor(key.slice(0, at) as CollaborationResourceKind, key.slice(at + 1));
        }
      }, 1000);
      this.#expiryTimer.unref?.();
    }
    let closed = false;
    return () => { if (closed) return; closed = true; this.#listeners.delete(listener); if (!this.#listeners.size && this.#expiryTimer) { clearInterval(this.#expiryTimer); this.#expiryTimer = undefined; } };
  }
  #publish(event: CollaborationEvent): void {
    for (const listener of this.#listeners) { try { listener(event); } catch { /* A disconnected observer cannot block room mutations. */ } }
  }
  #notifyPresence(): void {
    if (this.#presenceNotificationPending || !this.#listeners.size) return;
    this.#presenceNotificationPending = true;
    queueMicrotask(() => { this.#presenceNotificationPending = false; this.#publish({ type: "presence" }); });
  }
  /** Trusted post-write adapter only: the caller proves this resource exists in its workspace. */
  notifyChanged(kind: CollaborationResourceKind, id: string): void {
    if (!z.object({ kind: resourceKindSchema, id: z.string().min(1).max(160) }).safeParse({ kind, id }).success) throw new CollaborationError("Invalid changed resource.");
    this.#publish({ type: "changed", kind, id });
  }
  #actor(sessionId: string): CollaborationIdentity {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 4096) throw new CollaborationError("An authenticated team session is required.", 401);
    const parsed = identitySchema.safeParse(this.#options.resolveSession(sessionId));
    if (!parsed.success) throw new CollaborationError("An authenticated team session is required.", 401);
    if (parsed.data.workspaceId !== this.#options.workspaceId) throw new CollaborationError("Session does not belong to this workspace.", 403);
    return parsed.data;
  }
  #editor(actor: CollaborationIdentity): void {
    if (actor.role === "viewer") throw new CollaborationError("Workspace viewers cannot write to shared conversations.", 403);
  }
  #read(): Room[] {
    let fd: number;
    try { fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new CollaborationError("Collaboration storage could not be read.", 500); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("size");
      const bytes = readFileSync(fd);
      if (bytes.length > 32 * 1024 * 1024) throw new Error("size");
      let source: unknown = JSON.parse(bytes.toString("utf8"));
      const legacy = z.object({ schemaVersion: z.literal(1), workspaceId: z.string(), conversations: z.array(z.object({ id: z.string(), revision: z.number(), createdBy: attributionSchema, createdAt: z.number(), members: z.array(memberSchema) }).passthrough()).max(1000) }).strict().safeParse(source);
      if (legacy.success) source = { schemaVersion: 2, workspaceId: legacy.data.workspaceId, rooms: legacy.data.conversations.map(({ id, revision, createdBy, createdAt, members }) => ({ kind: "conversation", id, revision, createdBy, createdAt, members })) };
      const parsed = stateSchema.parse(source);
      if (parsed.workspaceId !== this.#options.workspaceId || new Set(parsed.rooms.map(row => this.#roomKey(row.kind, row.id))).size !== parsed.rooms.length) throw new Error("workspace");
      return parsed.rooms;
    } catch { throw new CollaborationError("Invalid collaboration storage.", 500); }
    finally { closeSync(fd); }
  }
  #write(rows: Room[]): void {
    const state = stateSchema.safeParse({ schemaVersion: 2, workspaceId: this.#options.workspaceId, rooms: rows });
    if (!state.success) throw new CollaborationError("Collaboration record limit reached.", 409);
    const data = JSON.stringify(state.data);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new CollaborationError("Collaboration storage limit reached.", 409);
    const temporary = this.#path + "." + randomUUID() + ".tmp";
    try { writeFileSync(temporary, data, { flag: "wx", mode: 0o600 }); renameSync(temporary, this.#path); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  #transaction<T>(apply: (rows: Room[]) => T): T {
    let fd: number;
    try { fd = openSync(this.#lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CollaborationError("Collaboration storage is unavailable.", 500);
      // Serialize crash recovery: two processes must not unlink one another's new lock.
      const recoveryPath = this.#lock + ".recovery";
      let recovery: number;
      try { recovery = openSync(recoveryPath, "wx", 0o600); }
      catch { throw new CollaborationError("Collaboration state is busy; retry.", 409); }
      try {
        let pid: number;
        try { pid = Number(readFileSync(this.#lock, "utf8")); if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("pid"); }
        catch { throw new CollaborationError("Collaboration lock needs operator recovery.", 503); }
        try { process.kill(pid, 0); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
            try { unlinkSync(this.#lock); } catch { throw new CollaborationError("Collaboration state is busy; retry.", 409); }
            return this.#transaction(apply);
          }
        }
        throw new CollaborationError("Collaboration state is busy; retry.", 409);
      } finally { closeSync(recovery); unlinkSync(recoveryPath); }
    }
    try { writeFileSync(fd, String(process.pid)); const rows = this.#read(); const result = apply(rows); this.#write(rows); return result; }
    finally { closeSync(fd); unlinkSync(this.#lock); }
  }
  #roomKey(kind: CollaborationResourceKind, id: string): string { return kind + ":" + id; }
  #room(rows: Room[], kind: CollaborationResourceKind, id: string): Room {
    const row = rows.find(item => item.kind === kind && item.id === id);
    if (!row) throw new CollaborationError("Shared resource room not found.", 404);
    return row;
  }
  #join(row: Room, actor: CollaborationIdentity): void {
    const member = row.members.find(item => item.userId === actor.userId);
    if (member) { if (member.displayName !== actor.displayName || member.role !== actor.role) row.revision++; member.displayName = actor.displayName; member.role = actor.role; }
    else { row.members.push({ ...this.#attribution(actor), role: actor.role, joinedAt: this.#now() }); row.revision++; }
  }
  #attribution(actor: CollaborationIdentity) { return { userId: actor.userId, displayName: actor.displayName }; }
  #viewer(actor: CollaborationIdentity): Omit<CollaborationIdentity, "workspaceId"> { const { workspaceId: _workspace, ...viewer } = actor; return viewer; }
  #presenceFor(kind: CollaborationResourceKind, id: string): CollaborationPresence[] {
    const entries = this.#presence.get(this.#roomKey(kind, id));
    const presence = new Map<string, CollaborationPresence>();
    for (const [key, entry] of entries ?? []) {
      if (!entry.viewing || entry.updatedAt + this.#presenceMs <= this.#now()) { entries?.delete(key); this.#notifyPresence(); continue; }
      let authenticated: CollaborationIdentity;
      try { authenticated = this.#actor(entry.sessionId); } catch { entries?.delete(key); this.#notifyPresence(); continue; }
      if (authenticated.userId !== entry.userId) { entries?.delete(key); this.#notifyPresence(); continue; }
      const old = presence.get(entry.userId);
      presence.set(entry.userId, { userId: entry.userId, displayName: authenticated.displayName, viewing: true, typing: Boolean(old?.typing || entry.typing), updatedAt: Math.max(old?.updatedAt ?? 0, entry.updatedAt) });
    }
    return [...presence.values()];
  }
  /** Routing must validate that the underlying resource exists before registration. */
  registerRoom(kind: CollaborationResourceKind, id: string, sessionId: string): CollaborationRoomSnapshot {
    const actor = this.#actor(sessionId);
    const valid = z.object({ kind: resourceKindSchema, id: z.string().min(1).max(160) }).safeParse({ kind, id });
    if (!valid.success) throw new CollaborationError("Invalid resource room.");
    let joined = false;
    this.#transaction(rows => {
      let row = rows.find(item => item.kind === kind && item.id === id);
      if (!row) { row = { kind, id, revision: 0, createdBy: this.#attribution(actor), createdAt: this.#now(), members: [] }; rows.push(row); }
      const revision = row.revision; this.#join(row, actor); joined = row.revision !== revision;
    });
    if (joined) this.#notifyPresence();
    return this.roomSnapshot(kind, id, sessionId);
  }
  register(conversationId: string, sessionId: string): CollaborationSnapshot {
    this.registerRoom("conversation", conversationId, sessionId);
    return this.snapshot(conversationId, sessionId);
  }
  hasConversation(conversationId: string): boolean { return this.#read().some(row => row.kind === "conversation" && row.id === conversationId); }
  roomSnapshot(kind: CollaborationResourceKind, id: string, sessionId: string): CollaborationRoomSnapshot {
    const actor = this.#actor(sessionId);
    const row = this.#room(this.#read(), kind, id);
    return { kind, id, workspaceId: this.#options.workspaceId, revision: row.revision, viewer: this.#viewer(actor), canWrite: actor.role !== "viewer", members: structuredClone(row.members), presence: this.#presenceFor(kind, id) };
  }
  snapshot(conversationId: string, sessionId: string): CollaborationSnapshot {
    const { kind: _kind, id: _id, ...snapshot } = this.roomSnapshot("conversation", conversationId, sessionId);
    return { conversationId, ...snapshot };
  }
  overview(sessionId: string): CollaborationOverview {
    const actor = this.#actor(sessionId);
    const rooms = this.#read().flatMap(room => {
      const presence = this.#presenceFor(room.kind, room.id);
      return presence.length ? [{ kind: room.kind, id: room.id, presence }] : [];
    });
    return { workspaceId: this.#options.workspaceId, viewer: this.#viewer(actor), rooms };
  }
  heartbeatRoom(kind: CollaborationResourceKind, id: string, sessionId: string, input: unknown): CollaborationRoomSnapshot {
    const actor = this.#actor(sessionId);
    const parsed = z.object({ typing: z.boolean(), viewing: z.boolean().default(true), clientId: z.string().uuid().optional() }).strict().safeParse(input);
    if (!parsed.success) throw new CollaborationError("Invalid presence update.");
    this.#presenceFor(kind, id); // Expired or revoked tabs do not consume the room limit.
    let joined = false;
    this.#transaction(rows => { const row = this.#room(rows, kind, id); const revision = row.revision; this.#join(row, actor); joined = row.revision !== revision; });
    const key = this.#roomKey(kind, id);
    let entries = this.#presence.get(key);
    if (!entries) { entries = new Map(); this.#presence.set(key, entries); }
    const entryKey = sessionId + ":" + (parsed.data.clientId ?? "legacy");
    const previous = entries.get(entryKey);
    if (parsed.data.viewing && !previous && entries.size >= MAX_ROOM_PRESENCE) throw new CollaborationError("This resource room has reached its active tab limit.", 429);
    if (parsed.data.viewing) entries.set(entryKey, { ...this.#attribution(actor), sessionId, viewing: true, typing: parsed.data.typing, updatedAt: this.#now() });
    else entries.delete(entryKey);
    if (joined || previous?.typing !== (parsed.data.viewing ? parsed.data.typing : undefined) || previous?.displayName !== (parsed.data.viewing ? actor.displayName : undefined)) this.#notifyPresence();
    return this.roomSnapshot(kind, id, sessionId);
  }
  heartbeat(conversationId: string, sessionId: string, input: unknown): CollaborationSnapshot {
    this.heartbeatRoom("conversation", conversationId, sessionId, input);
    return this.snapshot(conversationId, sessionId);
  }
  /** Any authenticated workspace owner/editor may write directly to shared chats. */
  assertWriter(conversationId: string, sessionId: string): CollaborationIdentity {
    const actor = this.#actor(sessionId);
    this.#editor(actor);
    this.#room(this.#read(), "conversation", conversationId);
    return actor;
  }
}
