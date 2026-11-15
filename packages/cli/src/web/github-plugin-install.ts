import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PLUGIN_DIR_MODE, PLUGIN_ENTRY_FILE, PLUGIN_FILE_MODE, PLUGIN_MANIFEST_FILE, TOOL_DEFINITIONS, aggregateCapabilities, ensurePluginsRoot, getBuiltinPlugin, isSafePluginId, pluginsRootDir, validatePluginManifest } from "@0/engine";

/**
 * Install a plugin straight from a GitHub repo as a reviewed, pinned snapshot.
 * Review step: shallow-fetch, resolve and pin the commit SHA, read ONLY the two
 * plugin files out of the git object database (no checkout, no hooks, no
 * submodules, no LFS, nothing executed), validate the manifest and return the
 * declared permissions. Approve step: install only if the caller echoes the
 * reviewed SHA and permission hash. Installing never enables; no auto-update.
 */
export interface FetchedPlugin { sha: string; manifest: Buffer; entry: Buffer }
export type PluginFetcher = (repo: string, ref: string | undefined) => Promise<FetchedPlugin>;

interface Review {
  reviewId: string; repo: string; ref: string | null; sha: string; id: string; name: string; version: string;
  capabilities: string[];
  tools: Array<{ name: string; description: string; capabilities: string[] }>;
  /** sha256 per tool name over its full definition; see toolHash. */
  toolHashes: Record<string, string>;
  toolChanges: ToolChanges | null;
  permissionHash: string; entrySha256: string; entryBytes: number; alreadyInstalled: boolean; expiresAt: string;
}
interface Staged { review: Review; manifest: Buffer; entry: Buffer; expires: number }

class InstallError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@+-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_FILE = 1_048_576;
const TTL_MS = 15 * 60_000;
const run = promisify(execFile);

async function git(args: string[], cwd: string, maxBuffer = 4_096): Promise<Buffer> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...args], {
    cwd, encoding: "buffer", timeout: 60_000, maxBuffer,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout;
}

/** Default fetcher: shallow fetch over HTTPS (private repos use the user's `gh` credential helper). */
const gitPluginFetcher: PluginFetcher = async (repo, ref) => {
  const work = mkdtempSync(join(tmpdir(), "zero-gh-plugin-"));
  try {
    await git(["init", "-q"], work);
    await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "-q", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", `https://github.com/${repo}.git`, ref ?? "HEAD"], work);
    const sha = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], work)).toString("utf8").trim();
    if (!SHA.test(sha)) throw new Error("Could not resolve a commit.");
    const read = async (file: string): Promise<Buffer> => {
      const entry = (await git(["ls-tree", sha, "--", file], work)).toString("utf8").trim();
      // 100644/100755 regular blobs only: symlinks (120000) and submodules (160000) are refused.
      if (!/^100(644|755) blob [0-9a-f]{40}\t/.test(entry)) throw new InstallError(409, "unsafe_repository", `${file} must be a regular file at the repository root.`);
      return git(["cat-file", "blob", `${sha}:${file}`], work, MAX_FILE + 1);
    };
    return { sha, manifest: await read(PLUGIN_MANIFEST_FILE), entry: await read(PLUGIN_ENTRY_FILE) };
  } finally { rmSync(work, { recursive: true, force: true }); }
};

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted at every depth, so equal values always serialise to the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export interface HashableTool { name: string; description: string; parameters?: unknown; required?: string[]; capabilities: string[] }

/**
 * Hash of everything that defines one tool for the model and the sandbox: name, description,
 * parameters, required list and capabilities (sorted). The manifest declares no separate output
 * or prompt fields; if it ever does, add them here and bump the version prefix.
 */
export function toolHash(tool: HashableTool): string {
  const canonical = canonicalJson({
    name: tool.name, description: tool.description, parameters: tool.parameters ?? {},
    required: [...(tool.required ?? [])].sort(), capabilities: [...tool.capabilities].sort(),
  });
  return sha256(Buffer.concat([Buffer.from("0:plugin-tool:v1\0", "utf8"), Buffer.from(canonical, "utf8")]));
}

export interface ToolChanges { legacy: boolean; added: string[]; removed: string[]; changed: string[] }

/**
 * Compare reviewed tool hashes with the ones recorded at the last install. `previous` is null for
 * installs that predate per-tool hashes: then every tool counts as unreviewed (safe default).
 */
export function compareToolHashes(previous: Record<string, string> | null, next: Record<string, string>): ToolChanges {
  const names = Object.keys(next).sort();
  if (!previous) return { legacy: true, added: [], removed: [], changed: names };
  const old = Object.keys(previous).sort();
  return {
    legacy: false,
    added: names.filter(name => !Object.hasOwn(previous, name)),
    removed: old.filter(name => !Object.hasOwn(next, name)),
    changed: names.filter(name => Object.hasOwn(previous, name) && previous[name] !== next[name]),
  };
}

