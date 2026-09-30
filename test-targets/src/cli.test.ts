import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { detectAndRoute } from "../../packages/cli/src/routing.js";
import { ToolExecutor } from "../../packages/core/src/agent/tools.js";

const thisDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = join(thisDir, "../../packages/cli/src/index.ts");
// Invoke tsx's cli.mjs with node directly. The node_modules/.bin/tsx shim is a
// /bin/sh script, and on dash-based systems /bin/sh strips environment
// variables whose names are not shell identifiers — which includes the
// digit-leading ZERO_* contract this suite exercises.
const tsxCliPath = join(thisDir, "../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = join(thisDir, "../tsconfig.cli-e2e.json");
const testHome = mkdtempSync(join(tmpdir(), "0-cli-test-"));
const testDbPath = join(testHome, "findings.db");
let registryUrl = "";
let registryProcess: ChildProcess | undefined;
beforeAll(async () => {
  const packageRoot = join(testHome, "package");
  mkdirSync(packageRoot);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "is-odd", version: "3.0.1", main: "index.js" }));
  writeFileSync(join(packageRoot, "index.js"), "module.exports = n => Number.isInteger(n) && Math.abs(n) % 2 === 1;\n");
  const archive = join(testHome, "is-odd-3.0.1.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", testHome, "package"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`Unable to pack controlled npm fixture: ${packed.stderr}`);
  // A separate process serves acquisition while spawnSync blocks the test worker.
  const serverCode = `
    import { createServer } from "node:http";
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const archive = readFileSync(process.env.NPM_FIXTURE_ARCHIVE);
    const server = createServer((request, response) => {
      if (request.url === "/is-odd-3.0.1.tgz") { response.end(archive); return; }
      const version = { name: "is-odd", version: "3.0.1", main: "index.js", dist: {
        tarball: "http://127.0.0.1:" + server.address().port + "/is-odd-3.0.1.tgz",
        shasum: createHash("sha1").update(archive).digest("hex"),
        integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
      }};
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "is-odd", "dist-tags": { latest: "3.0.1" }, versions: { "3.0.1": version } }));
    });
    server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));
  `;
  registryProcess = spawn(process.execPath, ["--input-type=module", "-e", serverCode], {
    env: { PATH: process.env.PATH, HOME: testHome, NPM_FIXTURE_ARCHIVE: archive },
    stdio: ["ignore", "pipe", "pipe"],
  });
  registryUrl = await new Promise<string>((resolve, reject) => {
    registryProcess!.once("error", reject);
    registryProcess!.once("exit", code => reject(new Error(`Controlled npm registry exited: ${code}`)));
    registryProcess!.stdout!.once("data", data => resolve(String(data).trim()));
  });
});
afterAll(() => registryProcess?.kill());
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const projectRoot = join(thisDir, "../..");


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
      "ZERO_SKIP_PROVIDER_BANNER": "1",
      ...extraEnv,
      npm_config_registry: registryUrl,
      npm_config_cache: join(testHome, "npm-cache"),
    },
  });
};

describe("CLI E2E", () => {
  it("--help shows all commands", () => {
    const result = run(["--help"]);
    expect(result.status, result.stderr || String(result.error ?? "")).toBe(0);
    expect(result.stdout).toContain("0");
    for (const cmd of ["scan", "audit", "review", "history", "findings", "replay", "doctor"]) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it("auto-routes an existing bare relative path to deep source review", () => {
    expect(detectAndRoute("src")).toEqual(["review", "src", "--depth", "deep"]);
  });

  it("allows piped analysis commands without invoking shell operators", async () => {
    const executor = new ToolExecutor({
      target: "http://example.com",
      scanId: "test",
      findings: [],
      attackResults: [],
      targetInfo: {},
      scopePath: projectRoot,
      persistFindings: false,
    }, null);

    const ok = await executor.execute({
      name: "run_command",
      arguments: { command: "cat package.json | head -n 1" },
    });
    expect(ok.success).toBe(true);

    const blocked = await executor.execute({
      name: "run_command",
      arguments: { command: "cat package.json || head -n 1" },
    });
    expect(blocked.success).toBe(false);
    expect(String(blocked.error)).toContain("Empty pipe segments");
  });

  it("--version shows version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("audit --help shows audit options", () => {
    const result = run(["audit", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--depth");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("--runtime");
  });

  it("audit is-odd --runtime api --format json degrades cleanly without API key", () => {
    const result = run(
      ["audit", "is-odd", "--runtime", "api", "--format", "json", "--db-path", testDbPath],
      60_000,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.package).toBe("is-odd");
    expect(parsed.summary.totalFindings).toBeTypeOf("number");
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('"package": "is-odd"');
  }, 65_000);


  it("scan --help shows scan options", () => {
    const result = run(["scan", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--target");
    expect(result.stdout).toContain("--mode");
  });

  it("share URL is still generated for a successful degraded deterministic run", () => {
    const result = run(
      ["audit", "is-odd", "--runtime", "api", "--format", "terminal", "--db-path", testDbPath + "-share"],
      60_000,
    );
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(0);
    expect(output).toContain("0.security/r#");
  }, 65_000);

  it("emits a machine-readable result line when requested on degraded api runs", () => {
    const result = run(
      ["audit", "is-odd", "--runtime", "api", "--format", "json", "--db-path", testDbPath + "-result-line"],
      60_000,
      {
        "ZERO_EMIT_RESULT_LINE": "1",
      },
    );
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(0);
    const line = output.split("\n").find((entry) => entry.startsWith("ZERO_RESULT="));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line!.slice("ZERO_RESULT=".length));
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.targetType).toBe("npm-package");
  }, 65_000);
}, 35_000);
