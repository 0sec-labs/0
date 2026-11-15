import { accessSync, constants } from "node:fs";
import { basename, dirname } from "node:path";

export const NPM_MIGRATION_HINT =
  "This 0 was installed with npm, which is no longer updated (last version 0.21.4). Run `npm uninstall -g 0sec-cli`, then `curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/install.sh | bash`.";

interface Origin { argv1?: string; execPath?: string }

/** True for an install that lives under node_modules (npm, pnpm, yarn or npx). Needs no network. */
export function isNpmStyleInstall(origin: Origin = { argv1: process.argv[1], execPath: process.execPath }): boolean {
  return [origin.argv1, origin.execPath].some(p => typeof p === "string" && /[\\/]node_modules[\\/]/.test(p));
}

/**
 * Where an update should land: the folder of the running standalone binary, so the `0` on the user's PATH
 * is the one that changes. Undefined (installer default, ~/.0/bin) for source, npm, node, bun or a read-only folder.
 */
export function defaultInstallDir(
  origin: Origin = { argv1: process.argv[1], execPath: process.execPath },
  writable: (dir: string) => boolean = dir => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } },
): string | undefined {
  const exec = origin.execPath;
  if (!exec || isNpmStyleInstall(origin)) return undefined;
  if (!/^0(\.exe)?$/.test(basename(exec))) return undefined;
  const dir = dirname(exec);
  return writable(dir) ? dir : undefined;
}
