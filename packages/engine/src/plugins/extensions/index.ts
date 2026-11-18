/**
 * Extensions: one installable unit (a git folder pinned by commit) that can bundle skills, scripts run through bash,
 * MCP server definitions, a connector and a verifier. See docs/design/extension-architecture.md.
 *
 *   core/      pure: manifest, capabilities, diff, prompt, env, state transitions. No I/O.
 *   ports.ts   the seams: ExtensionSource, SourceResolver, ExtensionStore, Installer, Importer.
 *   adapters/  git, local folder, file-system store.
 *   import/    one-time importer for the old plugin, MCP, skill and connector stores.
 */
import { projectKeyOf } from "./project-key.js";
import { DefaultSourceResolver } from "./adapters/source-resolver.js";
import { FsExtensionStore, extensionsRoot } from "./adapters/fs-store.js";
import { FsConnectionSecrets } from "./adapters/fs-connection-secrets.js";
import { LegacyImporter } from "./import/index.js";
import { ExtensionInstaller } from "./installer.js";
import { listRows, loadable } from "./runtime.js";
import { extensionOverview, type ExtensionOverview } from "./overview.js";
import { ExtensionMcpHost } from "./mcp/host.js";
import { StdioMcpConnector } from "./mcp/adapters/stdio.js";
import { SdkMcpConnector } from "./mcp/adapters/http.js";
import { StatePinStore } from "./mcp/adapters/pins.js";
import { FileObservationLog } from "./mcp/adapters/observed.js";
import { FileSnapshotStore } from "./mcp/adapters/snapshots.js";
import { createScriptRuns } from "./script-runs.js";
import type { ExtensionRunPort } from "../../agent/types.js";
import { mcpServerStatuses, type McpServerStatus } from "./mcp/status.js";
import type { McpConnector, McpGate } from "./mcp/ports.js";
import type { McpToolHost } from "../../agent/mcp-host.js";
import { readVerified } from "./verify.js";
import { parseManifest } from "./core/manifest.js";
import { capabilitiesOf } from "./core/capabilities.js";
import { buildInstallPrompt, type InstallPrompt } from "./core/prompt.js";
import { err, ok, type Result } from "./core/result.js";
import type { Clock, ConnectionSecrets, ExtensionStore, Installer, Importer, SourceResolver } from "./ports.js";

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
export { ExtensionInstaller, approvalFor } from "./installer.js";
export { FsExtensionStore, extensionsRoot } from "./adapters/fs-store.js";
export { DefaultSourceResolver } from "./adapters/source-resolver.js";
export { GitSource } from "./adapters/git-source.js";
export { LocalSource } from "./adapters/local-source.js";
export { McpDraftSource, type McpDraft } from "./adapters/mcp-draft-source.js";
export { LegacyImporter } from "./import/index.js";
export { loadable, listRows, type LoadResult, type LoadedExtension, type ListRow } from "./runtime.js";
export { FsConnectionSecrets } from "./adapters/fs-connection-secrets.js";
export { TokenConnector } from "./adapters/token-connector.js";
export { listConnectors, defaultAdapter, type ConnectorEntry } from "./connectors.js";
export { GITHUB_CONNECTOR } from "./core/builtins.js";
export { CONNECTOR_AUTHS, connectorCanDo, hostAllowed, type ConnectorAuth, type ConnectorDecl, type ConnectorHealth, type ConnectorState, type ConnectorStatus } from "./core/connector.js";
export type { ConnectionSecrets, ConnectorAuthPort } from "./ports.js";
export { readRepoSuggestions, type Suggestion } from "./suggestions.js";


