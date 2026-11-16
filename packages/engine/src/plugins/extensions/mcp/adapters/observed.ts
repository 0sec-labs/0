import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpObservation, McpObservationLog } from "../ports.js";

/** `<root>/mcp-observed.json`. Unsealed on purpose: it only describes what a server showed; approvals live in the sealed state. */
export class FileObservationLog implements McpObservationLog {
  readonly #path: string;
  constructor(private readonly root: string) { this.#path = join(root, "mcp-observed.json"); }
  #all(): Record<string, McpObservation> {
    try { if (!existsSync(this.#path) || !lstatSync(this.#path).isFile()) return {}; const v = JSON.parse(readFileSync(this.#path, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, McpObservation> : {}; } catch { return {}; }
  }
  record(extension: string, revision: string, server: string, observation: McpObservation): void {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const all = this.#all(); all[`${extension}\0${revision}\0${server}`] = observation;
      const tmp = `${this.#path}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, this.#path);
    } catch { /* informational: never fail a connection because the log could not be written */ }
  }
  read(extension: string, revision: string): Readonly<Record<string, McpObservation>> {
    const prefix = `${extension}\0${revision}\0`;
    return Object.fromEntries(Object.entries(this.#all()).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  }
}