function readRecordedToolHashes(dir: string): Record<string, string> | null {
  try {
    const hashes = (JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as { toolHashes?: unknown }).toolHashes;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return null;
    const entries = Object.entries(hashes as Record<string, unknown>);
    return entries.every(([, value]) => typeof value === "string") ? Object.fromEntries(entries) as Record<string, string> : null;
  } catch { return null; }
}

function describeChanges(changes: ToolChanges): string {
  if (changes.legacy) return "The earlier install did not record tool hashes, so all tools count as unreviewed: " + (changes.changed.join(", ") || "none") + ".";
  const lists: Array<[string, string[]]> = [["Changed", changes.changed], ["Added", changes.added], ["Removed", changes.removed]];
  const parts = lists.filter(([, list]) => list.length).map(([label, list]) => `${label} tools: ${list.join(", ")}.`);
  return parts.length ? parts.join(" ") : "No tool changed.";
}

export class GithubPluginInstaller {
  readonly #staged = new Map<string, Staged>();
  readonly #fetcher: PluginFetcher;
  readonly #homeDir: string | undefined;
  readonly #now: () => number;
  constructor(options: { homeDir?: string; fetcher?: PluginFetcher; now?: () => number } = {}) {
    this.#fetcher = options.fetcher ?? gitPluginFetcher; this.#homeDir = options.homeDir; this.#now = options.now ?? Date.now;
  }