export interface ExtensionService {
  store: ExtensionStore; secrets: ConnectionSecrets; installer: Installer; importer: Importer; sources: SourceResolver;
  list(project?: string): ReturnType<typeof listRows>;
  loadable(project?: string): ReturnType<typeof loadable>;
  /** Everything the Extensions page lists, in one read-only call. */
  overview(project?: string): ExtensionOverview;
  /** The install prompt for what is installed now, after checking the folder still matches its pin. */
  /** The MCP servers an installed extension declares, with approved tool hashes against what each last showed. Connects to nothing. */
  mcpStatus(name: string): Result<McpServerStatus[]>;
  /** A lazy host for the MCP servers of the extensions enabled for `project`. `base` keeps the operator's own servers working. */
  mcpHost(options: { project?: string; gate: McpGate; base?: McpToolHost; connector?: McpConnector; parentEnv?: Record<string, string | undefined> }): ExtensionMcpHost;
  /** The port the bash tool asks before it runs a command: what an enabled, approved extension's script may receive. */
  scriptRuns(project?: string): ExtensionRunPort;
  info(name: string): Result<{ prompt: InstallPrompt; manifest: import("./core/manifest.js").ExtensionManifest; entry: import("./core/state.js").ExtensionEntry }>;
}

/** Composition root: wires the file-system store and the git/local sources. `home` is redirectable for tests. */
export function createExtensionService(options: { home?: string; clock?: Clock; sources?: SourceResolver } = {}): ExtensionService {
  const clock = options.clock ?? { now: () => new Date() };
  const store = new FsExtensionStore(options.home, clock);
  const sources = options.sources ?? new DefaultSourceResolver(options.home);
  const secrets = new FsConnectionSecrets(options.home);
  const installer = new ExtensionInstaller({ store, sources, clock, projectKey: projectKeyOf });
  const pins = new StatePinStore(store, clock); const observed = new FileObservationLog(extensionsRoot(options.home)); const snapshots = new FileSnapshotStore(extensionsRoot(options.home));
  const service: ExtensionService = {
    store, secrets, installer, sources, importer: new LegacyImporter({ store, clock }, options.home),
    list: project => listRows(store, project ? projectKeyOf(project) : null),
    loadable: project => loadable(store, project ? projectKeyOf(project) : null, secrets),
    overview: project => extensionOverview(store, project ? projectKeyOf(project) : null, { pins, observed }),
    mcpStatus(name) { const r = service.info(name); return r.ok ? ok(mcpServerStatuses(r.value.manifest, pins.pins(name, r.value.entry.active!), observed.read(name, r.value.entry.active!))) : r; },
    mcpHost: o => new ExtensionMcpHost({ extensions: loadable(store, o.project ? projectKeyOf(o.project) : null, secrets).extensions, snapshots, connector: o.connector ?? new SdkMcpConnector(new StdioMcpConnector()), pins, observed, gate: o.gate, ...(o.base ? { base: o.base } : {}), ...(o.parentEnv ? { parentEnv: o.parentEnv } : {}) }),
    scriptRuns: project => createScriptRuns({ store, secrets, projectKey: project ? projectKeyOf(project) : null }),
    info(name) {
      const state = store.read(); if (!state.ok) return state;
      const entry = state.value.extensions[name];
      if (!entry) return err("not_installed", `${name} is not installed.`);
      if (entry.legacy || !entry.active) return err("legacy", entry.legacy?.reason ?? "no installed revision");
      const files = readVerified(store, entry, entry.active); if (!files.ok) return files;
      const manifest = parseManifest(files.value, { fallbackName: name }); if (!manifest.ok) return manifest;
      const source = entry.source ?? { type: "local" as const, path: entry.revisions[entry.active]?.location.kind === "external" ? (entry.revisions[entry.active]!.location as { path: string }).path : "(imported)" };
      const prompt = buildInstallPrompt({ manifest: manifest.value, capabilities: capabilitiesOf(manifest.value), source, revision: entry.active, files: files.value, previous: null });
      return ok({ prompt, manifest: manifest.value, entry });
    },
  };
  return service;
}
export * from "./mcp/index.js";
export type { ExtensionOverview, ExtensionOverviewRow } from "./overview.js";
export { extensionSkillRoots, type ExtensionSkillRoot } from "./skills.js";
export { runStartupImport } from "./startup.js";
