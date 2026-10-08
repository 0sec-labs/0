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
const proposalSchema = z.object({
  id: z.string().uuid(), text: z.string().trim().min(1).max(16000), submittedBy: attributionSchema,
  createdAt: z.number(), status: z.enum(["pending", "dispatching", "accepted", "rejected", "failed"]),
  resolvedBy: attributionSchema.optional(), resolvedAt: z.number().optional(), error: z.string().max(1000).optional(),
});
const leaseSchema = z.object({ userId: z.string(), displayName: z.string(), sessionId: z.string(), token: z.string().uuid(), expiresAt: z.number() });
const conversationSchema = z.object({
  id: z.string().min(1).max(160), revision: z.number().int().nonnegative(),
  createdBy: attributionSchema, createdAt: z.number(),
  members: z.array(memberSchema).max(500), proposals: z.array(proposalSchema).max(500), lease: leaseSchema.nullable(),
});
const stateSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string(), conversations: z.array(conversationSchema).max(1000) }).strict();
type Conversation = z.infer<typeof conversationSchema>;
export type CollaborationProposal = z.infer<typeof proposalSchema>;
export interface CollaborationPresence { userId: string; displayName: string; viewing: boolean; typing: boolean; updatedAt: number }
export interface CollaborationSnapshot {
  conversationId: string; workspaceId: string; revision: number;
  viewer: Omit<CollaborationIdentity, "workspaceId">; canControl: boolean;
  controller: { userId: string; displayName: string; expiresAt: number } | null;
  members: z.infer<typeof memberSchema>[]; presence: CollaborationPresence[]; proposals: CollaborationProposal[];
}
export interface CollaborationOptions {
  workspaceId: string;
  stateDir: string;
  /** Trusted authentication adapter only. Never derive this identity from a request body. */
  resolveSession: (serverSessionId: string) => CollaborationIdentity | null | undefined;
  now?: () => number;
  leaseMs?: number;
  presenceMs?: number;
}
type PresenceEntry = CollaborationPresence & { sessionId: string };

/**
 * Workspace-team collaboration, available only with authenticated server sessions.
 * All configured workspace members may view/join; only editors/owners control.
 * Durable dispatching proposals are never automatically retried after a crash.
 */
