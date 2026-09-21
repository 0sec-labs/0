/**
 * Runtime-environment probes for deciding whether to launch the opentui
 * (Bun-targeted) TUI flow. Kept deliberately free of opentui imports so
 * callers can check Bun-availability without eagerly loading a chunk
 * that only resolves cleanly under Bun.
 */
import { VERSION } from "@0sec/shared";

export type CliReleaseChannel = "dev" | "beta";

export interface RuntimeMetadata {
  cliVersion: string;
  releaseChannel: CliReleaseChannel;
  engine: "Bun" | "Node.js";
  engineVersion: string;
  platform: string;
  arch: string;
}

export function getRuntimeMetadata(): RuntimeMetadata {
  const bun = isBunRuntime();
  return {
    cliVersion: VERSION,
    releaseChannel: process.env["0SEC_DEV_SOURCE_ROOT"]?.trim() ? "dev" : "beta",
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
