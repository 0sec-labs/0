import { spawn } from "node:child_process";

export interface RestartCommand { command: string; args: string[] }

/**
 * The command that starts this same `0 web` again: same executable, same arguments, and the port it actually
 * bound (so `--port 0` or a fallback port is kept). `--no-open` stops a second browser tab from opening: the
 * page that asked for the update reconnects on its own.
 */
export function restartCommand(input: { execPath: string; argv: readonly string[]; execArgv?: readonly string[]; compiled: boolean; port?: number }): RestartCommand {
  const carried = input.compiled ? input.argv.slice(2) : [...(input.execArgv ?? []), ...input.argv.slice(1)];
  const args: string[] = [];
  for (let i = 0; i < carried.length; i++) {
    const arg = carried[i]!;
    if (input.port !== undefined && arg === "--port") { i++; continue; }
    if (input.port !== undefined && arg.startsWith("--port=")) continue;
    args.push(arg);
  }
  if (input.port !== undefined) args.push("--port", String(input.port));
  if (!args.includes("--no-open")) args.push("--no-open");
  return { command: input.execPath, args };
}

/** Starts the replacement. It inherits stdio so output keeps going to the same place, and outlives this process. */
export function spawnRestart(command: RestartCommand): number | undefined {
  const child = spawn(command.command, command.args, { stdio: "inherit", env: process.env });
  child.on("error", () => undefined);
  child.unref();
  return child.pid;
}
