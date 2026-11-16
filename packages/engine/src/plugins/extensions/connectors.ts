/**
 * The connector view: every built-in and approved, enabled extension that declares a connector, with the contract
 * that Connections / Extensions pages render. Static (no I/O beyond the store); live state comes from the auth adapters.
 */
import { BUILTIN_EXTENSIONS } from "./core/builtins.js";
import type { ConnectorDecl } from "./core/connector.js";
import type { ConnectionSecrets, ConnectorAuthPort, ExtensionStore } from "./ports.js";
import { loadable } from "./runtime.js";
import { TokenConnector } from "./adapters/token-connector.js";

export interface ConnectorEntry { extension: string; builtin: boolean; enabled: boolean; connector: ConnectorDecl; approvedEnv: readonly string[] }

export function listConnectors(store: ExtensionStore, projectKey: string | null): ConnectorEntry[] {
  const state = store.read(); if (!state.ok) return [];
  const out: ConnectorEntry[] = BUILTIN_EXTENSIONS.flatMap(b => b.connector ? [{ extension: b.name, builtin: true, enabled: state.value.builtins[b.name]?.enabled !== false, connector: b.connector, approvedEnv: [] }] : []);
  for (const e of loadable(store, projectKey).extensions) if (e.manifest.connector) out.push({ extension: e.name, builtin: false, enabled: true, connector: e.manifest.connector, approvedEnv: e.approvedEnv });
  return out.sort((a, b) => (a.extension < b.extension ? -1 : 1));
}

/** The adapter for a connector this engine can drive itself (plain tokens). Services with their own sign-in (gh) are supplied by the host. */
export function defaultAdapter(entry: ConnectorEntry, secrets: ConnectionSecrets, fetchImpl?: typeof fetch): ConnectorAuthPort | null {
  return entry.connector.methods.includes("token") && entry.connector.env.length > 0 ? new TokenConnector(entry.extension, entry.connector, secrets, fetchImpl) : null;
}
