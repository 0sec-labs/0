/**
 * Application service for the extension lifecycle. Depends only on ports (store, sources, clock) and core, so it
 * runs against in-memory fakes in tests. Preparing an install executes nothing and changes no state; committing
 * needs the caller to echo the exact revision it was shown; nothing is enabled unless asked.
 */
import { capabilitiesOf, capabilityKey } from "./core/capabilities.js";
import { gitTreeHash, validateFolder } from "./core/files.js";
import { getBuiltin } from "./core/builtins.js";
import { parseManifest } from "./core/manifest.js";
import { buildInstallPrompt, promptId } from "./core/prompt.js";
import { err, ok, type Result } from "./core/result.js";
import { applyInstall, applyScope, type ExtensionEntry } from "./core/state.js";
import type { Approval, Clock, ExtensionSource, ExtensionStore, Installer, PreparedInstall, SourceResolver } from "./ports.js";
import { readVerified } from "./verify.js";

export interface InstallerDeps { store: ExtensionStore; sources: SourceResolver; clock: Clock; projectKey: (path: string) => string }

export class ExtensionInstaller implements Installer {
  constructor(private readonly deps: InstallerDeps) {}

  async prepare(input: string): Promise<Result<PreparedInstall>> {
    const resolved = this.deps.sources.resolve(input); if (!resolved.ok) return resolved;
    if ("builtin" in resolved.value) return err("builtin", `${resolved.value.builtin} is built in and updates with the 0 binary; there is nothing to install.`);
    return this.#prepareFrom(resolved.value.source, undefined);
  }

  /** The same prompt for a source the caller built itself (a typed MCP server). */
  prepareSource(source: ExtensionSource): Promise<Result<PreparedInstall>> { return this.#prepareFrom(source, undefined); }

  async prepareUpdate(name: string, to?: string): Promise<Result<PreparedInstall | { upToDate: true; revision: string }>> {
    if (getBuiltin(name)) return err("builtin", `${name} is built in and updates with the 0 binary.`);
    const state = this.deps.store.read(); if (!state.ok) return state;
    const entry = state.value.extensions[name];
    if (!entry) return err("not_installed", `${name} is not installed.`);
    if (entry.legacy || !entry.source) return err("legacy", `${name} is an old-format extension kept by the importer; it cannot be updated.`);
    const source = this.deps.sources.fromRecord(entry.source, to); if (!source.ok) return source;
    const prepared = await this.#prepareFrom(source.value, name); if (!prepared.ok) return prepared;
    if (entry.approvedRevision === prepared.value.snapshot.revision) return ok({ upToDate: true, revision: entry.approvedRevision });
    return prepared;
  }

  async #prepareFrom(source: ExtensionSource, expectName: string | undefined): Promise<Result<PreparedInstall>> {
    const fetched = await source.fetch(); if (!fetched.ok) return fetched;
    const snapshot = fetched.value;
    const manifest = parseManifest(snapshot.files, { fallbackName: expectName ?? source.suggestedName }); if (!manifest.ok) return manifest;
    const m = manifest.value;
    if (getBuiltin(m.name)) return err("reserved_name", `${m.name} is a built-in extension and cannot be replaced by installed code.`);
    if (expectName && m.name !== expectName) return err("name_changed", `The new revision calls itself ${m.name}, not ${expectName}; refusing to treat it as an update.`);
    const state = this.deps.store.read(); if (!state.ok) return state;
    const entry = state.value.extensions[m.name];
    if (entry?.legacy) return err("name_taken", `${m.name} is an old-format extension kept by the importer; remove it first.`);
    if (entry?.source && !sameSource(entry, snapshot.source)) return err("name_taken", `${m.name} is already installed from a different source.`);
    let previous = null;
    if (entry?.approvedRevision) {
      const files = readVerified(this.deps.store, entry, entry.approvedRevision);
      previous = { revision: entry.approvedRevision, files: files.ok ? files.value : null, capabilities: entry.revisions[entry.approvedRevision]?.approvedCapabilities ?? null };
    }
    const prompt = buildInstallPrompt({ manifest: m, capabilities: capabilitiesOf(m), source: snapshot.source, revision: snapshot.revision, files: snapshot.files, previous });
    return ok({ prompt, manifest: m, snapshot });
  }

  /**
   * Record an approved install. Nothing the prompt claims is trusted: the tree hash, the capabilities and the name are
   * recomputed from `snapshot.files`, and the approval must name this prompt (id), its revision and its capability digest.
   */
  commit(prepared: PreparedInstall, approval: Approval): Result<{ name: string; revision: string; replaced: string | null }> {
    const { prompt, snapshot } = prepared;
    const valid = validateFolder(snapshot.files); if (!valid.ok) return valid;
    const treeHash = gitTreeHash(snapshot.files);
    if (treeHash !== snapshot.treeHash) return err("content_mismatch", "The files being installed do not match the hash they were fetched with; refusing to install.");
    if (snapshot.revision.startsWith("local-") && snapshot.revision !== `local-${treeHash.slice(0, 16)}`) return err("content_mismatch", "The local revision does not match its files; refusing to install.");
    if (snapshot.revision !== prompt.revision) return err("review_mismatch", "The prompt shown is for a different revision than the one being installed.");
    const manifest = parseManifest(snapshot.files, { fallbackName: prompt.name }); if (!manifest.ok) return manifest;
    const capabilities = capabilitiesOf(manifest.value); const digest = capabilityKey(capabilities);
    if (manifest.value.name !== prompt.name || digest !== capabilityKey(prompt.capabilities) || promptId(prompt) !== prompt.id) return err("review_mismatch", "The prompt shown does not describe these files; approve again.");
    if (approval.approvedRevision !== prompt.revision || approval.promptId !== prompt.id || approval.capabilityDigest !== digest) return err("review_mismatch", "Approve the exact prompt, revision and capabilities that were shown.");
    const stored = this.deps.store.putRevision(prompt.name, snapshot.revision, snapshot.files, treeHash); if (!stored.ok) return stored;
    const enable = approval.enable && (approval.enable.scope === "project" ? { scope: "project" as const, project: this.deps.projectKey(approval.enable.project) } : approval.enable);
    const done = this.deps.store.update(state => applyInstall(state, prompt, treeHash, this.deps.clock.now().toISOString(), enable),
      value => ({ event: prompt.kind === "update" ? "extension.update" : "extension.install", name: prompt.name, revision: prompt.revision, promptId: prompt.id, source: prompt.source, capabilities: prompt.capabilities, replaced: value.replaced }));
    if (!done.ok) return done;
    return ok({ name: prompt.name, revision: prompt.revision, replaced: done.value.replaced });
  }

