import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpSnapshotStore } from "../ports.js";
import type { ToolSnapshots } from "../core/snapshot.js";

/** `<root>/mcp-approved.json`. Display text of the last approved tools, for the approval diff. Unsealed: it grants nothing. */
export class FileSnapshotStore implements McpSnapshotStore {
  readonly #path: string;
  constructor(private readonly root: string) { this.#path = join(root, "mcp-approved.json"); }
  #all(): Record<string, ToolSnapshots> {
    try { if (!existsSync(this.#path) || !lstatSync(this.#path).isFile()) return {}; const v = JSON.parse(readFileSync(this.#path, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, ToolSnapshots> : {}; } catch { return {}; }
  }
  read(extension: string, _revision: string, server: string): ToolSnapshots | undefined { return this.#all()[`${extension}\0${server}`]; }
  write(extension: string, _revision: string, server: string, tools: ToolSnapshots): void {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const all = this.#all(); all[`${extension}\0${server}`] = tools;
      const tmp = `${this.#path}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, this.#path);
    } catch { /* display only */ }
  }
}
