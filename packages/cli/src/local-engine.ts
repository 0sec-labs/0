import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveOsecDbPath } from "@0/db";
import { homeStateDir } from "@0/shared";
import { z } from "zod";
import { BackendConnectionRegistry } from "./web/backend-connections.js";
import { createRemoteWorkflowRuntime } from "./remote-workflow-runtime.js";

const MAX_DESCRIPTOR = 16 * 1024;
const schema = z.object({
  schemaVersion: z.literal(1), nonce: z.string().uuid(),
  url: z.string().min(1).max(4096), token: z.string().min(32).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/),
  engineId: z.string().min(1).max(128), serverInstanceId: z.string().min(1).max(128),
  pid: z.number().int().positive(), workspace: z.string().min(1).max(4096),
}).strict();
type Descriptor = z.infer<typeof schema>;
export type LocalEngineRegistration = Omit<Descriptor, "schemaVersion" | "nonce">;
export interface LocalEngineDiscoveryOptions {
  dbPath?: string; workspace: string; homeDir?: string;
  model?: string; scopePath?: string; allowApply?: boolean;
}
export function localEngineDescriptorPath(dbPath?: string, homeDir?: string): string {
  const db = resolveOsecDbPath(dbPath);
  const key = createHash("sha256").update(db === ":memory:" ? db : resolve(db)).digest("hex");
  return join(homeStateDir(homeDir), "engines", `${key}.json`);
}
function secureMetadata(path: string, create: boolean): boolean {
  const directory = dirname(path);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Local engine discovery directory must be owned by this user with private permissions (0700).");
  return true;
}
function loopbackUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !(url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Local engine discovery requires a credential-free loopback URL.");
  return url.href;
}
function readDescriptor(path: string): Descriptor | null {
  if (!secureMetadata(path, false)) return null;
  let fd: number;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Discovery metadata must be a regular file, never a symlink.");
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Cannot safely read local engine discovery metadata.", { cause: error }); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Local engine descriptor must be a private regular file owned by this user, at most 16 KiB.");
    const buffer = Buffer.alloc(MAX_DESCRIPTOR + 1);
    let length = 0;
    while (length < buffer.length) { const bytes = readSync(fd, buffer, length, buffer.length - length, length); if (!bytes) break; length += bytes; }
    if (length > MAX_DESCRIPTOR) throw new Error("Local engine descriptor exceeds 16 KiB.");
    const descriptor = schema.parse(JSON.parse(buffer.subarray(0, length).toString("utf8")));
    loopbackUrl(descriptor.url);
    if (!isAbsolute(descriptor.workspace) || /[\x00-\x1f]/.test(descriptor.workspace)) throw new Error("Local engine descriptor workspace must be an absolute path.");
    return descriptor;
  } finally { closeSync(fd); }
}
function deadPid(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function removeMatching(path: string, nonce: string): void {
  if (readDescriptor(path)?.nonce === nonce) unlinkSync(path);
}
/** Must run before database recovery: a second host cannot interrupt another live engine's history. */
export function assertLocalEngineAvailable(dbPath?: string, homeDir?: string): void {
  if (resolveOsecDbPath(dbPath) === ":memory:") return;
  const path = localEngineDescriptorPath(dbPath, homeDir);
  const descriptor = readDescriptor(path);
  if (!descriptor) return;
  if (!deadPid(descriptor.pid)) throw new Error("A running local engine already owns this database. Attach to it or shut it down before starting another engine.");
  removeMatching(path, descriptor.nonce);
}
/** Registers the secret only in private local metadata; cleanup cannot remove a replacement host. */
export function registerLocalEngine(input: LocalEngineRegistration, dbPath?: string, options: { homeDir?: string } = {}): () => void {
  if (resolveOsecDbPath(dbPath) === ":memory:") return () => {};
  const path = localEngineDescriptorPath(dbPath, options.homeDir);
  secureMetadata(path, true);
  const descriptor = schema.parse({ ...input, url: loopbackUrl(input.url), workspace: realpathSync(input.workspace), schemaVersion: 1, nonce: randomUUID() });
  const previous = readDescriptor(path);
  if (previous) {
    if (!deadPid(previous.pid)) throw new Error("A local engine already owns this database. Attach to it or shut it down before starting another engine.");
    removeMatching(path, previous.nonce);
  }
  writeFileSync(path, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
  return () => removeMatching(path, descriptor.nonce);
}
/** Presence of a live descriptor is an authority boundary, never a reason to silently create a new host. */
export async function connectLocalEngine(options: LocalEngineDiscoveryOptions) {
  if (resolveOsecDbPath(options.dbPath) === ":memory:") return null;
  const path = localEngineDescriptorPath(options.dbPath, options.homeDir);
  const descriptor = readDescriptor(path);
  if (!descriptor) return null;
  if (deadPid(descriptor.pid)) { removeMatching(path, descriptor.nonce); return null; }
  if (realpathSync(options.workspace) !== descriptor.workspace) throw new Error("The running local engine owns this database in another workspace. Select its workspace or a separate engine database.");
  if (options.model !== undefined || options.scopePath !== undefined || options.allowApply === true) throw new Error("The running local engine owns model, scope and application permissions. Attach using its configuration instead of overriding it.");
  const backendId = "discovered-local-engine";
  const registry = new BackendConnectionRegistry({
    connections: [{ id: backendId, name: "Running local engine", url: descriptor.url, bearerTokenEnv: "LOCAL_ENGINE_DISCOVERY_TOKEN", expectedEngineId: descriptor.engineId }],
    env: { LOCAL_ENGINE_DISCOVERY_TOKEN: descriptor.token }, timeoutMs: 3000,
    localHandshake: { protocolVersion: 1, engineId: descriptor.engineId, serverInstanceId: descriptor.serverInstanceId, capabilities: [], platform: { os: process.platform, pathStyle: process.platform === "win32" ? "windows" : "posix" } },
  });
  try {
    const runtime = await createRemoteWorkflowRuntime({ backendId }, {
      handshake: async id => {
        const connection = await registry.handshake(id);
        if (connection.handshake?.serverInstanceId !== descriptor.serverInstanceId) throw new Error("The discovered local engine instance changed. Refresh its registration before attaching.");
        return connection;
      },
      request: (id, path, request) => registry.request(id, path, request),
    });
    return { ...runtime, dispose: async () => { await runtime.dispose(); registry.dispose(); } };
  } catch (error) {
    registry.dispose();
    throw new Error("The registered local engine could not be reached or authenticated. Restart that engine; no replacement host was started.", { cause: error });
  }
}
