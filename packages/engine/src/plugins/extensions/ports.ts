/**
 * The seams. Core and the application services depend on these interfaces only; git, the file system and the CLI
 * are adapters that implement or call them. Dependencies point inward: adapters -> ports -> core.
 */
import type { FolderFile } from "./core/files.js";
import type { InstallPrompt, SourceRecord } from "./core/prompt.js";
import type { Result } from "./core/result.js";
import type { ExtensionState, ImportReport, RevisionRecord } from "./core/state.js";
import type { ExtensionManifest } from "./core/manifest.js";
import type { Capabilities } from "./core/capabilities.js";
import type { ConnectorStatus } from "./core/connector.js";

/** One immutable revision of an extension's files. */
export interface Snapshot { readonly revision: string; readonly files: readonly FolderFile[]; readonly treeHash: string; readonly source: SourceRecord }

/** Where an extension comes from: a pinned git commit, a local folder. Built-ins are not sources; they are in the binary. */
export interface ExtensionSource {
  readonly label: string;
  /** Default name when the manifest does not give one. */
  readonly suggestedName: string;
  /** True when the revision is fixed by the caller (full SHA given); false when it is resolved at fetch time. */
  readonly pinned: boolean;
  fetch(): Promise<Result<Snapshot>>;
}

/** Turns what the operator typed into a source (or says it is a built-in). */
export interface SourceResolver {
  resolve(input: string): Result<{ source: ExtensionSource } | { builtin: string }>;
  /** Rebuild a source from a stored record, optionally pinned to a commit (update). */
  fromRecord(record: SourceRecord, pin?: string): Result<ExtensionSource>;
}

export interface AuditEvent { readonly event: string; readonly [key: string]: unknown }

/** Persistence for state, immutable revision folders and the audit trail. */
export interface ExtensionStore {
  read(): Result<ExtensionState>;
  /**
   * Read-modify-write under a lock. Persists only when `fn` returns ok. `audit` builds the audit event for the change;
   * it is appended BEFORE the state is written and a failed append aborts the change (fail closed: an approval that
   * cannot be audited is not recorded). Refused in an agent session.
   */
  update<T>(fn: (state: ExtensionState) => Result<T>, audit?: (value: T) => AuditEvent): Result<T>;
  /** Write a revision folder. Immutable: an existing folder must hash to `treeHash` or the call fails. Refused in an agent session. */
  putRevision(name: string, revision: string, files: readonly FolderFile[], treeHash: string): Result<void>;
  readRevision(name: string, revision: string, location: RevisionRecord["location"]): Result<FolderFile[]>;
  /** Absolute folder of a revision, for processes the extension starts. */
  revisionPath(name: string, revision: string, location: RevisionRecord["location"]): string;
  deleteRevisions(name: string, revisions: readonly string[]): Result<void>;
}

export interface Clock { now(): Date }

export interface PreparedInstall { readonly prompt: InstallPrompt; readonly manifest: ExtensionManifest; readonly snapshot: Snapshot }
export interface Approval { approvedRevision: string; promptId: string; capabilityDigest: string; enable?: { scope: "global" } | { scope: "project"; project: string } }

/** Install lifecycle as the CLI and the future Extensions page see it. */
export interface Installer {
  prepare(input: string): Promise<Result<PreparedInstall>>;
  commit(prepared: PreparedInstall, approval: Approval): Result<{ name: string; revision: string; replaced: string | null }>;
  prepareUpdate(name: string, to?: string): Promise<Result<PreparedInstall | { upToDate: true; revision: string }>>;
  enable(name: string, options?: { project?: string; approve?: boolean }): Result<{ name: string; revision: string | null; builtin: boolean }>;
  disable(name: string, options?: { project?: string; confirm?: boolean }): Result<{ name: string; builtin: boolean }>;
  remove(name: string): Result<{ name: string; removedRevisions: string[] }>;
}

export interface Importer { run(options?: { force?: boolean }): Result<ImportReport & { alreadyDone: boolean }> }

export interface ApprovedView { name: string; revision: string; dir: string; manifest: ExtensionManifest; capabilities: Capabilities }

/**
 * Where the secret a token connection fills is kept, per extension and variable name. A value leaves this port only
 * through `extensionEnv` (declared AND approved) or the connector's own health probe; it is never listed or logged.
 */
export interface ConnectionSecrets {
  read(extension: string, name: string): string | undefined;
  has(extension: string, name: string): boolean;
  write(extension: string, name: string, value: string): Result<void>;
  remove(extension: string, name: string): Result<void>;
}

/**
 * How one connector signs in and reports its state. The contract decides WHICH methods exist (`methods`); an adapter
 * does the work for a service (`gh` for GitHub, the secret store for a token). Optional operations a connector's
 * methods do not need are absent.
 */
export interface ConnectorAuthPort {
  status(): Promise<ConnectorStatus>;
  /** `oauth-device`: start the sign-in; the status carries the one-time code while it waits. */
  signIn?(): Promise<ConnectorStatus>;
  /** `token`: validate the token, store it, report the new status. The token is never returned. */
  connectToken?(token: string): Promise<ConnectorStatus>;
  cancel?(): Promise<ConnectorStatus>;
  disconnect?(): Promise<ConnectorStatus>;
}
