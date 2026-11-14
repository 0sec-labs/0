import { realpathSync } from "node:fs";
import { sanitizedEnv } from "@0/core";

export const HOST_CONSOLE_WORKER_ARGUMENT = "--host-console-worker";

/** Reuse the running executable; never resolve another engine from PATH. */
export function hostConsoleLaunch(workspace: string) {
  let entry: string | undefined = process.argv[1];
  try { if (entry) entry = realpathSync(entry); } catch { entry = undefined; }
  const source = entry && /\.[cm]?[jt]s$/.test(entry) && !/[\/]\$bunfs[\/]|[\\/]~BUN[\\/]/i.test(entry);
  return {
    command: process.execPath,
    args: [...(source ? [entry!] : []), HOST_CONSOLE_WORKER_ARGUMENT],
    cwd: workspace,
    env: sanitizedEnv(),
  };
}
