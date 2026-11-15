// Shared plumbing for the commands that mirror the web console (config, connections, models,
// github, usage, audit-log). One runner: open the console transport, run the command, map the
// outcome to an exit code (0 ok, 1 failure, 2 usage) and print text or --json. Never calls process.exit.
import { openConsoleClient, type ConsoleClient, type ConsoleResult } from "../console-client.js";

export interface ConsoleCommandDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  setExitCode?: (code: number) => void;
  /** Inject a transport (tests). Defaults to attach-else-embed. */
  client?: ConsoleClient;
  dbPath?: string;
  homeDir?: string;
  readStdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}
export interface JsonOption { json?: boolean }

/** A bad invocation (exit 2). Every other thrown error is a failed operation (exit 1). */
export class UsageError extends Error {}

export function sinks(deps: ConsoleCommandDeps) {
  return {
    out: deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); }),
    err: deps.err ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
    exit: deps.setExitCode ?? ((code: number) => { process.exitCode = code; }),
  };
}

/** Unwrap a console response; the server's own message is shown for failures (e.g. 403 browser_only). */
export function expectOk(result: ConsoleResult): any {
  if (result.status >= 400) {
    const data = result.data as { error?: unknown } | null;
    throw new Error(typeof data?.error === "string" ? data.error : `Request failed (HTTP ${result.status}).`);
  }
  return result.data;
}

export async function runConsoleCommand(options: JsonOption, deps: ConsoleCommandDeps, fn: (client: ConsoleClient, io: ReturnType<typeof sinks>) => Promise<void>): Promise<void> {
  const io = sinks(deps);
  let client: ConsoleClient | undefined;
  try {
    client = deps.client ?? await openConsoleClient({ dbPath: deps.dbPath, homeDir: deps.homeDir });
    await fn(client, io);
    io.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed.";
    io.err(options.json ? JSON.stringify({ error: message }) : `error: ${message}`);
    io.exit(error instanceof UsageError ? 2 : 1);
  } finally {
    if (client && !deps.client) await client.dispose().catch(() => {});
  }
}

export function printJson(io: { out(line: string): void }, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/** Plain aligned columns. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => (row[index] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export async function readSecret(options: { keyEnv?: string; stdin?: boolean }, deps: ConsoleCommandDeps, label: string): Promise<string> {
  if (Boolean(options.keyEnv) === Boolean(options.stdin)) throw new UsageError(`Provide the ${label} with exactly one of --key-env <VAR> or --stdin.`);
  let value: string | undefined;
  if (options.keyEnv) {
    value = (deps.env ?? process.env)[options.keyEnv];
    if (!value?.trim()) throw new UsageError(`Environment variable ${options.keyEnv} is empty or not set.`);
  } else {
    const read = deps.readStdin ?? (async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString("utf8"); });
    value = await read();
    if (!value.trim()) throw new UsageError(`No ${label} was read from stdin.`);
  }
  return value.trim();
}

/**
 * Embedded operator services can leave provider sockets open after the command has finished, so a
 * command that ran through them ends the process once its output has flushed. Only the commander
 * wiring calls this; the run* functions stay free of process control for tests.
 */
export async function exitWhenDone(run: Promise<unknown>): Promise<void> {
  await run;
  const code = Number(process.exitCode ?? 0);
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
