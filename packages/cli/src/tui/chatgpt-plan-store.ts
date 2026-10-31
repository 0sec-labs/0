import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeStateDir } from "@0/shared";
import { credential, loginSiwc, refreshSiwcProfile, SIWC_ISSUER, siwcMetadata, validateSiwcTokens, type SiwcLoginOptions, type SiwcProfile, type SiwcTransport } from "./chatgpt-plan-auth.js";

interface StoredProfile extends SiwcProfile { pendingRotation?: unknown; epoch?: number }
interface Store { version: 1; revision: number; hostId: string; activeId?: string; profiles: StoredProfile[] }
export interface ChatGptPlanSummary { id: string; label: string; active: boolean; status: string; sharing: boolean }
function paths(homeDir?: string) { const directory = join(homeStateDir(homeDir), "chatgpt-plan"); return { directory, file: join(directory, "accounts.json"), lock: join(directory, "write.lock") }; }
function checkPrivate(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new Error("ChatGPT connection storage must be private and owned by this user.");
}
function read(homeDir?: string): Store | undefined {
  const { directory, file } = paths(homeDir);
  if (!existsSync(directory)) return undefined;
  checkPrivate(directory, true); if (!existsSync(file)) return undefined; checkPrivate(file, false);
  if (lstatSync(file).size > 4_194_304) throw new Error("ChatGPT connection storage exceeded its limit.");
  let data: Store;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("ChatGPT connection storage is invalid."); }
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.hostId) || !Array.isArray(data.profiles) || data.profiles.length > 100) throw new Error("ChatGPT connection storage is invalid.");
  const ids = new Set<string>();
  for (const p of data.profiles) {
    if (!p || typeof p.id !== "string" || ids.has(p.id) || typeof p.subject !== "string" || !p.subject || p.issuer !== SIWC_ISSUER || !["connected", "signed-out", "reauth-required"].includes(p.status) || !Array.isArray(p.scopes) || !p.scopes.every(scope => typeof scope === "string") || typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt) || typeof p.idToken !== "string") throw new Error("ChatGPT connection storage is invalid.");
    if (p.epoch !== undefined && (!Number.isSafeInteger(p.epoch) || p.epoch < 0)) throw new Error("ChatGPT connection generation is invalid.");
    credential(p.clientId); if (p.clientId === "dynamic_agent_client") throw new Error("ChatGPT connection storage has no issued registration.");
    if (p.accessToken !== undefined) credential(p.accessToken); if (p.refreshToken !== undefined) credential(p.refreshToken);
    ids.add(p.id);
  }
  if (data.activeId !== undefined && !ids.has(data.activeId)) throw new Error("ChatGPT connection selection is invalid.");
  return data;
}
function write(store: Store, homeDir?: string) {
  const { directory, file } = paths(homeDir); checkPrivate(directory, true);
  const disk = read(homeDir);
  if ((disk?.revision ?? 0) !== store.revision) throw new Error("ChatGPT connection storage changed. Retry the operation.");
  const next = { ...store, revision: store.revision + 1 }, temp = join(directory, `${randomUUID()}.tmp`);
  const bytes = JSON.stringify(next); if (Buffer.byteLength(bytes) > 4_194_304) throw new Error("ChatGPT connection storage exceeded its limit.");
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); store.revision = next.revision; if (process.platform !== "win32") { const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); } } } finally { if (existsSync(temp)) unlinkSync(temp); }
}
async function locked<T>(homeDir: string | undefined, operation: (store: Store) => Promise<T>): Promise<T> {
  const { directory, lock } = paths(homeDir); mkdirSync(directory, { recursive: true, mode: 0o700 }); checkPrivate(directory, true);
  let fd: number | undefined;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("ChatGPT connection storage is busy. Close other connection operations and retry; an interrupted operation may require removing its stale lock."); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  try { return await operation(read(homeDir) ?? { version: 1, revision: 0, hostId: `urn:uuid:${randomUUID()}`, profiles: [] }); }
  finally { closeSync(fd); unlinkSync(lock); }
}
export function listChatGptPlanProfiles(homeDir?: string): ChatGptPlanSummary[] {
  const store = read(homeDir);
  return store?.profiles.map((p, index) => ({ id: p.id, label: `${p.email ?? "ChatGPT account"} · Connection ${index + 1}`, active: store.activeId === p.id, status: p.status, sharing: p.status === "connected" && p.scopes.includes("chatgpt.tokens.use.direct") && p.scopes.includes("resource.invoke") })) ?? [];
}
export async function signInChatGptPlan(options: Omit<SiwcLoginOptions, "hostId" | "previous"> & { homeDir?: string; profileId?: string }): Promise<void> {
  const prepared = await locked(options.homeDir, async store => {
    const previous = options.profileId ? store.profiles.find(p => p.id === options.profileId) : undefined;
    if (options.profileId && !previous) throw new Error("The selected ChatGPT connection no longer exists.");
    if (!previous && store.profiles.length >= 100) throw new Error("This host already has 100 ChatGPT registrations. Reconnect an existing connection.");
    write(store, options.homeDir); return { hostId: store.hostId, previous };
  });
  const result = await loginSiwc({ ...options, ...prepared }); options.signal?.throwIfAborted();
  await locked(options.homeDir, async store => {
    options.signal?.throwIfAborted();
    const existing = options.profileId ? store.profiles.find(p => p.id === options.profileId) : undefined;
    if (options.profileId && (!existing || existing.clientId !== result.clientId || existing.subject !== result.subject || (existing.epoch ?? 0) !== (prepared.previous?.epoch ?? 0))) throw new Error("The selected ChatGPT registration changed during sign-in.");
    const profile: StoredProfile = { id: existing?.id ?? randomUUID(), ...result, epoch: (existing?.epoch ?? 0) + 1 };
    store.profiles = [...store.profiles.filter(p => p.id !== profile.id), profile]; store.activeId = profile.id; write(store, options.homeDir);
  });
}
export async function selectChatGptPlanProfile(profileId: string, homeDir?: string): Promise<void> {
  await locked(homeDir, async store => { if (!store.profiles.some(p => p.id === profileId && p.status === "connected")) throw new Error("Sign in to this ChatGPT connection before selecting it."); store.activeId = profileId; write(store, homeDir); });
}
export function getSiwcConnection(homeDir?: string, profileId?: string, transport: SiwcTransport = {}) {
  const current = read(homeDir), selected = profileId ?? current?.activeId, profile = current?.profiles.find(p => p.id === selected);
  if (!current || !profile || profile.status !== "connected") throw new Error("Connect your ChatGPT plan in Connections before choosing this provider.");
  const binding = { accountId: profile.subject, clientId: profile.clientId, hostId: current.hostId };
  return { ...binding, resolveCredentials: async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const result = await locked(homeDir, async store => {
      signal?.throwIfAborted();
      let p = store.profiles.find(p => p.id === selected);
      if (!p || p.status !== "connected" || p.subject !== binding.accountId || p.clientId !== binding.clientId || store.hostId !== binding.hostId) throw new Error("This ChatGPT registration is no longer available. Reconnect it.");
      if (p.pendingRotation !== undefined) {
        const next = await validateSiwcTokens(p.pendingRotation, p.clientId, await siwcMetadata(transport), transport, undefined, { subject: p.subject, scopes: p.scopes, previous: p });
        p = { id: p.id, ...next, epoch: p.epoch }; store.profiles = store.profiles.map(row => row.id === p!.id ? p! : row); write(store, homeDir);
      }
      if (!p.scopes.includes("chatgpt.tokens.use.direct") || !p.scopes.includes("resource.invoke")) throw new Error("ChatGPT plan usage is not enabled for this connection. Sign in and grant plan usage, or use an API key.");
      signal?.throwIfAborted();
      const now = transport.now?.() ?? Date.now();
      if (p.expiresAt <= now + 60_000 && (p.earliestRefreshAt === undefined || p.earliestRefreshAt <= now)) {
        // Reserve space for a bounded rotation receipt before spending a token.
        if (Buffer.byteLength(JSON.stringify(store)) + 1_048_576 > 4_194_304) throw new Error("ChatGPT connection storage is full. Sign out of unused connections before refreshing.");
        // Once rotation starts it must persist even if this inference caller aborts.
        const next = await refreshSiwcProfile(p, transport, undefined, async value => { p!.pendingRotation = value; write(store, homeDir); });
        p = { ...next, epoch: p.epoch }; store.profiles = store.profiles.map(row => row.id === p!.id ? p! : row); write(store, homeDir);
      }
      if (p.expiresAt <= now || !p.accessToken || !p.scopes.includes("chatgpt.tokens.use.direct") || !p.scopes.includes("resource.invoke")) throw new Error("ChatGPT plan usage is not enabled for this connection. Sign in and grant plan usage, or use an API key.");
      return { accessToken: p.accessToken, scopes: [...p.scopes] };
    });
    signal?.throwIfAborted(); return result;
  } };
}
export async function signOutChatGptPlan(profileId: string, homeDir?: string, transport: SiwcTransport = {}): Promise<{ revoked: boolean }> {
  return locked(homeDir, async store => {
    const p = store.profiles.find(row => row.id === profileId); if (!p) throw new Error("ChatGPT connection not found.");
    const pending = p.pendingRotation && typeof p.pendingRotation === "object" ? p.pendingRotation as Record<string, unknown> : undefined;
    let refreshToken = p.refreshToken, unknownRotation = false;
    if (pending?.refresh_token !== undefined) { try { refreshToken = credential(pending.refresh_token); } catch { unknownRotation = true; } }
    let revoked = !refreshToken && !unknownRotation;
    if (refreshToken) {
      try { const metadata = await siwcMetadata(transport); const response = await (transport.fetch ?? fetch)(metadata.revoke, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: p.clientId }).toString() }); revoked = response.ok && !unknownRotation; } catch { /* Local sign-out still clears credentials. */ }
    }
    const { accessToken: _access, refreshToken: _refresh, pendingRotation: _pending, ...metadata } = p;
    store.profiles = store.profiles.map(row => row.id === p.id ? { ...metadata, epoch: (p.epoch ?? 0) + 1, idToken: "", scopes: [], expiresAt: 0, status: "signed-out" } : row); write(store, homeDir);
    return { revoked };
  });
}