  enable(name: string, options: { project?: string; approve?: boolean } = {}): Result<{ name: string; revision: string | null; builtin: boolean }> {
    const now = this.deps.clock.now().toISOString();
    if (getBuiltin(name)) {
      const r = this.deps.store.update(s => { s.builtins[name] = { enabled: true, explicit: true, changedAt: now }; return ok(undefined); }, () => ({ event: "extension.enable", name, builtin: true }));
      return r.ok ? ok({ name, revision: null, builtin: true }) : r;
    }
    const result = this.deps.store.update(state => {
      const entry = state.extensions[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      if (entry.legacy || !entry.active) return err("legacy", `${name} cannot be enabled: ${entry.legacy?.reason ?? "no installed revision"}.`);
      const record = entry.revisions[entry.active]!;
      if (!record.approvedAt) {
        if (!options.approve) return err("needs_approval", `${name}@${entry.active.slice(0, 12)} has not been approved. Run \`0 skills extensions info ${name}\`, then enable with --yes.`);
        const files = readVerified(this.deps.store, entry, entry.active); if (!files.ok) return files;
        const manifest = parseManifest(files.value, { fallbackName: name }); if (!manifest.ok) return manifest;
        const caps = capabilitiesOf(manifest.value);
        Object.assign(record, { approvedAt: now, approvedCapabilities: caps, approvedCapabilityKey: capabilityKey(caps), approvedEnv: caps.env });
        entry.approvedRevision = entry.active; delete entry.sealBroken;
      }
      applyScope(entry, options.project ? { scope: "project", project: options.project } : { scope: "global" }, true, this.deps.projectKey);
      return ok(entry.active);
    }, revision => ({ event: "extension.enable", name, revision, project: options.project ? this.deps.projectKey(options.project) : null }));
    return result.ok ? ok({ name, revision: result.value, builtin: false }) : result;
  }

  disable(name: string, options: { project?: string; confirm?: boolean } = {}): Result<{ name: string; builtin: boolean }> {
    const builtin = getBuiltin(name);
    if (builtin) {
      if (!options.confirm) return err("needs_confirmation", builtin.confirmDisable);
      const r = this.deps.store.update(s => { s.builtins[name] = { enabled: false, changedAt: this.deps.clock.now().toISOString() }; return ok(undefined); }, () => ({ event: "extension.disable", name, builtin: true, confirmed: true }));
      return r.ok ? ok({ name, builtin: true }) : r;
    }
    const r = this.deps.store.update(state => {
      const entry = state.extensions[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      applyScope(entry, options.project ? { scope: "project", project: options.project } : { scope: "global" }, false, this.deps.projectKey);
      return ok(undefined);
    }, () => ({ event: "extension.disable", name, project: options.project ? this.deps.projectKey(options.project) : null }));
    return r.ok ? ok({ name, builtin: false }) : r;
  }

  /** State first, folders second: a crash in between leaves unreferenced folders, never an entry pointing at nothing. */
  remove(name: string): Result<{ name: string; removedRevisions: string[] }> {
    if (getBuiltin(name)) return err("builtin", `${name} is built in and cannot be removed.`);
    const result = this.deps.store.update(state => {
      const entry = state.extensions[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      const stored = Object.entries(entry.revisions).filter(([, r]) => r.location.kind === "store").map(([rev]) => rev);
      delete state.extensions[name];
      return ok({ all: Object.keys(entry.revisions), stored });
    }, value => ({ event: "extension.remove", name, revisions: value.all }));
    if (!result.ok) return result;
    const deleted = this.deps.store.deleteRevisions(name, result.value.stored);
    if (!deleted.ok) return err("io", `${name} was removed, but its folders could not be deleted: ${deleted.error.message}`);
    return ok({ name, removedRevisions: result.value.all });
  }
}

/** What the operator approves, bound to the exact prompt they were shown. */
export const approvalFor = (prepared: PreparedInstall, enable?: Approval["enable"]): Approval =>
  ({ approvedRevision: prepared.prompt.revision, promptId: prepared.prompt.id, capabilityDigest: capabilityKey(prepared.prompt.capabilities), ...(enable ? { enable } : {}) });

const sameSource = (entry: ExtensionEntry, next: NonNullable<ExtensionEntry["source"]>): boolean =>
  entry.source!.type === next.type && (entry.source!.type === "local" || JSON.stringify(entry.source) === JSON.stringify(next));