export class CollaborationService {
  readonly #options: CollaborationOptions;
  readonly #path: string;
  readonly #lock: string;
  readonly #presence = new Map<string, Map<string, PresenceEntry>>();
  readonly #leaseMs: number;
  readonly #presenceMs: number;
  constructor(options: CollaborationOptions) {
    if (!options.workspaceId || !options.stateDir || typeof options.resolveSession !== "function") throw new CollaborationError("Authenticated workspace collaboration is not configured.", 503);
    this.#options = options;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.#path = join(options.stateDir, createHash("sha256").update(options.workspaceId).digest("hex") + ".json");
    this.#lock = this.#path + ".lock";
    this.#leaseMs = Math.max(1000, Math.min(300000, options.leaseMs ?? 30000));
    this.#presenceMs = Math.max(1000, Math.min(120000, options.presenceMs ?? 20000));
  }
  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #actor(sessionId: string): CollaborationIdentity {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 4096) throw new CollaborationError("An authenticated team session is required.", 401);
    const parsed = identitySchema.safeParse(this.#options.resolveSession(sessionId));
    if (!parsed.success) throw new CollaborationError("An authenticated team session is required.", 401);
    if (parsed.data.workspaceId !== this.#options.workspaceId) throw new CollaborationError("Session does not belong to this workspace.", 403);
    return parsed.data;
  }
  #editor(actor: CollaborationIdentity): void {
    if (actor.role === "viewer") throw new CollaborationError("Workspace viewers cannot control or propose agent actions.", 403);
  }
  #read(): Conversation[] {
    let fd: number;
    try { fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new CollaborationError("Collaboration storage could not be read.", 500); }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("size");
      const bytes = readFileSync(fd);
      if (bytes.length > 32 * 1024 * 1024) throw new Error("size");
      const parsed = stateSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (parsed.workspaceId !== this.#options.workspaceId || new Set(parsed.conversations.map(row => row.id)).size !== parsed.conversations.length) throw new Error("workspace");
      return parsed.conversations;
    } catch { throw new CollaborationError("Invalid collaboration storage.", 500); }
    finally { closeSync(fd); }
  }
  #write(rows: Conversation[]): void {
    const state = stateSchema.safeParse({ schemaVersion: 1, workspaceId: this.#options.workspaceId, conversations: rows });
    if (!state.success) throw new CollaborationError("Collaboration record limit reached.", 409);
    const data = JSON.stringify(state.data);
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new CollaborationError("Collaboration storage limit reached.", 409);
    const temporary = this.#path + "." + randomUUID() + ".tmp";
    try { writeFileSync(temporary, data, { flag: "wx", mode: 0o600 }); renameSync(temporary, this.#path); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  #transaction<T>(apply: (rows: Conversation[]) => T): T {
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
  #conversation(rows: Conversation[], id: string): Conversation {
    const row = rows.find(item => item.id === id);
    if (!row) throw new CollaborationError("Shared conversation not found.", 404);
    return row;
  }
  #join(row: Conversation, actor: CollaborationIdentity): void {
    const member = row.members.find(item => item.userId === actor.userId);
    if (member) { member.displayName = actor.displayName; member.role = actor.role; }
    else row.members.push({ ...this.#attribution(actor), role: actor.role, joinedAt: this.#now() });
  }
  #attribution(actor: CollaborationIdentity) { return { userId: actor.userId, displayName: actor.displayName }; }
  #liveLease(row: Conversation) { return row.lease && row.lease.expiresAt > this.#now() ? row.lease : null; }
  #controller(row: Conversation, actor: CollaborationIdentity, sessionId: string, token: string): void {
    this.#editor(actor);
    const lease = this.#liveLease(row);
    if (!lease || lease.userId !== actor.userId || lease.sessionId !== sessionId || lease.token !== token) throw new CollaborationError("A current controller lease for this authenticated session is required.", 409);
  }
  /** Called by trusted routing after the real gateway conversation has been created. */
  register(conversationId: string, sessionId: string): CollaborationSnapshot {
    const actor = this.#actor(sessionId);
    if (typeof conversationId !== "string" || !conversationId || conversationId.length > 160) throw new CollaborationError("Invalid conversation ID.");
    this.#transaction(rows => {
      if (rows.some(row => row.id === conversationId)) throw new CollaborationError("Shared conversation already exists.", 409);
      rows.push({ id: conversationId, revision: 0, createdBy: this.#attribution(actor), createdAt: this.#now(), members: [{ ...this.#attribution(actor), role: actor.role, joinedAt: this.#now() }], proposals: [], lease: null });
    });
    return this.snapshot(conversationId, sessionId);
  }
  /** Only a workspace owner can import an existing private/legacy conversation. */
  importConversation(conversationId: string, sessionId: string): CollaborationSnapshot {
    const actor = this.#actor(sessionId);
    if (actor.role !== "owner") throw new CollaborationError("Only a workspace owner can share a legacy conversation.", 403);
    return this.register(conversationId, sessionId);
  }
  hasConversation(conversationId: string): boolean { return this.#read().some(row => row.id === conversationId); }
  snapshot(conversationId: string, sessionId: string): CollaborationSnapshot {
    const actor = this.#actor(sessionId);
    const row = this.#conversation(this.#read(), conversationId);
    const lease = this.#liveLease(row);
    const presence = new Map<string, CollaborationPresence>();
    const entries = this.#presence.get(conversationId);
    for (const [key, entry] of entries ?? []) {
      if (entry.updatedAt + this.#presenceMs <= this.#now()) { entries?.delete(key); continue; }
      // Logout/revocation invalidates presence as well as mutation permission.
      let authenticated: CollaborationIdentity;
      try { authenticated = this.#actor(entry.sessionId); } catch { entries?.delete(key); continue; }
      if (authenticated.userId !== entry.userId) { entries?.delete(key); continue; }
      const old = presence.get(entry.userId);
      presence.set(entry.userId, { userId: entry.userId, displayName: authenticated.displayName, viewing: Boolean(old?.viewing || entry.viewing), typing: Boolean(old?.typing || entry.typing), updatedAt: Math.max(old?.updatedAt ?? 0, entry.updatedAt) });
    }
    const { workspaceId: _workspace, ...viewer } = actor;
    return { conversationId, workspaceId: this.#options.workspaceId, revision: row.revision, viewer, canControl: actor.role !== "viewer" && lease?.userId === actor.userId && lease.sessionId === sessionId,
      controller: lease ? { userId: lease.userId, displayName: lease.displayName, expiresAt: lease.expiresAt } : null,
      members: structuredClone(row.members), presence: [...presence.values()], proposals: structuredClone(row.proposals) };
  }
  heartbeat(conversationId: string, sessionId: string, input: unknown): CollaborationSnapshot {
    const actor = this.#actor(sessionId);
    const parsed = z.object({ typing: z.boolean(), viewing: z.boolean().default(true) }).strict().safeParse(input);
    if (!parsed.success) throw new CollaborationError("Presence requires typing and optional viewing booleans.");
    this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#join(row, actor);
      if (row.lease?.sessionId === sessionId && row.lease.userId === actor.userId && this.#liveLease(row) && actor.role !== "viewer") row.lease.expiresAt = this.#now() + this.#leaseMs;
    });
    let entries = this.#presence.get(conversationId);
    if (!entries) { entries = new Map(); this.#presence.set(conversationId, entries); }
    entries.set(sessionId, { ...this.#attribution(actor), sessionId, ...parsed.data, typing: parsed.data.viewing && parsed.data.typing, updatedAt: this.#now() });
    return this.snapshot(conversationId, sessionId);
  }
  acquireController(conversationId: string, sessionId: string): { leaseToken: string; expiresAt: number; snapshot: CollaborationSnapshot } {
    const actor = this.#actor(sessionId); this.#editor(actor);
    const lease = this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#join(row, actor);
      const current = this.#liveLease(row);
      if (current && (current.sessionId !== sessionId || current.userId !== actor.userId)) throw new CollaborationError("Another authenticated session controls this conversation.", 409);
      row.lease = { ...this.#attribution(actor), sessionId, token: current?.token ?? randomUUID(), expiresAt: this.#now() + this.#leaseMs }; row.revision++;
      return structuredClone(row.lease);
    });
    return { leaseToken: lease.token, expiresAt: lease.expiresAt, snapshot: this.snapshot(conversationId, sessionId) };
  }
  releaseController(conversationId: string, sessionId: string, token: string): CollaborationSnapshot {
    const actor = this.#actor(sessionId);
    this.#transaction(rows => { const row = this.#conversation(rows, conversationId); this.#controller(row, actor, sessionId, token); row.lease = null; row.revision++; });
    return this.snapshot(conversationId, sessionId);
  }
  renewController(conversationId: string, sessionId: string, token: string): { leaseToken: string; expiresAt: number; snapshot: CollaborationSnapshot } {
    const actor = this.#actor(sessionId);
    const expiresAt = this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#controller(row, actor, sessionId, token);
      row.lease!.expiresAt = this.#now() + this.#leaseMs; return row.lease!.expiresAt;
    });
    return { leaseToken: token, expiresAt, snapshot: this.snapshot(conversationId, sessionId) };
  }
  /** Every shared gateway mutation must pass this server-side admission guard. */
  assertController(conversationId: string, sessionId: string, token: string): CollaborationIdentity {
    const actor = this.#actor(sessionId);
    this.#controller(this.#conversation(this.#read(), conversationId), actor, sessionId, token);
    return actor;
  }
  propose(conversationId: string, sessionId: string, input: unknown): CollaborationProposal {
    const actor = this.#actor(sessionId); this.#editor(actor);
    const parsed = z.object({ text: z.string().trim().min(1).max(16000) }).strict().safeParse(input);
    if (!parsed.success) throw new CollaborationError("Proposal requires text only, up to 16000 characters.");
    return this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#join(row, actor);
      const proposal: CollaborationProposal = { id: randomUUID(), text: parsed.data.text, submittedBy: this.#attribution(actor), createdAt: this.#now(), status: "pending" };
      row.proposals.push(proposal); row.revision++; return structuredClone(proposal);
    });
  }
  rejectProposal(conversationId: string, sessionId: string, proposalId: string, token: string): CollaborationProposal {
    const actor = this.#actor(sessionId);
    return this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#controller(row, actor, sessionId, token);
      const proposal = row.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new CollaborationError("Proposal not found.", 404);
      if (proposal.status !== "pending") throw new CollaborationError("Proposal has already been resolved or dispatched.", 409);
      Object.assign(proposal, { status: "rejected", resolvedBy: this.#attribution(actor), resolvedAt: this.#now() }); row.revision++;
      return structuredClone(proposal);
    });
  }
  /**
   * Persist admission before dispatch. A second acceptance cannot dispatch again.
   * Adapter success means gateway admission, not that the model/tool run finished.
   * Adapter errors may occur after an external side effect: failed is non-retryable.
   */
  async acceptProposal(conversationId: string, sessionId: string, proposalId: string, token: string, dispatch: (text: string, attribution: { userId: string; displayName: string }, proposalId: string) => unknown | Promise<unknown>): Promise<CollaborationProposal> {
    const actor = this.#actor(sessionId);
    const prepared = this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId); this.#controller(row, actor, sessionId, token);
      const proposal = row.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new CollaborationError("Proposal not found.", 404);
      if (proposal.status !== "pending") throw new CollaborationError("Proposal has already been resolved or dispatched.", 409);
      Object.assign(proposal, { status: "dispatching", resolvedBy: this.#attribution(actor), resolvedAt: this.#now() }); row.revision++;
      return structuredClone(proposal);
    });
    let error: string | undefined;
    try { await dispatch(prepared.text, prepared.submittedBy, proposalId); }
    catch { error = "Dispatch did not confirm admission. It may have applied an action; reconcile the conversation before proposing again."; }
    return this.#transaction(rows => {
      const row = this.#conversation(rows, conversationId);
      const proposal = row.proposals.find(item => item.id === proposalId)!;
      if (proposal.status !== "dispatching") throw new CollaborationError("Proposal dispatch state changed unexpectedly.", 409);
      proposal.status = error ? "failed" : "accepted";
      if (error) proposal.error = error;
      row.revision++; return structuredClone(proposal);
    });
  }
}
