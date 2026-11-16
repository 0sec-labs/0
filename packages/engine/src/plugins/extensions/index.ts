/**
 * Extensions: one installable unit (a git folder pinned by commit) that can bundle skills, scripts run through bash,
 * MCP server definitions, a connector, a scope policy and a verifier. See docs/design/extension-architecture.md.
 *
 *   core/      pure: manifest, capabilities, diff, prompt, env, state transitions. No I/O.
 *   ports.ts   the seams: ExtensionSource, SourceResolver, ExtensionStore, Installer, Importer.
 *   adapters/  git, local folder, file-system store.
 *   import/    one-time importer for the old plugin, MCP, skill and connector stores.
 */
import { projectKeyOf } from "./project-key.js";
import { DefaultSourceResolver } from "./adapters/source-resolver.js";
import { FsExtensionStore } from "./adapters/fs-store.js";
import { LegacyImporter } from "./import/index.js";
import { ExtensionInstaller } from "./installer.js";
import { listRows, loadable } from "./runtime.js";
import { extensionOverview, type ExtensionOverview } from "./overview.js";
import { readVerified } from "./verify.js";
import { parseManifest } from "./core/manifest.js";
import { capabilitiesOf } from "./core/capabilities.js";
import { buildInstallPrompt, type InstallPrompt } from "./core/prompt.js";
import { err, ok, type Result } from "./core/result.js";
import type { Clock, ExtensionStore, Installer, Importer, SourceResolver } from "./ports.js";

export { ExtensionFailure, unwrap, type ExtensionError, type ExtensionErrorCode, type Result } from "./core/result.js";
export type { Capabilities } from "./core/capabilities.js";
export { capabilitiesOf, capabilityLines } from "./core/capabilities.js";
export { extensionEnv, isProviderKeyName } from "./core/env.js";
export { BUILTIN_EXTENSIONS, getBuiltin, type BuiltinExtension } from "./core/builtins.js";
export { gitTreeHash, type FolderFile } from "./core/files.js";
export { parseManifest, type ExtensionManifest, type ManifestFormat } from "./core/manifest.js";
export { renderInstallPrompt, type InstallPrompt } from "./core/prompt.js";
export type { ExtensionState, ExtensionEntry, ImportReport } from "./core/state.js";
export type { ExtensionStore, ExtensionSource, SourceResolver, Installer, Importer, PreparedInstall, Snapshot } from "./ports.js";
export { approvalRefusal, currentApprovalEnvironment, type ApprovalEnvironment } from "./approval-gate.js";
export { ExtensionInstaller } from "./installer.js";
export { FsExtensionStore, extensionsRoot } from "./adapters/fs-store.js";
export { DefaultSourceResolver } from "./adapters/source-resolver.js";
export { GitSource } from "./adapters/git-source.js";
export { LocalSource } from "./adapters/local-source.js";
export { LegacyImporter } from "./import/index.js";
export { loadable, listRows, type LoadResult, type LoadedExtension, type ListRow } from "./runtime.js";
export { readRepoSuggestions, type Suggestion } from "./suggestions.js";


export interface ExtensionService {
  store: ExtensionStore; installer: Installer; importer: Importer; sources: SourceResolver;
  list(project?: string): ReturnType<typeof listRows>;
  loadable(project?: string): ReturnType<typeof loadable>;
  /** Everything the Extensions page lists, in one read-only call. */
  overview(project?: string): ExtensionOverview;
  /** The install prompt for what is installed now, after checking the folder still matches its pin. */
  info(name: string): Result<{ prompt: InstallPrompt; manifest: import("./core/manifest.js").ExtensionManifest; entry: import("./core/state.js").ExtensionEntry }>;
}

/** Composition root: wires the file-system store and the git/local sources. `home` is redirectable for tests. */
export function createExtensionService(options: { home?: string; clock?: Clock; sources?: SourceResolver } = {}): ExtensionService {
  const clock = options.clock ?? { now: () => new Date() };
  const store = new FsExtensionStore(options.home, clock);
  const sources = options.sources ?? new DefaultSourceResolver(options.home);
  const installer = new ExtensionInstaller({ store, sources, clock, projectKey: projectKeyOf });
  return {
    store, installer, sources, importer: new LegacyImporter({ store, clock }, options.home),
    list: project => listRows(store, project ? projectKeyOf(project) : null),
    loadable: project => loadable(store, project ? projectKeyOf(project) : null),
    overview: project => extensionOverview(store, project ? projectKeyOf(project) : null),
    info(name) {
      const state = store.read(); if (!state.ok) return state;
      const entry = state.value.plugins[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      if (entry.legacy || !entry.active) return err("legacy", entry.legacy?.reason ?? "no installed revision");
      const files = readVerified(store, entry, entry.active); if (!files.ok) return files;
      const manifest = parseManifest(files.value, { fallbackName: name }); if (!manifest.ok) return manifest;
      const source = entry.source ?? { type: "local" as const, path: entry.revisions[entry.active]?.location.kind === "external" ? (entry.revisions[entry.active]!.location as { path: string }).path : "(imported)" };
      const prompt = buildInstallPrompt({ manifest: manifest.value, capabilities: capabilitiesOf(manifest.value), source, revision: entry.active, files: files.value, previous: null });
      return ok({ prompt, manifest: manifest.value, entry });
    },
  };
}
export type { ExtensionOverview, ExtensionOverviewRow } from "./overview.js";
export { extensionSkillRoots, type ExtensionSkillRoot } from "./skills.js";
export { runStartupImport } from "./startup.js";
