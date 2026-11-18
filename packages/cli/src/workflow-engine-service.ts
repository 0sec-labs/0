import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { EngineService, ENGINE_OPERATIONS } from "@0/engine";
import { createEngineCapabilityManifest } from "@0/engine/shared";
import { osecDB, resolveOsecDbPath } from "@0/engine/storage";
import type { ConsoleGateway } from "./web/console-gateway.js";
import type { WebWorkflowService } from "./web/workflows.js";

interface WorkflowEngineServiceOptions {
  token: string; workspace?: string; dbPath?: string; model?: string;
  allowApply?: boolean; timeCapMs?: number; costCapUsd?: number;
}
interface WorkflowEngineHost { gateway: ConsoleGateway; workflows: WebWorkflowService }
/** Workflow-only control databases need not have initialized scan storage yet. */
function missingScanTable(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (/^no such table: (?:main\.)?scans$/i.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
/** Transport facade over the very same sessions and runs used by the browser. */
export class WorkflowEngineService {
  readonly ready: Promise<void>;
  readonly #engine: EngineService;
  readonly #sessions = new Map<string, Promise<string>>();
  #disposed = false;
  constructor(private readonly options: WorkflowEngineServiceOptions, private readonly host: WorkflowEngineHost) {
    if (typeof options.token !== "string" || options.token.length < 32 || options.token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(options.token)) throw new Error("Engine access requires a configured secret of 32–4096 characters.");
    if (options.timeCapMs !== undefined) z.number().int().positive().max(86_400_000).parse(options.timeCapMs);
    if (options.costCapUsd !== undefined) z.number().positive().max(1000).parse(options.costCapUsd);
    this.ready = options.workspace ? realpath(options.workspace).then(() => undefined) : Promise.resolve();
    this.#engine = new EngineService({
      sessions: host.gateway, workflows: host.workflows, allowApply: options.allowApply,
      scans: {
        list: () => { const db = new osecDB(options.dbPath, { readOnly: true }); try {
          const conversations = this.#conversationIds();
          try { return db.listScans(1000).filter(scan => !conversations.has(scan.id) && !scan.id.startsWith("console-")); }
          catch (error) { if (missingScanTable(error)) return []; throw error; }
        } finally { db.close(); } },
        get: id => {
          if (id.startsWith("console-") || this.#conversationIds().has(id)) return undefined;
          const db = new osecDB(options.dbPath, { readOnly: true }); try {
            try { return db.getScan(id); } catch (error) { if (missingScanTable(error)) return undefined; throw error; }
          } finally { db.close(); }
        },
      },
      admitRun: () => Promise.reject(new Error("This engine starts work through threads and Sentinels, not workflow runs.")), createSession: config => this.#createSession(config),
      capabilities: () => createEngineCapabilityManifest({ operations: [...ENGINE_OPERATIONS], reportFormats: ["json", "md", "html", "sarif", "pdf"] }),
    });
  }
  #conversationIds(): Set<string> {
    return new Set([
      ...this.host.gateway.list().flatMap(session => [session.id, ...(session.savedId ? [session.savedId] : [])]),
      ...this.host.gateway.listSaved({ limit: 1000 }).map(session => session.id),
    ]);
  }
  async #createSession(config: Record<string, unknown>): Promise<{ id: string }> {
    if (this.#disposed) throw new Error("Engine transport is closed.");
    return this.host.gateway.create({ ...config, ...(this.options.model ? { runtime: { model: this.options.model } } : {}) });
  }
  async invoke(name: string, raw: Record<string, unknown>): Promise<unknown> {
    if (this.#disposed) throw new Error("Engine transport is closed.");
    await this.ready;
    if (this.#disposed) throw new Error("Engine transport is closed.");
    return this.#engine.invoke(name, raw);
  }
  /** Resolve evidence only through engine-owned storage and retained scan provenance.
   * No client path or global home-directory discovery participates in this lookup.
   */
  resolveScanDatabase(scanId: string): string | undefined {
    if (this.#disposed) throw new Error("Engine transport is closed.");
    z.string().min(1).max(512).parse(scanId);
    const candidates = new Set<string>([resolveOsecDbPath(this.options.dbPath)]);
    for (const execution of this.host.workflows.listExecutions()) {
      for (const node of Object.values(execution.nodeResults)) {
        if (node.scanId !== scanId && !node.scanIds?.includes(scanId)) continue;
        for (const path of node.dbPaths ?? []) candidates.add(path);
      }
    }
    const matches = new Set<string>();
    const checked = new Set<string>();
    for (const path of candidates) {
      if (path === ":memory:") continue;
      let canonical: string;
      try { canonical = realpathSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (checked.has(canonical)) continue;
      checked.add(canonical);
      const db = new osecDB(canonical, { readOnly: true });
      try {
        if (db.getScan(scanId)) matches.add(canonical);
      } catch (error) { if (!missingScanTable(error)) throw error; }
      finally { db.close(); }
    }
    if (matches.size > 1) throw new Error("Scan evidence is ambiguous: this scan ID exists in multiple engine-owned databases.");
    return matches.values().next().value;
  }
  /** Detaching a transport never tears down the engine's browser sessions or runs. */
  async dispose(): Promise<void> { this.#disposed = true; }
}
