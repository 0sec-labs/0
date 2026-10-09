import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { TeamAuth, TeamAuthError } from "./team-auth.js";

export class FindingsAccessError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "FindingsAccessError"; }
}
const scopesSchema = z.tuple([z.literal("read:findings")]);
const publicTokenSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1).max(256), name: z.string().min(1).max(160),
  scopes: scopesSchema, createdBy: z.string().min(1).max(256), createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(), revokedAt: z.string().datetime().nullable(),
}).strict();
const tokenSchema = publicTokenSchema.extend({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string(), tokens: z.array(tokenSchema).max(1000) }).strict();
export type FindingsAccessToken = z.infer<typeof publicTokenSchema>;
const createSchema = z.object({
  name: z.string().trim().min(1).max(160), scopes: scopesSchema.optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

/** Explicit external read contract only. Browser/admin APIs never inherit this grant. */
export function findingsReadPath(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname === "/api/v1/findings" || pathname === "/api/v1/findings/export" || /^\/api\/v1\/findings\/[A-Za-z0-9_.:-]+$/.test(pathname);
}
const redact = (record: z.infer<typeof tokenSchema>): FindingsAccessToken => { const { tokenHash: _hash, ...publicRecord } = record; return publicRecord; };

export class FindingsAccessTokenStore {
  readonly workspaceId: string;
  readonly #path: string;
  readonly #now: () => number;
  constructor(options: { workspaceId: string; stateDir: string; now?: () => number }) {
    if (!options.workspaceId || options.workspaceId.length > 256) throw new FindingsAccessError("A workspace is required.");
    this.workspaceId = options.workspaceId; this.#now = options.now ?? Date.now;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    this.#path = join(options.stateDir, createHash("sha256").update(options.workspaceId).digest("hex") + ".json");
  }
  #read(): z.infer<typeof tokenSchema>[] {
    let fd: number;
    try { fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new FindingsAccessError("API access storage is unavailable.", 500); }
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("size");
      const bytes = readFileSync(fd); if (bytes.length > 2 * 1024 * 1024) throw new Error("size");
      const state = stateSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (state.workspaceId !== this.workspaceId || state.tokens.some(token => token.workspaceId !== this.workspaceId) || new Set(state.tokens.map(token => token.id)).size !== state.tokens.length) throw new Error("workspace");
      return state.tokens;
    } catch { throw new FindingsAccessError("Invalid API access storage.", 500); }
    finally { closeSync(fd); }
  }
  #write(records: z.infer<typeof tokenSchema>[]): void {
    const state = stateSchema.safeParse({ schemaVersion: 1, workspaceId: this.workspaceId, tokens: records });
    if (!state.success) throw new FindingsAccessError("API credential limit reached.", 409);
    const temporary = this.#path + "." + randomUUID() + ".tmp";
    try { writeFileSync(temporary, JSON.stringify(state.data), { flag: "wx", mode: 0o600 }); renameSync(temporary, this.#path); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  #mutate<T>(action: () => T): T {
    const path = this.#path + ".lock";
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch { throw new FindingsAccessError("API access storage is busy or requires lock recovery; retry after the writer finishes.", 409); }
    try { writeFileSync(fd, String(process.pid)); return action(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  list(): FindingsAccessToken[] { return this.#read().map(redact); }
  /** Caller supplies a verified owner identity, never createdBy from the HTTP body. */
  create(input: unknown, createdBy: string): { credential: FindingsAccessToken; token: string } {
    return this.#mutate(() => {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success || !createdBy || createdBy.length > 256) throw new FindingsAccessError("Use a name, optional read:findings scope and future expiry.");
    const records = this.#read();
    const now = this.#now();
    const expiresAt = parsed.data.expiresAt === undefined ? new Date(now + 90 * 86400000).toISOString() : parsed.data.expiresAt;
    if (expiresAt !== null && Date.parse(expiresAt) <= now) throw new FindingsAccessError("API credential expiry must be in the future.");
    const token = "0_find_" + randomBytes(32).toString("base64url");
    const record: z.infer<typeof tokenSchema> = { id: randomUUID(), workspaceId: this.workspaceId, name: parsed.data.name, scopes: ["read:findings"], createdBy, createdAt: new Date(now).toISOString(), expiresAt, revokedAt: null, tokenHash: createHash("sha256").update(token).digest("hex") };
    this.#write([...records, record]);
    return { credential: redact(record), token };
    });
  }
  revoke(id: string): FindingsAccessToken {
    return this.#mutate(() => {
    const records = this.#read(); const record = records.find(token => token.id === id);
    if (!record) throw new FindingsAccessError("API credential not found.", 404);
    record.revokedAt ??= new Date(this.#now()).toISOString(); this.#write(records);
    return redact(record);
    });
  }
  /** Returns null for other transports; a valid findings bearer never bypasses its read-only path scope. */
  authenticate(req: Pick<IncomingMessage, "headers" | "method">, url: URL): FindingsAccessToken | null {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer 0_find_")) return null;
    if (["token", "access_token", "api_key", "authorization"].some(key => url.searchParams.has(key))) throw new FindingsAccessError("Send API credentials only in the Authorization header.");
    if (!/^Bearer 0_find_[A-Za-z0-9_-]{43}$/.test(header)) throw new FindingsAccessError("Invalid findings API credential.", 401);
    const digest = createHash("sha256").update(header.slice(7)).digest();
    let found: z.infer<typeof tokenSchema> | undefined;
    for (const token of this.#read()) if (timingSafeEqual(digest, Buffer.from(token.tokenHash, "hex"))) found = token;
    if (!found || found.revokedAt || (found.expiresAt !== null && Date.parse(found.expiresAt) <= this.#now())) throw new FindingsAccessError("Invalid or expired findings API credential.", 401);
    if (found.workspaceId !== this.workspaceId || !findingsReadPath(req.method ?? "GET", url.pathname)) throw new FindingsAccessError("This API credential permits read-only findings access.", 403);
    return redact(found);
  }
}

/** Root validates the browser control transport first, including in personal account-free mode. */
export async function handleFindingsAccessTokenRequest(
  req: IncomingMessage, url: URL, auth: TeamAuth, store: FindingsAccessTokenStore,
  readBody: () => Promise<unknown>,
): Promise<{ status: number; data: unknown } | undefined> {
  const match = /^\/api\/findings-access(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  if (!match) return;
  let owner = "local-owner";
  if (auth.enabled) {
    const actor = auth.resolveSession(req);
    if (!actor) throw new TeamAuthError("Sign in to this workspace.");
    if (actor.role !== "owner" || actor.workspaceId !== store.workspaceId) throw new TeamAuthError("Only workspace owners can manage findings API credentials.", 403);
    owner = actor.userId;
  }
  if (req.method === "GET" && !match[1]) return { status: 200, data: { credentials: store.list() } };
  if (req.method === "POST" && !match[1]) return { status: 201, data: store.create(await readBody(), owner) };
  if (req.method === "DELETE" && match[1]) return { status: 200, data: { credential: store.revoke(match[1]) } };
  throw new FindingsAccessError("Method not allowed.", 405);
}
