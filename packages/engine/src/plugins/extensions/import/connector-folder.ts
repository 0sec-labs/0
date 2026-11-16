/** Turns an old token-only service connection into a local connector extension folder. Never reads or copies a secret. */
import { SERVICE_PLUGIN_CATALOG } from "../../../shared/index.js";
import type { FolderFile } from "../core/files.js";

export interface TokenConnectorSeed { id: string; title: string; description: string; category: string; env: string }

/** Only services whose single field is the secret token become connectors; URLs and identifiers need more than a token slot. */
export function tokenConnectorOf(id: string): TokenConnectorSeed | null {
  const d = SERVICE_PLUGIN_CATALOG.find(p => p.id === id);
  if (!d || d.fields.length !== 1 || d.fields[0]!.type !== "secret") return null;
  const env = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;
  return { id, title: d.name, description: d.description, category: d.category, env };
}

export function connectorFolder(name: string, seed: TokenConnectorSeed): FolderFile[] {
  const bytes = Buffer.from(JSON.stringify({
    name, version: "0.0.0", description: `Imported ${seed.title} connection`,
    connector: { service: seed.id, title: seed.title, description: seed.description, category: seed.category, auth: "token", env: [seed.env], hosts: [], access: { read: [], write: [] } },
  }, null, 2) + "\n");
  return [{ path: "extension.json", size: bytes.length, executable: false, bytes }];
}
