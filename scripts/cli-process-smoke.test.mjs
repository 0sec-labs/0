/** Real CLI checks. Build shared/db/templates/core/CLI first, then run node --test scripts/cli-process-smoke.test.mjs. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const entry = join(repo, "packages/cli/dist/index.js");
const source = join(repo, "packages/cli/src/index.ts");

function fixture(t, autoCleanup = true) {
  assert.ok(existsSync(entry), "Build @0/cli before running CLI process tests.");
  assert.ok(statSync(entry).mtimeMs >= statSync(source).mtimeMs, "CLI output predates its source; rebuild @0/cli first.");
  const root = mkdtempSync(join(tmpdir(), "0-cli-process-"));
  const home = join(root, "home"); const workspace = join(root, "workspace");
  mkdirSync(home); mkdirSync(workspace);
  if (autoCleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  // Deliberately allowlist environment variables: host provider credentials,
  // Codex login state and configured remote workers must never enter this test.
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(process.platform === "win32" ? ";" : ":"),
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CI: "1", NO_COLOR: "1", ZERO_OFFLINE: "1", ZERO_NO_UPDATE_CHECK: "1",
    ZERO_ANALYTICS_LEVEL: "off", DO_NOT_TRACK: "1", ZERO_0VERSE_MCP: "0", ZERO_MCP: "[]",
  };
  const cli = (args, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: workspace, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    return result;
  };
  return { root, workspace, env, cli };
}

function jsonSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("deprecated environment names still work and warn once at the CLI entry", { timeout: 60_000 }, t => {
  const { cli, root } = fixture(t);
  for (const [old, replacement] of [
    ["ZERO_CHATGPT_AUTH_FILE", "ZERO_CODEX_AUTH_JSON_PATH"],
    ["ZERO_WPSCAN_API_TOKEN", "WPSCAN_API_TOKEN"],
    ["ZERO_SKIP_PROVIDER_BANNER", "ZERO_SUPPRESS_PROVIDER_STARTUP_LOG"],
  ]) {
    const result = cli(["--help"], { [old]: join(root, "value") });
    assert.equal(result.status, 0, result.stderr);
    const notice = `[0] ${old} is deprecated; use ${replacement}.`;
    assert.equal(result.stderr.split(notice).length - 1, 1, result.stderr);
    assert.ok(!result.stderr.includes(join(root, "value")), "value must not be logged");
    assert.equal(cli(["--help"], { [old]: "x", ZERO_NO_DEPRECATION_WARNINGS: "1" }).stderr.includes("deprecated"), false);
  }
});

test("fresh local CLI supports credential-free discovery, JSON and actionable errors", { timeout: 60_000 }, t => {
  const { cli } = fixture(t);
  const help = cli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  const visible = ["findings", "threads", "sentinels", "skills", "models", "computers", "config"];
  for (const command of visible) assert.match(help.stdout, new RegExp(`^  ${command}\\b`, "m"), `Missing ${command} in help`);
  for (const hidden of ["web", "doctor", "automation", "api"]) assert.doesNotMatch(help.stdout, new RegExp(`^  ${hidden}\\b`, "m"), `${hidden} is not a top-level command in help`);
  assert.match(cli(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+/);
  const noConsole = cli(["threads", "list", "--format", "json"]);
  assert.equal(noConsole.status, 1, "threads need a running console, never an empty list");
  assert.equal(noConsole.stdout, "");
  assert.match(JSON.parse(noConsole.stderr).error, /^No console running\. Start one with: 0 --headless/);
  assert.equal(jsonSuccess(cli(["config", "get", "--export"])).executionProfile, "local");
  const empty = cli(["findings", "list", "--format", "json"]);
  assert.equal(empty.status, 0, "an empty export is an empty list, not a failure");
  assert.deepEqual(JSON.parse(empty.stdout).findings, []);
  const bare = cli(["threads"]);
  assert.equal(bare.status, 0, "a command with no subcommand prints its help");
  assert.match(bare.stdout, /^Commands:$/m);
  assert.match(bare.stdout, /Examples:/);
  const ambiguous = cli(["not-a-command-or-target"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /unknown command/i);
  assert.match(ambiguous.stderr, /Run `0 --help`/);
});

test("CLI reports an invalid option value without a stack trace", { timeout: 60_000 }, t => {
  const { cli } = fixture(t);
  const result = cli(["findings", "--limit", "99999"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Finding limit must be an integer between 0 and 5000\./);
  assert.doesNotMatch(result.stderr, /^\s+at /m);
  assert.match(cli(["findings", "--limit", "99999"], { ZERO_DEBUG: "1" }).stderr, /^\s+at renderFindingsList /m);
});

test("CLI starts a loopback host and controls live sessions across independent CLI processes", { timeout: 60_000 }, async t => {
  const { workspace, root, env, cli } = fixture(t, false);
  const tokenEnv = { ZERO_TEST_ENGINE_TOKEN: randomBytes(32).toString("hex") };
  const child = spawn(process.execPath, [entry, "--host", "127.0.0.1", "--port", "0", "--no-open", "--ready-json", "--db-path", join(root, "host.db"), "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN", "--engine-workspace", workspace], {
    cwd: workspace, env: { ...env, ...tokenEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => {
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local CLI host did not become ready: ${errors}`)), 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Local CLI host exited ${code}: ${errors}`)); });
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = /^ZERO_DASHBOARD_READY (.+)$/m.exec(output);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1]).url); }
    });
  });
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
  const attach = ["--engine-url", origin, "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN", "--format", "json"];
  const created = jsonSuccess(cli(["threads", "create", ...attach], tokenEnv));
  assert.equal(typeof created.id, "string");
  const sessions = jsonSuccess(cli(["threads", "list", ...attach], tokenEnv));
  assert.ok(sessions.some(session => session.id === created.id));
  const inspected = jsonSuccess(cli(["threads", "list", created.id, ...attach], tokenEnv));
  assert.equal(inspected.session?.id ?? inspected.id, created.id);
  const templates = jsonSuccess(cli(["sentinels", "list", "--automation", "--templates", ...attach], tokenEnv));
  assert.ok(templates.some(template => template.id === "repository-review"));
  const missing = cli(["threads", "list", "missing-session", ...attach], tokenEnv);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).error, /^Thread not found\. List threads with `0 threads list`\.$/);
});

test("server mode refuses a busy port instead of moving to another one", async t => {
  const { cli } = fixture(t);
  const { createServer } = await import("node:net");
  const busy = createServer();
  await new Promise(resolve => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => busy.close());
  const port = busy.address().port;
  const result = cli(["--server-mode", "--host", "127.0.0.1", "--port", String(port), "--no-open"], { ZERO_ACCESS_TOKEN: randomBytes(24).toString("hex") });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /EADDRINUSE/);
  assert.doesNotMatch(result.stdout, /free port/);
});
