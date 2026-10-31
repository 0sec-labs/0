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

test("fresh local CLI supports credential-free discovery, JSON and actionable errors", { timeout: 60_000 }, t => {
  const { cli } = fixture(t);
  const help = cli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const command of ["web", "workflow", "sessions", "runs", "config"]) assert.ok(help.stdout.includes(command), `Missing ${command} in help`);
  assert.match(cli(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+/);
  const templates = jsonSuccess(cli(["workflow", "list", "--templates", "--format", "json"]));
  assert.ok(templates.some(template => template.id === "repository-review"));
  assert.deepEqual(jsonSuccess(cli(["sessions", "list", "--format", "json"])), []);
  assert.equal(jsonSuccess(cli(["config", "export"])).executionProfile, "local");
  const history = cli(["history"]);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /No scan history found/);
  const bad = cli(["workflow", "show", "missing-workflow", "--format", "json"]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "");
  assert.equal(typeof JSON.parse(bad.stderr).error, "string");
  const ambiguous = cli(["not-a-command-or-target"]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /explicit URL, path/);
});

test("CLI starts a loopback host and controls live sessions across independent CLI processes", { timeout: 60_000 }, async t => {
  const { workspace, root, env, cli } = fixture(t, false);
  const tokenEnv = { ZERO_TEST_ENGINE_TOKEN: randomBytes(32).toString("hex") };
  const child = spawn(process.execPath, [entry, "web", "--host", "127.0.0.1", "--port", "0", "--no-open", "--ready-json", "--db-path", join(root, "host.db"), "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN", "--engine-workspace", workspace], {
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
  const created = jsonSuccess(cli(["sessions", "create", ...attach], tokenEnv));
  assert.equal(typeof created.id, "string");
  const sessions = jsonSuccess(cli(["sessions", "list", ...attach], tokenEnv));
  assert.ok(sessions.some(session => session.id === created.id));
  const inspected = jsonSuccess(cli(["sessions", "show", created.id, ...attach], tokenEnv));
  assert.equal(inspected.session?.id ?? inspected.id, created.id);
  const templates = jsonSuccess(cli(["workflow", "list", "--templates", ...attach], tokenEnv));
  assert.ok(templates.some(template => template.id === "repository-review"));
  const missing = cli(["sessions", "show", "missing-session", ...attach], tokenEnv);
  assert.equal(missing.status, 2);
  assert.equal(typeof JSON.parse(missing.stderr).error, "string");
});
