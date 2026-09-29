// `0 plugin` manages registry/local installation, project approval, and tool calls.
// Install writes files; enable records approval. Neither executes plugin code.
// `run` loads an enabled plugin before choosing and authorizing a tool call.
// Loading starts a child process under the operator's account, not an OS sandbox.
// Registry signatures remain unverified; inspect code before enabling it.
//
// CorePort isolates CLI I/O for command tests. Its structural types must match
// the runtime exports, including the name-keyed built-in tool registry.

import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";
import { VERSION } from "@0/shared";
import { readLocalExtension } from "./hackstore.js";

// ── Local structural views of the core shapes this command reads ──────────────
// Declared locally (not imported from the barrel) so the command type-checks
// without depending on barrel exports that land in a separate change.

import type { PluginCapability, ValidationResult } from "@0/core";

export interface ManifestView {
  id: string;
  name: string;
  version: string;
  minCoreVersion?: string;
  tools: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    required?: string[];
    capabilities: PluginCapability[];
  }[];
}

interface EnabledPluginRecordView {
  version: string;
  capabilities: PluginCapability[];
  enabledAt: number;
}
export interface EnablementRecordView {
  schema: number;
  project: string;
  enabled: Record<string, EnabledPluginRecordView>;
}
type EnableResultView =
  | { ok: true; record: EnablementRecordView }
  | { ok: false; error: string };

export interface InstalledPluginView {
  id: string;
  version: string;
  capabilities: readonly PluginCapability[];
}

export interface BuiltinPluginView extends InstalledPluginView {
  name: string;
  description: string;
}
export interface ReconciledPluginView {
  pluginId: string;
  status: "enabled" | "stale-capabilities" | "missing";
  approvedCapabilities: PluginCapability[];
  approvedVersion: string;
  currentCapabilities: readonly PluginCapability[] | null;
  currentVersion: string | null;
  reason?: string;
}

interface DiscoveryResultView {
  ok: boolean;
  plugin?: { id: string; manifest: ManifestView };
  errors?: string[];
}

export interface InstallableEntryView {
  id: string;
  version: string;
  manifest: ManifestView;
  capabilities: PluginCapability[];
  files: Record<string, string>;
  signature?: string;
  signatureState: "verified" | "unverified";
}
interface RegistryResultView {
  entries: InstallableEntryView[];
  dropped: { id?: string; reason: string }[];
}
type FetchRegistryResultView =
  | { ok: true; result: RegistryResultView }
  | { ok: false; error: string };

interface SignatureVerifierView {
  readonly keyConfigured: boolean;
  verify(canonicalPayload: string, signature: string): boolean;
}

// ── Host views (used only by `run`, the one command that spawns a plugin) ──────
// `run` is the sole place this surface crosses from "installed/enabled state" to
// "a child process actually executes". It goes through the SAME `PluginHost` the
// console uses, so the single capability→gate translation and the subprocess
// boundary are not re-implemented here.

export interface PluginHostOptionsView {
  pluginsDir?: string;
  homeDir?: string;
  enabled?: readonly string[];
  reservedToolNames?: readonly string[];
  coreVersion?: string;
  callTimeoutMs?: number;
}

interface RegisteredPluginToolView {
  pluginId: string;
  name: string;
  capabilities: PluginCapability[];
  networkCapable: boolean;
  localScope: boolean;
  readOnly: boolean;
}

type PluginCallResultView =
  | {
      ok: true;
      content: string;
      failed: boolean;
      truncated: boolean;
      neutralized: boolean;
      markers: string[];
    }
  | { ok: false; error: string };

