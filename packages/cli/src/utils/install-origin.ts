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

export type InstallKind = "binary" | "docker" | "npm" | "source";

export interface InstallInfo {
  kind: InstallKind;
  /** A standalone binary whose folder this process may replace: the only kind the console can update by itself. */
  managed: boolean;
  /** Folder of the running binary (binary installs only). */
  dir?: string;
  /** What to tell the user when the console cannot update this install itself. */
  instruction?: string;
}

interface InstallProbe extends Origin {
  /** Test seams; the defaults look at the real process and filesystem. */
  inContainer?: () => boolean;
  platform?: NodeJS.Platform;
  writable?: (dir: string) => boolean;
}

export const DOCKER_UPDATE_COMMAND = "docker pull ghcr.io/0sec-labs/0security:latest";
export const SOURCE_UPDATE_COMMAND = "git pull";
export const BINARY_UPDATE_COMMAND = "0 doctor upgrade";

function runningInContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["ZERO_IN_DOCKER"] === "1") return true;
  try { accessSync("/.dockerenv", constants.F_OK); return true; } catch { /* not Docker */ }
  try { accessSync("/run/.containerenv", constants.F_OK); return true; } catch { return false; }
}

/**
 * What kind of install is this process? Only a standalone `0` binary in a writable folder is managed:
 * Docker images are replaced, never patched; npm installs are retired; source checkouts update with git.
 */
export function detectInstallKind(probe: InstallProbe = {}): InstallInfo {
  const origin: Origin = { argv1: probe.argv1 ?? process.argv[1], execPath: probe.execPath ?? process.execPath };
  if ((probe.inContainer ?? runningInContainer)()) return { kind: "docker", managed: false, instruction: DOCKER_UPDATE_COMMAND };
  if (isNpmStyleInstall(origin)) return { kind: "npm", managed: false, instruction: NPM_MIGRATION_HINT };
  if (!origin.execPath || !/^0(\.exe)?$/.test(basename(origin.execPath))) return { kind: "source", managed: false, instruction: SOURCE_UPDATE_COMMAND };
  if ((probe.platform ?? process.platform) === "win32") return { kind: "binary", managed: false, instruction: "Download the latest 0-windows-x64.exe from https://github.com/0sec-labs/0security/releases/latest and replace this one." };
  const dir = defaultInstallDir(origin, probe.writable);
  if (!dir) return { kind: "binary", managed: false, instruction: BINARY_UPDATE_COMMAND };
  return { kind: "binary", managed: true, dir };
}
