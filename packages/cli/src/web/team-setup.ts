import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { dirname, join, resolve } from "node:path";
import { homeStateDir } from "@0/shared";
import { z } from "zod";
import { TeamAuth, TeamAuthError, hashTeamPassword, parseTeamConfig, type TeamConfig } from "./team-auth.js";

const setupSchema = z.object({
  workspaceName: z.string().trim().min(1).max(160), displayName: z.string().trim().min(1).max(160),
  userId: z.string().trim().min(1).max(160), password: z.string().min(1).max(1024),
}).strict();
const memberSchema = z.object({ userId: z.string().trim().min(1).max(160), displayName: z.string().trim().min(1).max(160), password: z.string().min(1).max(1024), role: z.enum(["editor", "viewer"]) }).strict();
function readPrivateConfig(path: string): TeamConfig {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) throw new TeamAuthError("Team configuration must be a private regular file", 409);
    return parseTeamConfig(JSON.parse(readFileSync(fd, "utf8")));
  } finally { closeSync(fd); }
}
const configDigest = (config: TeamConfig) => createHash("sha256").update(JSON.stringify(config)).digest("hex");
export function defaultTeamConfigPath(workspacePath: string, stateRoot = homeStateDir()): string {
  const canonical = realpathSync(resolve(workspacePath));
  return join(stateRoot, "team-configs", `${createHash("sha256").update(canonical).digest("hex")}.json`);
}
export function findTeamConfigPath(options: { workspacePath: string; stateRoot?: string; explicitConfigPath?: string }): string | undefined {
  if (options.explicitConfigPath) return resolve(options.explicitConfigPath);
  const path = defaultTeamConfigPath(options.workspacePath, options.stateRoot);
  return existsSync(path) ? path : undefined;
}
export function isolatedTeamPaths(workspaceId: string, stateRoot = homeStateDir()) {
  const stateDir = join(stateRoot, "teams", createHash("sha256").update(workspaceId).digest("hex"));
  return { stateDir, dbPath: join(stateDir, "data.db") };
}
export interface PreparedTeamWorkspace {
  auth: TeamAuth; configPath: string; stateDir: string; dbPath: string; workspaceId: string; name: string;
}
interface TeamSetupOptions {
  workspacePath: string; stateRoot?: string; configPath?: string; origin: () => string; currentAuth: () => TeamAuth;
  /** Stage fresh isolated services and atomically swap them; reject without replacing personal services on failure. */
  activate: (workspace: PreparedTeamWorkspace) => Promise<void>;
  now?: () => number;
}
/** Same-server, one-time workspace onboarding. No personal DB/transcript path is ever reused. */
export class TeamSetupService {
  private readonly configPath: string;
  private readonly stateRoot: string;
  private busy = false;
  private lastAttempt = 0;
  private attemptCount = 0;
  constructor(private readonly options: TeamSetupOptions) {
    this.stateRoot = options.stateRoot ?? homeStateDir();
    this.configPath = options.configPath ? resolve(options.configPath) : defaultTeamConfigPath(options.workspacePath, this.stateRoot);
  }
  status() { return { available: !this.options.currentAuth().enabled && !existsSync(this.configPath), pending: this.busy }; }
  members(req: Pick<IncomingMessage, "headers">) {
    const auth = this.options.currentAuth();
    if (!auth.resolveSession(req)) throw new TeamAuthError("Sign in to this workspace");
    return { users: auth.members() };
  }
  async addMember(req: Pick<IncomingMessage, "headers">, input: unknown) {
    const auth = this.options.currentAuth(); const actor = auth.resolveSession(req);
    if (!actor) throw new TeamAuthError("Sign in to this workspace");
    if (actor.role !== "owner") throw new TeamAuthError("Only workspace owners can add teammates", 403);
    if (this.busy) throw new TeamAuthError("Workspace configuration is being updated", 409);
    const parsed = memberSchema.safeParse(input);
    if (!parsed.success) throw new TeamAuthError("Account ID, display name, password and editor or viewer role are required", 400);
    const data = parsed.data;
    if (auth.members().some(user => user.userId === data.userId)) throw new TeamAuthError("That account ID already exists", 409);
    if (auth.members().length >= 1000) throw new TeamAuthError("Workspace member limit reached", 409);
    this.busy = true;
    const lockPath = `${this.configPath}.lock`; const tempPath = `${this.configPath}.${randomUUID()}.tmp`;
    let lockFD: number | undefined; let temporaryFD: number | undefined;
    try {
      try { lockFD = openSync(lockPath, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TeamAuthError("Workspace configuration is being updated", 409); throw error; }
      const baseline = auth.configurationDigest(); const config = readPrivateConfig(this.configPath);
      if (configDigest(config) !== baseline) throw new TeamAuthError("Workspace configuration changed outside this server; reload the engine before adding teammates", 409);
      const member = { id: data.userId, name: data.displayName, role: data.role, passwordHash: await hashTeamPassword(data.password) };
      config.users.push(member);
      temporaryFD = openSync(tempPath, "wx", 0o600);
      writeFileSync(temporaryFD, `${JSON.stringify(config, null, 2)}\n`, "utf8"); fsyncSync(temporaryFD); closeSync(temporaryFD); temporaryFD = undefined;
      // The lock is shared with `0 team add-user`; CAS also catches external manual edits.
      if (auth.configurationDigest() !== baseline || configDigest(readPrivateConfig(this.configPath)) !== baseline) throw new TeamAuthError("Workspace configuration changed during this update", 409);
      renameSync(tempPath, this.configPath);
      return { user: auth.addMember(member) };
    } catch (error) {
      if (error instanceof TeamAuthError) throw error;
      throw new TeamAuthError("The teammate account could not be created", 500);
    } finally {
      if (temporaryFD !== undefined) closeSync(temporaryFD);
      try { unlinkSync(tempPath); } catch { /* Renamed or not created. */ }
      if (lockFD !== undefined) { closeSync(lockFD); unlinkSync(lockPath); }
      this.busy = false;
    }
  }
  async setup(input: unknown) {
    if (this.busy) throw new TeamAuthError("Workspace setup is already in progress", 409);
    if (!this.status().available) throw new TeamAuthError("A team workspace is already configured", 409);
    const parsed = setupSchema.safeParse(input);
    if (!parsed.success) throw new TeamAuthError("Workspace name, display name, account ID and password are required", 400);
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastAttempt >= 60_000 || this.attemptCount === 0) { this.lastAttempt = now; this.attemptCount = 0; }
    if (++this.attemptCount > 5) throw new TeamAuthError("Too many setup attempts; try again shortly", 429);
    this.busy = true;
    let reserved = false;
    let fd: number | undefined;
    try {
      const data = parsed.data;
      const config: TeamConfig = {
        workspace: { id: randomUUID(), name: data.workspaceName },
        users: [{ id: data.userId, name: data.displayName, role: "owner", passwordHash: await hashTeamPassword(data.password) }],
      };
      const auth = new TeamAuth({ config, origin: this.options.origin() });
      const session = await auth.login({ userId: data.userId, password: data.password });
      const paths = isolatedTeamPaths(config.workspace.id, this.stateRoot);
      mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
      // O_EXCL protects an existing configuration from concurrent setup or CLI provisioning.
      try { fd = openSync(this.configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TeamAuthError("A team workspace is already configured", 409);
        throw error;
      }
      reserved = true;
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      await this.options.activate({ auth, configPath: this.configPath, ...paths, workspaceId: config.workspace.id, name: config.workspace.name });
      // The active bundle uses this exact auth object, so this owner session works immediately.
      reserved = false;
      return { user: session.user, workspace: config.workspace, setCookie: session.setCookie, sessionId: session.sessionId };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (reserved) { try { unlinkSync(this.configPath); } catch { /* Preserve setup failure. */ } }
      if (error instanceof TeamAuthError) throw error;
      // Filesystem/provider errors must not return account data or submitted credentials.
      throw new TeamAuthError("Workspace setup could not be completed", 500);
    } finally { this.busy = false; }
  }
}

/** Call after the existing origin/control-token transport guard, before team membership authorization. */
export async function handleTeamSetupRequest(
  req: { method?: string; headers?: IncomingMessage["headers"] }, url: URL, setup: TeamSetupService, readBody: () => Promise<unknown>,
): Promise<{ status: number; data: unknown; headers?: Record<string, string> } | undefined> {
  if (url.pathname === "/api/team/users") {
    const request = { headers: req.headers ?? {} };
    if (req.method === "GET") return { status: 200, data: setup.members(request) };
    if (req.method === "POST") return { status: 201, data: await setup.addMember(request, await readBody()) };
    throw new TeamAuthError("Method not allowed", 405);
  }
  if (url.pathname !== "/api/team/setup") return;
  if (req.method === "GET") return { status: 200, data: setup.status() };
  if (req.method !== "POST") throw new TeamAuthError("Method not allowed", 405);
  const result = await setup.setup(await readBody());
  return { status: 201, data: { enabled: true, workspace: result.workspace, user: result.user, sso: false }, headers: { "Set-Cookie": result.setCookie } };
}
