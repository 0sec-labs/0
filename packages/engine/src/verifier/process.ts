import { spawn } from "node:child_process";

export interface ExecResult { code: number | null; output: string; timedOut: boolean; spawnError?: string }

const MAX_KEPT = 256 * 1024;

/** Run a program with an argument vector (no shell). Keeps only the tail of the output. */
export function exec(file: string, args: string[], options: { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<ExecResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ExecResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    } catch (error) { resolve({ code: null, output: "", timedOut: false, spawnError: error instanceof Error ? error.message : String(error) }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    const keep = (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > MAX_KEPT) output = output.slice(output.length - MAX_KEPT); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => finish({ code: null, output, timedOut, spawnError: error.message }));
    child.on("close", (code) => finish({ code, output, timedOut }));
  });
}