  async review(input: unknown): Promise<{ review: Review }> {
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (typeof body.repo !== "string" || !REPO.test(body.repo)) throw new InstallError(400, "invalid_repo", "Use the form owner/name.");
    if (body.ref !== undefined && (typeof body.ref !== "string" || !REF.test(body.ref) || body.ref.endsWith(".lock"))) throw new InstallError(400, "invalid_ref", "Invalid branch, tag or commit.");
    const repo = body.repo; const ref = body.ref as string | undefined;
    let fetched: FetchedPlugin;
    try { fetched = await this.#fetcher(repo, ref); }
    catch (error) {
      if (error instanceof InstallError) throw error;
      throw new InstallError(409, "fetch_failed", "Could not fetch the repository. Check the name, ref and your GitHub access.");
    }
    if (!SHA.test(fetched.sha) || fetched.manifest.length > MAX_FILE || fetched.entry.length > MAX_FILE) throw new InstallError(409, "fetch_failed", "The repository returned invalid plugin files.");
    let raw: unknown;
    try { raw = JSON.parse(fetched.manifest.toString("utf8")); } catch { throw new InstallError(409, "invalid_manifest", "plugin.json is not valid JSON."); }
    const validation = validatePluginManifest(raw, { reservedToolNames: Object.values(TOOL_DEFINITIONS).map(tool => tool.name) });
    if (!validation.ok) throw new InstallError(409, "invalid_manifest", validation.errors.slice(0, 8).join("; ").slice(0, 1000));
    const manifest = validation.manifest;
    if (!isSafePluginId(manifest.id) || getBuiltinPlugin(manifest.id)) throw new InstallError(409, "invalid_manifest", "The plugin id is not allowed.");
    const capabilities = aggregateCapabilities(manifest) as string[];
    const tools = manifest.tools.map(tool => ({ name: tool.name, description: tool.description, capabilities: [...tool.capabilities].sort() }));
    const names = manifest.tools.map(tool => tool.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) throw new InstallError(409, "invalid_manifest", `The tool name "${duplicate}" is used more than once in plugin.json.`);
    const toolHashes: Record<string, string> = Object.fromEntries(manifest.tools.map(tool => [tool.name, toolHash(tool)]));
    const entrySha256 = sha256(fetched.entry);
    const permissionHash = sha256(JSON.stringify({ id: manifest.id, version: manifest.version, sha: fetched.sha, capabilities, tools: tools.map(tool => [tool.name, tool.capabilities]), entrySha256 }));
    const now = this.#now();
    for (const [id, staged] of this.#staged) if (staged.expires <= now) this.#staged.delete(id);
    if (this.#staged.size >= 16) this.#staged.delete(this.#staged.keys().next().value!);

    const targetPath = join(pluginsRootDir(this.#homeDir), manifest.id);
    const alreadyInstalled = existsSync(targetPath);
    const toolChanges = alreadyInstalled ? compareToolHashes(readRecordedToolHashes(targetPath), toolHashes) : null;
    const review: Review = {
      reviewId: randomUUID(), repo, ref: ref ?? null, sha: fetched.sha, id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version,
      capabilities, tools, toolHashes, toolChanges, permissionHash, entrySha256, entryBytes: fetched.entry.length,
      alreadyInstalled: existsSync(join(pluginsRootDir(this.#homeDir), manifest.id)), expiresAt: new Date(now + TTL_MS).toISOString(),
    };
    this.#staged.set(review.reviewId, { review, manifest: fetched.manifest, entry: fetched.entry, expires: now + TTL_MS });
    return { review };
  }

  approve(input: unknown): { ok: true; id: string; version: string; sha: string; state: "installed"; message: string; changedTools?: string[]; addedTools?: string[]; removedTools?: string[] } {
    const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const staged = typeof body.reviewId === "string" ? this.#staged.get(body.reviewId) : undefined;
    if (!staged) throw new InstallError(409, "review_expired", "Review this plugin again before installing.");
    if (staged.expires <= this.#now()) { this.#staged.delete(staged.review.reviewId); throw new InstallError(409, "review_expired", "The review expired; review the plugin again."); }
    const { review } = staged;
    if (body.approved !== true || body.sha !== review.sha || body.permissionHash !== review.permissionHash) throw new InstallError(409, "review_mismatch", "Approve the exact commit and permissions that were reviewed.");
    // Defence in depth: the bytes about to be written must still hash to what was reviewed.
    if (sha256(staged.entry) !== review.entrySha256) throw new InstallError(409, "review_mismatch", "Staged plugin changed after review.");
    const root = pluginsRootDir(this.#homeDir);
    if (!ensurePluginsRoot(root)) throw new InstallError(500, "install_failed", "Could not create the plugins directory.");
    const target = join(root, review.id);
    const exists = existsSync(target);
    if (exists && body.replaceExisting !== true) throw new InstallError(409, "already_installed", "This plugin is already installed. Review again with replaceExisting to update it.");

    // Why the update needs a second look. The package-level permission hash (commit, entry file and
    // capabilities) is what gates this install; this only explains what changed. A source.json without
    // toolHashes predates per-tool hashes, so every tool counts as unreviewed.
    const changes: ToolChanges | null = exists ? compareToolHashes(readRecordedToolHashes(target), review.toolHashes) : null;

    const temporary = join(root, `.install-${randomUUID()}`);
    try {
      mkdirSync(temporary, { mode: PLUGIN_DIR_MODE }); chmodSync(temporary, PLUGIN_DIR_MODE);
      const sourceJson = {
        source: "github", repo: review.repo, ref: review.ref, sha: review.sha,
        permissionHash: review.permissionHash,
        entrySha256: review.entrySha256,
        toolHashes: review.toolHashes,
        installedAt: new Date(this.#now()).toISOString(),
      };
      for (const [name, bytes] of [[PLUGIN_MANIFEST_FILE, staged.manifest], [PLUGIN_ENTRY_FILE, staged.entry], ["source.json", Buffer.from(JSON.stringify(sourceJson, null, 2) + "\n")]] as const) {
        const file = join(temporary, name); writeFileSync(file, bytes, { mode: PLUGIN_FILE_MODE }); chmodSync(file, PLUGIN_FILE_MODE);
      }
      if (exists) rmSync(target, { recursive: true, force: true });
      renameSync(temporary, target);
    } catch { throw new InstallError(500, "install_failed", "Could not write the plugin files."); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
    this.#staged.delete(review.reviewId);

    return {
      ok: true, id: review.id, version: review.version, sha: review.sha, state: "installed",
      ...(changes ? { changedTools: changes.changed, addedTools: changes.added, removedTools: changes.removed } : {}),
      message: changes
        ? `Updated ${review.id}. ${describeChanges(changes)} NOT enabled: enable it separately.`
        : `Installed ${review.id} at ${review.sha.slice(0, 12)}. NOT enabled: enable it separately and review its capabilities.`,
    };
  }

  async handle(path: string, method: string, input: unknown): Promise<{ status: number; data: unknown } | null> {
    if (path !== "plugins/install-github" && path !== "plugins/install-github/approve") return null;
    try {
      if (method !== "POST") throw new InstallError(405, "method_not_allowed", "Use POST.");
      return { status: 200, data: path.endsWith("/approve") ? this.approve(input) : await this.review(input) };
    } catch (error) {
      if (error instanceof InstallError) return { status: error.status, data: { code: error.code, error: error.message } };
      return { status: 500, data: { code: "install_failed", error: "Plugin install failed." } };
    }
  }
}

/** Provenance written by the GitHub flow; null for registry/local plugins. */
export function readPluginSource(dir: string): { repo: string; ref: string | null; sha: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as Record<string, unknown>;
    return value.source === "github" && typeof value.repo === "string" && typeof value.sha === "string" ? { repo: value.repo, ref: typeof value.ref === "string" ? value.ref : null, sha: value.sha } : null;
  } catch { return null; }
}
