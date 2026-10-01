/**
 * Runtime-environment probes for deciding whether to launch the opentui
 * (Bun-targeted) TUI flow. Kept deliberately free of opentui imports so
 * callers can check Bun-availability without eagerly loading a chunk
 * that only resolves cleanly under Bun.
 */
import { VERSION } from "@0/shared";

declare const __ZERO_RELEASE_CHANNEL__: string;

export type CliReleaseChannel = "dev" | "beta";

export interface RuntimeMetadata {
  cliVersion: string;
  releaseChannel: CliReleaseChannel;
  engine: "Bun" | "Node.js";
  engineVersion: string;
  platform: string;
  arch: string;
}

/** Build intent is explicit; a version define alone does not prove a release.
 * Source launches, local bundles and local binaries default to development.
 * The release workflow stamps its artifacts; source/runtime env cannot promote them.
 */
export function getReleaseChannel(env: Record<string, string | undefined> = process.env): CliReleaseChannel {
  if (env["ZERO_DEV_SOURCE_ROOT"]?.trim() || env["NODE_ENV"] === "development") return "dev";
  return typeof __ZERO_RELEASE_CHANNEL__ !== "undefined" && __ZERO_RELEASE_CHANNEL__ === "beta" ? "beta" : "dev";
}

export function getRuntimeMetadata(): RuntimeMetadata {
  const bun = isBunRuntime();
  return {
    cliVersion: VERSION,
    releaseChannel: getReleaseChannel(),
    engine: bun ? "Bun" : "Node.js",
    engineVersion: bun ? (process.versions.bun ?? "unknown") : process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export function isBunRuntime(): boolean {
  return typeof globalThis === "object" && globalThis !== null && "Bun" in globalThis;
}

export function canUseOpenTui(): boolean {
  return !!(process.stdout.isTTY && process.stdin.isTTY);
}
