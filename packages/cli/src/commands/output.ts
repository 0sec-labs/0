import type { Command } from "commander";
import chalk from "chalk";
import { openConsole, type ConsoleClient, type ConsoleDependencies, type ConsoleOptions, type ConsoleReply } from "../console-client.js";

/** Exit codes: 0 ok, 1 the operation failed, 2 the command was used wrongly. */
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export class UsageError extends Error {}

export interface CommandIo {
  out(line: string): void;
  err(line: string): void;
  setExitCode(code: number): void;
  /** Test seam: replaces attach-or-embed. */
  open?(options: ConsoleOptions): Promise<ConsoleClient>;
  consoleDeps?: ConsoleDependencies;
}
export interface OutputOptions { json?: boolean; dbPath?: string }

export function defaultIo(): CommandIo {
  return { out: line => console.log(line), err: line => console.error(line), setExitCode: code => { process.exitCode = code; } };
}

/** `--json` and `--db-path` for commands that call the console API. */
export function consoleOptions(command: Command): Command {
  return command.option("--json", "Print machine-readable JSON").option("--db-path <path>", "Use this engine database instead of the default");
}

export function emit(io: CommandIo, options: OutputOptions, value: unknown, text: () => string): void {
  io.out(options.json ? JSON.stringify(value, null, 2) : text());
}

export function renderTable(rows: readonly (readonly string[])[], headers: readonly string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map(row => (row[column] ?? "").length)));
  const line = (row: readonly string[]) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [chalk.bold(line(headers)), ...rows.map(line)].join("\n");
}

export function expectOk(reply: ConsoleReply): unknown {
  if (reply.status >= 200 && reply.status < 300) return reply.data;
  const message = reply.data && typeof reply.data === "object" && "error" in reply.data && typeof reply.data.error === "string" ? reply.data.error : `Request failed (HTTP ${reply.status}).`;
  throw new Error(message);
}

/** Open the console, run `fn`, map errors to exit codes and `{error}` JSON, and always dispose. */
export async function runConsole(io: CommandIo, options: OutputOptions, fn: (client: ConsoleClient) => Promise<void>): Promise<void> {
  let client: ConsoleClient | undefined;
  try {
    client = await (io.open ?? ((consoleOpts: ConsoleOptions) => openConsole(consoleOpts, io.consoleDeps)))({ ...(options.dbPath ? { dbPath: options.dbPath } : {}) });
    await fn(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(options.json ? JSON.stringify({ error: message }) : message);
    io.setExitCode(error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE);
  } finally { await client?.dispose().catch(() => {}); }
}

export function requireYes(yes: boolean | undefined, what: string): void {
  if (yes !== true) throw new UsageError(`${what} Re-run with --yes to confirm.`);
}
