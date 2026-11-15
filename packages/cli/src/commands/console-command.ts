import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { Command } from "commander";
import { ConsoleRequestError, openConsoleClient, type ConsoleClient, type ConsoleClientOptions } from "../console-client.js";

/** Bad flags, missing confirmation, unknown template: exit 2. Server/transport failures exit 1. */
export class UsageError extends Error {}

export interface ConsoleCommandDeps {
  out(text: string): void;
  err(text: string): void;
  open(options: ConsoleClientOptions): Promise<ConsoleClient>;
  homeDir?: string;
}
export const consoleDefaults: ConsoleCommandDeps = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  open: options => openConsoleClient(options),
};

export interface ConsoleFlags { json?: boolean; dbPath?: string }

/** `--json` and `--db-path`, shared by every console-backed command. */
export function consoleFlags(command: Command): Command {
  return command.option("--json", "Print machine-readable JSON").option("--db-path <path>", "Control database (default: the user database)");
}

export interface Column<T> { header: string; value(row: T): unknown }
/** Plain padded table; the same shape existing `list` commands print. */
export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (!rows.length) return "No records.";
  const cells = rows.map(row => columns.map(column => String(column.value(row) ?? "").replaceAll("\n", " ")));
  const widths = columns.map((column, index) => Math.max(column.header.length, ...cells.map(row => row[index]!.length)));
  const line = (values: string[]) => values.map((value, index) => index === values.length - 1 ? value : value.padEnd(widths[index]!)).join("  ");
  return [line(columns.map(column => column.header)), ...cells.map(line)].join("\n");
}

export function renderFields(fields: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(fields).map(key => key.length));
  return Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => `${key.padEnd(width)}  ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
}

/**
 * Open the client, run the action, print its result (JSON, or `render`'s text), and map errors to exit codes.
 * Never calls process.exit; the client is always disposed.
 */
export async function withConsole<T>(flags: ConsoleFlags, deps: ConsoleCommandDeps, action: (client: ConsoleClient) => Promise<T>, render: (value: T) => string, extra: { requireHost?: string } = {}): Promise<void> {
  let client: ConsoleClient | undefined;
  try {
    client = await deps.open({ dbPath: flags.dbPath, homeDir: deps.homeDir, ...(extra.requireHost ? { requireHost: extra.requireHost } : {}) });
    const value = await action(client);
    deps.out(flags.json ? JSON.stringify(value, null, 2) : render(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.err(flags.json ? JSON.stringify({ error: message }) : message);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  } finally {
    await client?.dispose().catch(() => {});
  }
}

/** Destructive or authority-granting actions never prompt: they need an explicit --yes. */
export function requireYes(yes: boolean | undefined, what: string): void {
  if (!yes) throw new UsageError(`${what} Re-run with --yes to confirm.`);
}

export const enc = encodeURIComponent;

/** Resolve a full id or a unique prefix against a listing. */
export function resolveId<T extends { id: string }>(items: readonly T[], reference: string, label: string): T {
  const exact = items.find(item => item.id === reference);
  if (exact) return exact;
  const matches = items.filter(item => item.id.startsWith(reference));
  if (matches.length === 1) return matches[0]!;
  throw new ConsoleRequestError(matches.length ? `${label} ID prefix "${reference}" is ambiguous (${matches.length} matches).` : `${label} not found: ${reference}`, matches.length ? 409 : 404);
}

/** Bounded regular-file JSON read (256 KiB), so a growing or special file cannot exhaust memory. */
export async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  const maximum = 256 * 1024;
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new UsageError(`Cannot read ${label} file: ${path}`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new UsageError(`${label} must be a regular JSON file.`);
    if (stat.size > maximum) throw new UsageError(`${label} must be at most 256 KiB.`);
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(buffer, 0, maximum + 1, 0);
    if (bytesRead > maximum) throw new UsageError(`${label} must be at most 256 KiB.`);
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); } catch { throw new UsageError(`${label} is not valid JSON.`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${label} must be a JSON object.`);
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}