export interface PluginHostView {
  load(
    pluginId: string,
  ): Promise<{ ok: boolean; pluginId: string; tools?: string[]; errors?: string[] }>;
  call(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<PluginCallResultView>;
  registeredTools(): RegisteredPluginToolView[];
  ownsTool(name: string): boolean;
  shutdown(): void;
}

/**
 * Everything this command needs from `@0/core`. Injected so tests supply
 * fakes; the default {@link defaultCorePort} lazily imports the real barrel.
 */
export interface CorePort {
  readonly BUILTIN_PLUGINS: readonly BuiltinPluginView[];
  getBuiltinPlugin(id: string): BuiltinPluginView | undefined;
  validatePluginManifest(raw: unknown, opts?: { reservedToolNames?: readonly string[] }): ValidationResult;
  // enablement.ts
  readEnablement(projectPath: string, homeDir?: string): EnablementRecordView;
  writeEnablement(projectPath: string, record: EnablementRecordView, homeDir?: string): boolean;
  emptyEnablement(project?: string): EnablementRecordView;
  enable(
    record: EnablementRecordView,
    pluginId: string,
    opts: { version: string; capabilities: readonly PluginCapability[]; now: number },
  ): EnableResultView;
  disable(record: EnablementRecordView, pluginId: string): EnablementRecordView;
  isEnabled(record: EnablementRecordView, pluginId: string): boolean;
  reconcile(
    record: EnablementRecordView,
    installed: readonly InstalledPluginView[],
  ): ReconciledPluginView[];
  loadableIds(reconciled: readonly ReconciledPluginView[]): string[];
  aggregateCapabilities(manifest: ManifestView): PluginCapability[];
  // registry-client.ts
  fetchRegistryIndex(
    url: string,
    opts: { fetchImpl: typeof fetch; verifier?: SignatureVerifierView; reservedToolNames?: readonly string[] },
  ): Promise<FetchRegistryResultView>;
  searchInstallable(entries: readonly InstallableEntryView[], query: string): InstallableEntryView[];
  findInstallable(entries: readonly InstallableEntryView[], id: string): InstallableEntryView | undefined;
  unconfiguredVerifier: SignatureVerifierView;
  readonly DEFAULT_REGISTRY_URL: string;
  // loader.ts (discovery helpers only — this command never spawns)
  pluginsRootDir(homeDir?: string): string;
  ensurePluginsRoot(dir: string): boolean;
  isSafePluginId(value: unknown): boolean;
  listInstalledPluginIds(root: string): string[];
  readInstalledPlugin(root: string, pluginId: string): DiscoveryResultView;
  readonly PLUGIN_MANIFEST_FILE: string;
  readonly PLUGIN_ENTRY_FILE: string;
  readonly PLUGIN_DIR_MODE: number;
  readonly PLUGIN_FILE_MODE: number;
  // loader.ts (the host — used ONLY by `run`, the one command that spawns)
  PluginHost: new (opts: PluginHostOptionsView) => PluginHostView;
  /** Built-in tool definitions; their names are the reserved set a plugin may
   *  not shadow. Passed to the host so there is one authorization namespace. */
  readonly TOOL_DEFINITIONS: Readonly<Record<string, { name: string }>>;
}

/** Resolve core only when a command executes, so help does not initialize native DB/providers. */
let cachedCore: CorePort | undefined;
async function defaultCorePort(): Promise<CorePort> {
  if (cachedCore) return cachedCore;
  // A static import would initialize the full core barrel while merely registering commands.
  const mod = (await import("@0/core")) as unknown as CorePort;
  cachedCore = mod;
  return mod;
}

// ── Deps + exit codes ─────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_USER_ERROR = 1;

export interface PluginCommandDeps {
  core: CorePort;
  /** Injected fetch; NEVER the real one in tests. */
  fetchImpl?: typeof fetch;
  /** Verification hook; defaults to the core's no-key verifier. */
  verifier?: SignatureVerifierView;
  homeDir?: string;
  /** Project the per-project enablement store is keyed on. Defaults to cwd. */
  projectPath?: string;
  /** Registry URL. Defaults to the community Hackstore (an explicit empty URL disables it). */
  registryUrl?: string;
  /** Install the directory/manifest argument offline instead of fetching a registry id. */
  local?: boolean;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // ── `run`-only ──────────────────────────────────────────────────────────────
  /** Explicit operator authorization required before an EFFECTFUL plugin tool
   *  (anything not pure read-only) is invoked. Without it, `run` refuses rather
   *  than silently granting the tool its declared side effects. */
  yes?: boolean;
  /** JSON object of tool arguments (merged under any `key=value` pairs). */
  jsonArgs?: string;
  /** @0/core version, for the host's `minCoreVersion` enforcement. */
  coreVersion?: string;
  /** Per-call timeout override (ms). */
  callTimeoutMs?: number;
}

interface ResolvedDeps {
  core: CorePort;
  fetchImpl: typeof fetch;
  verifier: SignatureVerifierView;
  homeDir: string | undefined;
  projectPath: string;
  registryUrl: string;
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

function resolve(deps: PluginCommandDeps): ResolvedDeps {
  return {
    core: deps.core,
    fetchImpl: deps.fetchImpl ?? fetch,
    verifier: deps.verifier ?? deps.core.unconfiguredVerifier,
    homeDir: deps.homeDir,
    projectPath: deps.projectPath ?? process.cwd(),
    registryUrl: (deps.registryUrl ?? process.env["ZERO_REGISTRY_URL"] ?? deps.core.DEFAULT_REGISTRY_URL).trim(),
    now: deps.now ?? Date.now,
    out: deps.out ?? ((l) => console.log(l)),
    err: deps.err ?? ((l) => console.error(l)),
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function capSummary(caps: readonly PluginCapability[]): string {
  return caps.length > 0 ? caps.join(", ") : "none declared";
}

function installedViews(d: ResolvedDeps): InstalledPluginView[] {
  const root = d.core.pluginsRootDir(d.homeDir);
  const out: InstalledPluginView[] = [...d.core.BUILTIN_PLUGINS];
  for (const id of d.core.listInstalledPluginIds(root)) {
    if (d.core.getBuiltinPlugin(id)) continue;
    const discovered = d.core.readInstalledPlugin(root, id);
    if (discovered.ok && discovered.plugin) {
      out.push({
        id,
        version: discovered.plugin.manifest.version,
        capabilities: d.core.aggregateCapabilities(discovered.plugin.manifest),
      });
    }
  }
  return out;
}

// ── list ───────────────────────────────────────────────────────────────────────

export function runList(deps: PluginCommandDeps): void {
  const d = resolve(deps);
  const installed = installedViews(d);
  const record = d.core.readEnablement(d.projectPath, d.homeDir);
  const reconciled = d.core.reconcile(record, installed);
  const byId = new Map(reconciled.map((r) => [r.pluginId, r]));

  if (installed.length === 0 && reconciled.length === 0) {
    d.out("No plugins installed.");
    d.out(`  Plugins live under ${d.core.pluginsRootDir(d.homeDir)}`);
    process.exitCode = EXIT_OK;
    return;
  }

  d.out(chalk.bold(`Plugins (enablement is per-project: ${d.projectPath})`));
  const seen = new Set<string>();
  for (const p of installed) {
    seen.add(p.id);
    const r = byId.get(p.id);
    const state = !r
      ? chalk.dim(d.core.getBuiltinPlugin(p.id) ? "built-in (disabled)" : "installed (not enabled)")
      : r.status === "enabled"
        ? chalk.green("enabled")
        : chalk.yellow(`${r.status} — needs re-approval`);
    const details = d.core.getBuiltinPlugin(p.id) ? "built-in host authorization (no child process)" : `caps: ${capSummary(p.capabilities)}`;
    d.out(`  ${p.id}@${p.version}  [${state}]  ${details}`);
    if (r && r.status !== "enabled" && r.reason) d.out(chalk.yellow(`      ${r.reason}`));
  }
  // Enabled ids whose files are gone (missing) won't appear in `installed`.
  for (const r of reconciled) {
    if (seen.has(r.pluginId)) continue;
    d.out(
      `  ${r.pluginId}@${r.approvedVersion}  [${chalk.yellow("missing — needs re-approval")}]  ` +
        `approved caps: ${capSummary(r.approvedCapabilities)}`,
    );
    if (r.reason) d.out(chalk.yellow(`      ${r.reason}`));
  }
  process.exitCode = EXIT_OK;
}

// ── search / browse ─────────────────────────────────────────────────────────────

export async function runSearch(query: string, deps: PluginCommandDeps): Promise<void> {
  const d = resolve(deps);
  if (d.registryUrl.trim().length === 0) {
    d.out("The Hackstore is disabled (registry URL is empty), so there is nothing to search.");
    d.out("  The default community Hackstore lives at github.com/0sec-labs/hackstore.");
    d.out("  Unset ZERO_REGISTRY_URL to use it, or point --registry at an index URL you trust.");
    process.exitCode = EXIT_OK;
    return;
  }

  const fetched = await d.core.fetchRegistryIndex(d.registryUrl, {
    fetchImpl: d.fetchImpl,
    verifier: d.verifier,
  });
  if (!fetched.ok) {
    d.err(chalk.red(`Registry error: ${fetched.error}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const matches = d.core.searchInstallable(fetched.result.entries, query ?? "");
  if (matches.length === 0) {
    d.out(query ? `No plugins match ${JSON.stringify(query)}.` : "The registry lists no plugins.");
  } else {
    d.out(chalk.bold(`Registry: ${d.registryUrl}`));
    for (const e of matches) {
      d.out(
        `  ${e.id}@${e.version}  (${e.manifest.name})  caps: ${capSummary(e.capabilities)}  ` +
          `[signature: ${e.signatureState}]`,
      );
    }
  }
  if (fetched.result.dropped.length > 0) {
    d.out(chalk.dim(`  ${fetched.result.dropped.length} entr(y/ies) dropped as not installable:`));
    for (const drop of fetched.result.dropped) {
      d.out(chalk.dim(`    - ${drop.id ?? "?"}: ${drop.reason}`));
    }
  }
  process.exitCode = EXIT_OK;
}

// ── install ──────────────────────────────────────────────────────────────────────

export async function runInstall(id: string, deps: PluginCommandDeps): Promise<void> {
  const d = resolve(deps);
  if (deps.local === true) {
    const local = readLocalExtension(id, {
      validatePluginManifest: d.core.validatePluginManifest,
      reservedToolNames: Object.values(d.core.TOOL_DEFINITIONS).map((tool) => tool.name),
    });
    if (!local.ok) {
      for (const error of local.errors) d.err(chalk.red(`Local installation refused: ${error}`));
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    if (d.core.getBuiltinPlugin(local.manifest.id)) {
      d.err(chalk.red(`"${local.manifest.id}" is a reserved built-in plugin id; local code cannot replace it.`));
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    const entry: InstallableEntryView = {
      id: local.manifest.id, version: local.manifest.version, manifest: local.manifest,
      capabilities: d.core.aggregateCapabilities(local.manifest),
      files: { [d.core.PLUGIN_ENTRY_FILE]: local.source },
      signatureState: "unverified",
    };
    installEntry(d, entry, `local source: ${local.dir}`);
    return;
  }
  if (!d.core.isSafePluginId(id)) {
    d.err(chalk.red(`"${id}" is not a valid plugin id; refused before any filesystem access.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (d.core.getBuiltinPlugin(id)) {
    d.err(chalk.red(`"${id}" is built in and cannot be replaced by registry code. Use 0 plugin enable ${id}.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (d.registryUrl.trim().length === 0) {
    d.err(chalk.red("The Hackstore is disabled (registry URL is empty), so nothing can be installed."));
    d.err("  Unset ZERO_REGISTRY_URL for the default community Hackstore, or point --registry at an index URL you trust.");
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const fetched = await d.core.fetchRegistryIndex(d.registryUrl, {
    fetchImpl: d.fetchImpl,
    verifier: d.verifier,
    reservedToolNames: Object.values(d.core.TOOL_DEFINITIONS).map((tool) => tool.name),
  });
  if (!fetched.ok) {
    d.err(chalk.red(`Registry error: ${fetched.error}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const entry = d.core.findInstallable(fetched.result.entries, id);
  if (!entry) {
    d.err(chalk.red(`Plugin "${id}" is not available in the configured registry.`));
    for (const dropped of fetched.result.dropped) {
      if (dropped.id === id) d.err(`  ${dropped.reason}`);
    }
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  installEntry(d, entry, d.registryUrl);
}

function installEntry(d: ResolvedDeps, entry: InstallableEntryView, source: string): void {
  const write = writePluginFiles(d, d.core.pluginsRootDir(d.homeDir), entry);
  if (!write.ok) {
    d.err(chalk.red(`Could not install "${entry.id}": ${write.error}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  d.out(chalk.green(`Installed ${entry.id}@${entry.version} (${entry.manifest.name}).`));
  d.out(`  Files written to: ${write.dir}`);
  d.out(`  Source: ${source}`);
  d.out(`  Signature: ${entry.signatureState}`);
  d.out(`  Capabilities it will request: ${capSummary(entry.capabilities)}`);
  d.out("");
  const approval = d.core.reconcile(d.core.readEnablement(d.projectPath, d.homeDir), installedViews(d))
    .find((item) => item.pluginId === entry.id);
  if (approval?.status === "enabled") {
    d.out(chalk.yellow("Existing project approval still applies to this update. No plugin code ran during installation."));
  } else if (approval) {
    d.out(chalk.yellow("Installed, but existing project approval needs renewal. No plugin code ran during installation."));
  } else {
    d.out(chalk.yellow("This plugin is INSTALLED, NOT ENABLED. No plugin code has run."));
  }
  d.out("  Inspect the installed code before loading it; approve or renew approval explicitly:");
  d.out(chalk.cyan(`    0 plugin info ${entry.id}`));
  d.out(chalk.cyan(`    0 plugin enable ${entry.id}`));
  process.exitCode = EXIT_OK;
}

/**
 * Write a plugin's files to disk. Copying bytes only — this never executes,
 * imports, or spawns anything. The directory is the validated plugin id (a safe
 * single path segment); the filenames are the loader's FIXED convention, never
 * taken from the untrusted index, so there is no path-traversal surface. The
 * manifest is written from the VALIDATED manifest so what lands on disk is what
 * the operator was shown.
 */
function writePluginFiles(
  d: ResolvedDeps,
  root: string,
  entry: InstallableEntryView,
): { ok: true; dir: string } | { ok: false; error: string } {
  const entryBody = entry.files[d.core.PLUGIN_ENTRY_FILE];
  if (typeof entryBody !== "string" || !entryBody.trim()) {
    return { ok: false, error: `entry is missing its non-empty ${d.core.PLUGIN_ENTRY_FILE}` };
  }
  if (!d.core.isSafePluginId(entry.id) || d.core.getBuiltinPlugin(entry.id)) {
    return { ok: false, error: "entry id is unsafe or reserved" };
  }
  const dir = join(root, entry.id);
  try {
    // Fixed filenames alone do not stop an existing symlink redirecting a write.
    for (const directory of [root, dir]) {
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`refusing non-directory or symbolic link: ${directory}`);
    }
    const files = [
      [join(dir, d.core.PLUGIN_MANIFEST_FILE), `${JSON.stringify(entry.manifest, null, 2)}\n`],
      [join(dir, d.core.PLUGIN_ENTRY_FILE), entryBody],
    ] as const;
    for (const [file] of files) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw new Error(`refusing non-regular file or symbolic link: ${file}`);
    }
    if (!d.core.ensurePluginsRoot(root)) throw new Error(`could not create the plugins root at ${root}`);
    mkdirSync(dir, { recursive: true, mode: d.core.PLUGIN_DIR_MODE });
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fchmodSync(dirFd, d.core.PLUGIN_DIR_MODE); } finally { closeSync(dirFd); }
    for (const [file, body] of files) {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, d.core.PLUGIN_FILE_MODE);
      try {
        fchmodSync(fd, d.core.PLUGIN_FILE_MODE);
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
    }
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── enable ──────────────────────────────────────────────────────────────────────

export function runEnable(id: string, deps: PluginCommandDeps): void {
  const d = resolve(deps);
  if (!d.core.isSafePluginId(id)) {
    d.err(chalk.red(`"${id}" is not a valid plugin id.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const builtin = d.core.getBuiltinPlugin(id);
  let manifest: Pick<ManifestView, "version">;
  let capabilities: readonly PluginCapability[];
  if (builtin) {
    manifest = builtin;
    capabilities = builtin.capabilities;
  } else {
    const discovered = d.core.readInstalledPlugin(d.core.pluginsRootDir(d.homeDir), id);
    if (!discovered.ok || !discovered.plugin) {
      d.err(chalk.red(`Plugin "${id}" is not installed. Install it first:`));
      d.err(chalk.cyan(`    0 plugin install ${id}`));
      if (discovered.errors) for (const e of discovered.errors) d.err(chalk.dim(`  ${e}`));
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    manifest = discovered.plugin.manifest;
    capabilities = d.core.aggregateCapabilities(discovered.plugin.manifest);
  }

  const record = d.core.readEnablement(d.projectPath, d.homeDir);
  const result = d.core.enable(record, id, {
    version: manifest.version,
    capabilities,
    now: d.now(),
  });
  if (!result.ok) {
    d.err(chalk.red(`Could not enable "${id}": ${result.error}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (!d.core.writeEnablement(d.projectPath, result.record, d.homeDir)) {
    d.err(chalk.red(`Could not persist enablement for "${id}".`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  // Print the capability grant explicitly — the operator approves capabilities.
  d.out(chalk.green(`Enabled ${id}@${manifest.version} for this project.`));
  d.out(`  Project: ${d.projectPath}`);
  if (builtin) {
    d.out(`  ${builtin.description}`);
    d.out("  Built-in host authorization is active. No external plugin code was loaded.");
  } else {
    d.out(chalk.bold(`  Capabilities granted: ${capSummary(capabilities)}`));
    d.out("  No plugin code has run. Loading executes this code under your account, not in an OS sandbox.");
    d.out("  Per-call authorization still applies; scope checks apply only when the scope plugin is enabled.");
  }
  process.exitCode = EXIT_OK;
}

// ── disable ─────────────────────────────────────────────────────────────────────

export function runDisable(id: string, deps: PluginCommandDeps): void {
  const d = resolve(deps);
  if (!d.core.isSafePluginId(id)) {
    d.err(chalk.red(`"${id}" is not a valid plugin id.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const record = d.core.readEnablement(d.projectPath, d.homeDir);
  if (!d.core.isEnabled(record, id)) {
    d.out(`Plugin "${id}" was not enabled for this project; nothing to change.`);
    process.exitCode = EXIT_OK;
    return;
  }
  const next = d.core.disable(record, id);
  if (!d.core.writeEnablement(d.projectPath, next, d.homeDir)) {
    d.err(chalk.red(`Could not persist enablement change for "${id}".`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  d.out(chalk.green(`Disabled ${id} for this project.`));
  d.out(`  Project: ${d.projectPath}`);
  const builtin = d.core.getBuiltinPlugin(id);
  d.out(chalk.dim(builtin
    ? "  Built-in host authorization is disabled for new sessions in this project."
    : "  Its files remain installed; re-enable it to use it again."));
  process.exitCode = EXIT_OK;
}

// ── info ────────────────────────────────────────────────────────────────────────

export function runInfo(id: string, deps: PluginCommandDeps): void {
  const d = resolve(deps);
  if (!d.core.isSafePluginId(id)) {
    d.err(chalk.red(`"${id}" is not a valid plugin id.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const builtin = d.core.getBuiltinPlugin(id);
  if (builtin) {
    const reconciled = d.core.reconcile(d.core.readEnablement(d.projectPath, d.homeDir), installedViews(d))
      .find((item) => item.pluginId === id);
    const enabled = reconciled?.status === "enabled";
    d.out(chalk.bold(`${builtin.name} (${id}@${builtin.version})`));
    d.out(`  ${builtin.description}`);
    d.out("  Source: built into 0 (no installed files or child process)");
    d.out(`  Enabled for this project: ${enabled ? chalk.green("yes") : chalk.dim("no")}`);
    if (reconciled?.reason) d.out(chalk.yellow(`  ${reconciled.reason}`));
    d.out(`  Activate: 0 plugin enable ${id}`);
    d.out(`  Deactivate: 0 plugin disable ${id}`);
    process.exitCode = EXIT_OK;
    return;
  }
  const root = d.core.pluginsRootDir(d.homeDir);
  const discovered = d.core.readInstalledPlugin(root, id);
  if (!discovered.ok || !discovered.plugin) {
    d.err(chalk.red(`Plugin "${id}" is not installed.`));
    if (discovered.errors) for (const e of discovered.errors) d.err(chalk.dim(`  ${e}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const m = discovered.plugin.manifest;
  const record = d.core.readEnablement(d.projectPath, d.homeDir);
  const reconciled = d.core.reconcile(record, installedViews(d)).find((item) => item.pluginId === id);
  const enabled = reconciled?.status === "enabled";

  d.out(chalk.bold(`${m.name} (${m.id}@${m.version})`));
  if (m.minCoreVersion) d.out(`  Requires @0/core >= ${m.minCoreVersion}`);
  d.out(`  Source: ${join(root, id)}`);
  d.out(`  Enabled for this project: ${enabled ? chalk.green("yes") : chalk.dim("no")}`);
  d.out(`  Aggregated capabilities: ${capSummary(d.core.aggregateCapabilities(m))}`);
  if (reconciled?.reason) d.out(chalk.yellow(`  ${reconciled.reason}`));
  // Signature state is a property of a registry entry, not of installed files;
  // once installed we can only state what we verify locally.
  d.out(chalk.dim("  Signature: not re-verified after install (verification happens at fetch time)."));
  d.out(chalk.bold("  Tools:"));
  for (const t of m.tools) {
    d.out(`    ${t.name}  [${capSummary(t.capabilities)}]  ${t.description}`);
  }
  process.exitCode = EXIT_OK;
}

// ── run ───────────────────────────────────────────────────────────────────────

/**
 * Parse `key=value` argument pairs, merged on top of an optional `--json`
 * object. Values from pairs are strings (the shell has no types); `--json` is
 * for typed/nested arguments. Later pairs override earlier ones and override the
 * json object for the same key.
 */
function parseRunArgs(
  pairs: readonly string[],
  jsonArgs: string | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = {};
  if (jsonArgs && jsonArgs.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonArgs);
    } catch {
      return { ok: false, error: "--json was not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "--json must be a JSON object of tool arguments" };
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k === "__proto__" || k === "prototype" || k === "constructor") continue;
      args[k] = v;
    }
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { ok: false, error: `argument ${JSON.stringify(pair)} is not key=value` };
    const key = pair.slice(0, eq);
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    args[key] = pair.slice(eq + 1);
  }
  return { ok: true, args };
}

/**
 * Invoke one contributed tool of an ENABLED plugin over the real subprocess
 * protocol, in-process, with no scan running. This is the only command that
 * spawns a plugin, and it preserves every invariant:
 *
 *   - it refuses any plugin that is not cleanly ENABLED + loadable for this
 *     project (the re-approval rule — a widened capability set is refused here
 *     exactly as it is at scan time);
 *   - it hands the host the built-in names as `reservedToolNames`, so a plugin
 *     tool can never shadow a built-in and inherit its authorization;
 *   - it runs through the SAME `PluginHost`/`gateFlagsFor` path the console
 *     uses, so a tool's capabilities cannot be exceeded;
 *   - an EFFECTFUL tool (anything not pure read-only) is refused unless the
 *     operator passes `--yes`, so running never silently grants a side effect.
 */
export async function runRun(
  id: string,
  tool: string | undefined,
  pairs: readonly string[],
  deps: PluginCommandDeps,
): Promise<void> {
  const d = resolve(deps);
  if (!d.core.isSafePluginId(id)) {
    d.err(chalk.red(`"${id}" is not a valid plugin id.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  if (d.core.getBuiltinPlugin(id)) {
    d.err(chalk.red(`"${id}" is built-in host authorization, not a runnable tool. Use 0 plugin enable ${id}.`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const root = d.core.pluginsRootDir(d.homeDir);
  const discovered = d.core.readInstalledPlugin(root, id);
  if (!discovered.ok || !discovered.plugin) {
    d.err(chalk.red(`Plugin "${id}" is not installed.`));
    if (discovered.errors) for (const e of discovered.errors) d.err(chalk.dim(`  ${e}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  // Enablement + the re-approval rule: only a cleanly-enabled plugin may run.
  const installed = installedViews(d);
  const record = d.core.readEnablement(d.projectPath, d.homeDir);
  if (!d.core.isEnabled(record, id)) {
    d.err(chalk.red(`Plugin "${id}" is not enabled for this project.`));
    d.err(chalk.cyan(`    0 plugin enable ${id}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }
  const reconciled = d.core.reconcile(record, installed);
  const loadable = new Set(d.core.loadableIds(reconciled));
  if (!loadable.has(id)) {
    const r = reconciled.find((x) => x.pluginId === id);
    d.err(chalk.red(`Plugin "${id}" cannot run: it needs re-approval.`));
    if (r?.reason) d.err(chalk.yellow(`  ${r.reason}`));
    d.err(chalk.cyan(`    0 plugin enable ${id}`));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const parsedArgs = parseRunArgs(pairs, deps.jsonArgs);
  if (!parsedArgs.ok) {
    d.err(chalk.red(parsedArgs.error));
    process.exitCode = EXIT_USER_ERROR;
    return;
  }

  const host = new d.core.PluginHost({
    pluginsDir: root,
    homeDir: d.homeDir,
    enabled: [...loadable],
    reservedToolNames: Object.values(d.core.TOOL_DEFINITIONS).map((t) => t.name),
    coreVersion: deps.coreVersion,
    callTimeoutMs: deps.callTimeoutMs,
  });

  try {
    const loaded = await host.load(id);
    if (!loaded.ok) {
      d.err(chalk.red(`Plugin "${id}" failed to load.`));
      if (loaded.errors) for (const e of loaded.errors) d.err(chalk.dim(`  ${e}`));
      process.exitCode = EXIT_USER_ERROR;
      return;
    }

    const owned = host.registeredTools().filter((t) => t.pluginId === id);
    let target: RegisteredPluginToolView | undefined;
    if (tool) {
      target = owned.find((t) => t.name === tool);
      if (!target) {
        d.err(chalk.red(`Plugin "${id}" contributes no tool named "${tool}".`));
        d.err(`  Available: ${owned.map((t) => t.name).join(", ") || "(none)"}`);
        process.exitCode = EXIT_USER_ERROR;
        return;
      }
    } else if (owned.length === 1) {
      target = owned[0];
    } else {
      d.err(chalk.red(`Plugin "${id}" contributes ${owned.length} tools; name which to run.`));
      d.err(`  ${owned.map((t) => t.name).join(", ")}`);
      process.exitCode = EXIT_USER_ERROR;
      return;
    }

    // Consent gate: never silently grant an effectful tool its side effects.
    if (!target.readOnly && deps.yes !== true) {
      d.err(
        chalk.yellow(
          `Tool "${target.name}" declares [${capSummary(target.capabilities)}] — it is not read-only.`,
        ),
      );
      d.err("  Re-run with --yes to authorize the tool call. The plugin was loaded, but the tool was not called.");
      process.exitCode = EXIT_USER_ERROR;
      return;
    }

    d.out(chalk.dim(`Running ${id}:${target.name}  [${capSummary(target.capabilities)}]`));
    const result = await host.call(target.name, parsedArgs.args, {
      timeoutMs: deps.callTimeoutMs,
    });
    if (!result.ok) {
      d.err(chalk.red(`Tool error: ${result.error}`));
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    if (result.failed) d.out(chalk.yellow("The tool reported failure:"));
    if (result.neutralized) {
      d.out(chalk.dim(`  (untrusted-input defense neutralized markers: ${result.markers.join(", ")})`));
    }
    d.out(result.content);
    if (result.truncated) d.out(chalk.dim("  (result truncated)"));
    process.exitCode = result.failed ? EXIT_USER_ERROR : EXIT_OK;
  } finally {
    host.shutdown();
  }
}

// ── commander wiring ───────────────────────────────────────────────────────────

export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command("plugin")
    .description("Install, enable, inspect, and run Hackstore extensions");

  const withDeps = async (opts: { registry?: string; local?: boolean }): Promise<PluginCommandDeps> => ({
    core: await defaultCorePort(),
    registryUrl: opts.registry,
    local: opts.local === true,
    coreVersion: VERSION,
  });

  plugin
    .command("list")
    .description("List installed plugins and their per-project enabled/stale state")
    .action(async () => {
      runList(await withDeps({}));
    });

  plugin
    .command("search <query>")
    .description("Search the configured registry for plugins")
    .option("--registry <url>", "Hackstore index URL (https)")
    .action(async (query: string, opts: { registry?: string }) => {
      await runSearch(query, await withDeps(opts));
    });

  plugin
    .command("browse")
    .description("List everything in the configured registry")
    .option("--registry <url>", "Hackstore index URL (https)")
    .action(async (opts: { registry?: string }) => {
      await runSearch("", await withDeps(opts));
    });

  plugin
    .command("install <id-or-path>")
    .description("Install registry code, or an offline source with --local; validates and copies, never enables or executes")
    .option("--registry <url>", "Hackstore index URL (https)")
    .option("--local", "Install a local directory containing manifest.json and plugin.js (no network)")
    .action(async (id: string, opts: { registry?: string; local?: boolean }) => {
      await runInstall(id, await withDeps(opts));
    });

  plugin
    .command("enable <id>")
    .description("Approve installed code or activate built-in scope enforcement FOR THIS PROJECT")
    .action(async (id: string) => {
      runEnable(id, await withDeps({}));
    });

  plugin
    .command("disable <id>")
    .description("Revoke project approval or disable built-in scope enforcement (external files stay installed)")
    .action(async (id: string) => {
      runDisable(id, await withDeps({}));
    });

  plugin
    .command("info <id>")
    .description("Show an installed plugin's manifest, capabilities, and enablement state")
    .action(async (id: string) => {
      runInfo(id, await withDeps({}));
    });

  plugin
    .command("run <id> [tool] [pairs...]")
    .description(
      "Invoke a tool of an ENABLED plugin over the protocol (spawns the plugin; " +
        "effectful tools require --yes). Args: key=value pairs and/or --json '<obj>'.",
    )
    .option("--json <json>", "JSON object of tool arguments")
    .option("--yes", "Authorize an effectful (non read-only) tool to run")
    .option("--timeout <ms>", "Per-call timeout in milliseconds", (v) => Number(v))
    .action(
      async (
        id: string,
        tool: string | undefined,
        pairs: string[],
        opts: { json?: string; yes?: boolean; timeout?: number },
      ) => {
        const base = await withDeps({});
        await runRun(id, tool, pairs ?? [], {
          ...base,
          jsonArgs: opts.json,
          yes: opts.yes === true,
          callTimeoutMs: typeof opts.timeout === "number" && Number.isFinite(opts.timeout) ? opts.timeout : undefined,
        });
      },
    );
}
