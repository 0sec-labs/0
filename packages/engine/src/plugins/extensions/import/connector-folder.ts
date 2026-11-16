/** Turns an old token-only service connection into a local connector extension folder. Never reads or copies a secret. */
import type { FolderFile } from "../core/files.js";

export interface TokenConnectorSeed { id: string; title: string; description: string; category: string; env: string }

/**
 * The old service connections whose single field was the secret token. Only these become connectors; the others
 * (Elastic, Semgrep, Snyk, Jira) needed a URL or ids as well and are reported, never guessed. Data only: the code that
 * used these connections is gone.
 */
const TOKEN_ONLY: Record<string, { name: string; description: string; category: string }> = {
  github: { name: "GitHub", description: "Review repositories, security alerts and pull requests.", category: "Code" },
  linear: { name: "Linear", description: "Create and track remediation issues.", category: "Issues" },
  cloudflare: { name: "Cloudflare", description: "Inspect zones, DNS and security configuration.", category: "Cloud" },
  slack: { name: "Slack", description: "Read channels and share workflow summaries.", category: "Messaging" },
  teams: { name: "Microsoft Teams", description: "Read teams and share channel summaries.", category: "Messaging" },
};
export function tokenConnectorOf(id: string): TokenConnectorSeed | null {
  const d = Object.hasOwn(TOKEN_ONLY, id) ? TOKEN_ONLY[id]! : undefined;
  if (!d) return null;
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
