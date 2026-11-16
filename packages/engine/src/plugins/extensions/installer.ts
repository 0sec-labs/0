/**
 * Application service for the extension lifecycle. Depends only on ports (store, sources, clock) and core, so it
 * runs against in-memory fakes in tests. Preparing an install executes nothing and changes no state; committing
 * needs the caller to echo the exact revision it was shown; nothing is enabled unless asked.
 */
import { capabilitiesOf, capabilityKey } from "./core/capabilities.js";
import { getBuiltin } from "./core/builtins.js";
import { parseManifest } from "./core/manifest.js";
import { buildInstallPrompt } from "./core/prompt.js";
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

  async prepareUpdate(name: string, to?: string): Promise<Result<PreparedInstall | { upToDate: true; revision: string }>> {
    if (getBuiltin(name)) return err("builtin", `${name} is built in and updates with the 0 binary.`);
    const state = this.deps.store.read(); if (!state.ok) return state;
    const entry = state.value.plugins[name];
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
    const entry = state.value.plugins[m.name];
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

  commit(prepared: PreparedInstall, approval: Approval): Result<{ name: string; revision: string; replaced: string | null }> {
    const { prompt, snapshot } = prepared;
    if (approval.approvedRevision !== prompt.revision) return err("review_mismatch", "Approve the exact revision that was shown.");
    const stored = this.deps.store.putRevision(prompt.name, snapshot.revision, snapshot.files, snapshot.treeHash); if (!stored.ok) return stored;
    const enable = approval.enable && (approval.enable.scope === "project" ? { scope: "project" as const, project: this.deps.projectKey(approval.enable.project) } : approval.enable);
    const done = this.deps.store.update(state => applyInstall(state, prompt, snapshot.treeHash, this.deps.clock.now().toISOString(), enable));
    if (!done.ok) return done;
    this.deps.store.audit({ event: prompt.kind === "update" ? "extension.update" : "extension.install", name: prompt.name, revision: prompt.revision, source: prompt.source, capabilities: prompt.capabilities });
    return ok({ name: prompt.name, revision: prompt.revision, replaced: done.value.replaced });
  }

  enable(name: string, options: { project?: string; approve?: boolean } = {}): Result<{ name: string; revision: string | null; builtin: boolean }> {
    const now = this.deps.clock.now().toISOString();
    if (getBuiltin(name)) {
      const r = this.deps.store.update(s => { s.builtins[name] = { enabled: true, changedAt: now }; return ok(undefined); }); if (!r.ok) return r;
      this.deps.store.audit({ event: "extension.enable", name, builtin: true });
      return ok({ name, revision: null, builtin: true });
    }
    const result = this.deps.store.update(state => {
      const entry = state.plugins[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      if (entry.legacy || !entry.active) return err("legacy", `${name} cannot be enabled: ${entry.legacy?.reason ?? "no installed revision"}.`);
      const record = entry.revisions[entry.active]!;
      if (!record.approvedAt) {
        if (!options.approve) return err("needs_approval", `${name}@${entry.active.slice(0, 12)} has not been approved. Run \`0 skills extensions info ${name}\`, then enable with --yes.`);
        const files = readVerified(this.deps.store, entry, entry.active); if (!files.ok) return files;
        const manifest = parseManifest(files.value, { fallbackName: name }); if (!manifest.ok) return manifest;
        const caps = capabilitiesOf(manifest.value);
        Object.assign(record, { approvedAt: now, approvedCapabilities: caps, approvedCapabilityKey: capabilityKey(caps), approvedEnv: caps.env });
        entry.approvedRevision = entry.active;
      }
      applyScope(entry, options.project ? { scope: "project", project: options.project } : { scope: "global" }, true, this.deps.projectKey);
      return ok(entry.active);
    });
    if (!result.ok) return result;
    this.deps.store.audit({ event: "extension.enable", name, revision: result.value, project: options.project ? this.deps.projectKey(options.project) : null });
    return ok({ name, revision: result.value, builtin: false });
  }

  disable(name: string, options: { project?: string; confirm?: boolean } = {}): Result<{ name: string; builtin: boolean }> {
    const builtin = getBuiltin(name);
    if (builtin) {
      if (!options.confirm) return err("needs_confirmation", builtin.confirmDisable);
      const r = this.deps.store.update(s => { s.builtins[name] = { enabled: false, changedAt: this.deps.clock.now().toISOString() }; return ok(undefined); }); if (!r.ok) return r;
      this.deps.store.audit({ event: "extension.disable", name, builtin: true, confirmed: true });
      return ok({ name, builtin: true });
    }
    const r = this.deps.store.update(state => {
      const entry = state.plugins[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      applyScope(entry, options.project ? { scope: "project", project: options.project } : { scope: "global" }, false, this.deps.projectKey);
      return ok(undefined);
    });
    if (!r.ok) return r;
    this.deps.store.audit({ event: "extension.disable", name, project: options.project ? this.deps.projectKey(options.project) : null });
    return ok({ name, builtin: false });
  }

  remove(name: string): Result<{ name: string; removedRevisions: string[] }> {
    if (getBuiltin(name)) return err("builtin", `${name} is built in and cannot be removed.`);
    const result = this.deps.store.update(state => {
      const entry = state.plugins[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      const stored = Object.entries(entry.revisions).filter(([, r]) => r.location.kind === "store").map(([rev]) => rev);
      const deleted = this.deps.store.deleteRevisions(name, stored); if (!deleted.ok) return deleted;
      delete state.plugins[name];
      return ok(Object.keys(entry.revisions));
    });
    if (!result.ok) return result;
    this.deps.store.audit({ event: "extension.remove", name, revisions: result.value });
    return ok({ name, removedRevisions: result.value });
  }
}

const sameSource = (entry: ExtensionEntry, next: NonNullable<ExtensionEntry["source"]>): boolean =>
  entry.source!.type === next.type && (entry.source!.type === "local" || JSON.stringify(entry.source) === JSON.stringify(next));
