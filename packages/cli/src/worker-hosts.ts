import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SshHostEntry {
  alias: string;
  hostname?: string;
  user?: string;
  port?: string;
}

/** Parse OpenSSH config Host blocks into deploy candidates (Codex-style discovery). */
export function discoverSshHosts(configPath = join(homedir(), ".ssh", "config")): SshHostEntry[] {
  let text: string;
  try { text = readFileSync(configPath, "utf8"); } catch { return []; }
  const entries: SshHostEntry[] = [];
  let current: SshHostEntry | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const hostMatch = /^host\s+(.+)$/i.exec(line);
    if (hostMatch) {
      const aliases = hostMatch[1]!.split(/\s+/).filter(alias => !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!"));
      current = aliases.length === 1 ? { alias: aliases[0]! } : undefined;
      if (current) entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^(\w+)\s+(.+)$/.exec(line);
    if (!field) continue;
    const key = field[1]!.toLowerCase();
    if (key === "hostname") current.hostname = field[2];
    else if (key === "user") current.user = field[2];
    else if (key === "port") current.port = field[2];
  }
  return entries;
}

/** Deploy target for an entry: alias when complete config exists, explicit user@host otherwise. */
export function deployTargetFor(entry: SshHostEntry): string {
  return entry.alias;
}
