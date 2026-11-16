// `0 config get audit` — the local append-only log of privileged actions, as on the web Settings > Audit log page.
import type { Command } from "commander";
import { listAudit, resolveOsecDbPath, type AuditEvent } from "@0/engine/storage";
import { printJson, renderTable, sinks, UsageError, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

export interface AuditLogOptions extends JsonOption { q?: string; limit?: string; before?: string }

function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer.`);
  return parsed;
}

export function runAuditLog(options: AuditLogOptions, deps: ConsoleCommandDeps = {}): void {
  const io = sinks(deps);
  try {
    const limit = positive("limit", options.limit);
    const before = positive("before", options.before);
    const page = listAudit({ ...(limit ? { limit } : {}), ...(before ? { before } : {}), q: options.q ?? "" }, { dbPath: resolveOsecDbPath(deps.dbPath) });
    if (options.json) printJson(io, page);
    else if (!page.events.length) io.out("No audit events.");
    else {
      io.out(renderTable(["ID", "TIME", "ACTOR", "ACTION", "SUBJECT", "OUTCOME"], page.events.map((e: AuditEvent) => [String(e.id), e.ts, e.actor, e.action, e.subject, e.outcome])));
      if (page.nextBefore) io.out(`More: --before ${page.nextBefore}`);
    }
    io.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the audit log.";
    io.err(options.json ? JSON.stringify({ error: message }) : `error: ${message}`);
    io.exit(error instanceof UsageError ? 2 : 1);
  }
}

export function registerAuditLogCommand(program: Command, deps: ConsoleCommandDeps = {}): void {
  program.command("audit-log").description("Show the local log of privileged actions (connections, settings, plugins)")
    .option("--q <text>", "Only events whose action, subject or actor contains this text")
    .option("--limit <n>", "Maximum events to show")
    .option("--before <id>", "Only events older than this id (pagination)")
    .option("--json", "Print JSON")
    .action((o: AuditLogOptions) => runAuditLog(o, deps));
}
