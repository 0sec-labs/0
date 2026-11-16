/** Connection secrets in `~/.0/extensions/connections.json`: owner-only (0600 file, 0700 directory), atomic writes, no symlinks. */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_SESSION_ENV, RUN_BY_THREAD_MESSAGE } from "../../../shared/agent-session.js";
import { err, ok, type Result } from "../core/result.js";
import type { ConnectionSecrets } from "../ports.js";
import { extensionsRoot } from "./fs-store.js";

type Data = Record<string, Record<string, string>>;

export class FsConnectionSecrets implements ConnectionSecrets {
  readonly #path: string;
  constructor(home?: string) { this.#path = join(extensionsRoot(home), "connections.json"); }

  #load(): Data {
    let fd: number;
    try { if (lstatSync(this.#path).isSymbolicLink()) return {}; fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return {}; }
    try {
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > 1_048_576) return {};
      const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: Data = {};
      for (const [ext, names] of Object.entries(raw)) if (names && typeof names === "object") for (const [n, v] of Object.entries(names)) if (typeof v === "string") (out[ext] ??= {})[n] = v;
      return out;
    } catch { return {}; } finally { closeSync(fd); }
  }
  #save(data: Data): Result<void> {
    const dir = dirname(this.#path); const tmp = join(dir, `.connections-${randomUUID()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
      writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" }); renameSync(tmp, this.#path); return ok(undefined);
    } catch { return err("io", "The connection could not be saved on this computer."); } finally { rmSync(tmp, { force: true }); }
  }

  read(extension: string, name: string): string | undefined { return this.#load()[extension]?.[name]; }
  has(extension: string, name: string): boolean { return this.read(extension, name) !== undefined; }
  #refused(): Result<void> | null { return process.env[AGENT_SESSION_ENV] ? err("agent_session", RUN_BY_THREAD_MESSAGE) : null; }
  write(extension: string, name: string, value: string): Result<void> { const no = this.#refused(); if (no) return no; const d = this.#load(); (d[extension] ??= {})[name] = value; return this.#save(d); }
  remove(extension: string, name: string): Result<void> {
    const no = this.#refused(); if (no) return no;
    const d = this.#load(); const row = d[extension]; if (!row || !(name in row)) return ok(undefined);
    delete row[name]; if (!Object.keys(row).length) delete d[extension]; return this.#save(d);
  }
}
