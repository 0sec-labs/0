import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ToolExecutor } from "@0/engine";

const thisDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = join(thisDir, "../../src/index.ts");
// Invoke tsx's cli.mjs with node directly. The node_modules/.bin/tsx shim is a
// /bin/sh script, and on dash-based systems /bin/sh strips environment
// variables whose names are not shell identifiers — which includes the
// digit-leading ZERO_* contract this suite exercises.
const tsxCliPath = join(thisDir, "../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = join(thisDir, "tsconfig.cli-e2e.json");
const testHome = mkdtempSync(join(tmpdir(), "0-cli-test-"));
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const projectRoot = join(thisDir, "../../../..");


const run = (args: string[], timeout = 30_000, extraEnv: Record<string, string | undefined> = {}) => {
  // Never inherit operator credentials or update/telemetry configuration.
  // The child deadline remains authoritative; the suite allows it to expire.
  return spawnSync(process.execPath, [tsxCliPath, "--tsconfig", tsconfigPath, cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: testHome,
      TMPDIR: testHome,
      NO_COLOR: "1",
      "ZERO_OFFLINE": "1",
      "ZERO_SUPPRESS_PROVIDER_STARTUP_LOG": "1",
      ...extraEnv,
    },
  });
};

describe("CLI E2E", () => {
  it("--help shows all commands", () => {
    const result = run(["--help"]);
    expect(result.status, result.stderr || String(result.error ?? "")).toBe(0);
    expect(result.stdout).toContain("0");
    for (const cmd of ["findings", "threads", "sentinels", "skills", "memory", "models", "computers", "config"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${cmd}\\b`, "m"));
    }
    for (const hidden of ["web", "doctor", "automation", "api"]) expect(result.stdout).not.toMatch(new RegExp(`^  ${hidden}\\b`, "m"));
  });

  it("--version shows version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
