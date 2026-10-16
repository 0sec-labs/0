import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const entry = process.argv[2];
if (!entry) throw new Error("Usage: node scripts/smoke-web-setup.mjs <CLI entry or binary>");
const cli = realpathSync(resolve(entry));
const root = mkdtempSync(join(tmpdir(), "0-web-setup-"));
const home = join(root, "home");
const emptyPath = join(root, "no-executables");
for (const dir of [home, emptyPath]) mkdirSync(dir);
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: emptyPath };
let child;
let log = "";
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  if (!await Promise.race([stopped.then(() => true), delay(5000).then(() => false)])) {
    child.kill("SIGKILL");
    await stopped;
  }
}
async function start() {
  log = "";
  child = spawn(cli.endsWith(".js") ? process.execPath : cli, [
    ...(cli.endsWith(".js") ? [cli] : []), "dashboard", "--no-open", "--ready-json", "--port", "0", "--db-path", join(root, "workspace.db"),
  ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  child.on("error", error => { log += error.stack; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = log.match(/ZERO_DASHBOARD_READY (\{[^\n]+\})/);
    if (ready) return new URL(JSON.parse(ready[1]).url).origin;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(100);
  }
  throw new Error(`Dashboard failed to start:\n${log}`);
}
async function bootstrap(base) {
  const response = await fetch(base, { signal: AbortSignal.timeout(10_000) });
  const html = await response.text();
  assert(response.ok && html.includes("/assets/"), "Missing embedded dashboard");
  const token = html.match(/<meta name="0-control-token" content="([^"]+)"/)?.[1];
  assert(token, "Missing control token");
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    const asset = await fetch(new URL(match[1], base), { signal: AbortSignal.timeout(10_000) });
    assert(asset.ok, `Missing embedded asset ${match[1]}`);
  }
  return async (path, method = "GET", body) => {
    const result = await fetch(`${base}/api/console/${path}`, {
      method, headers: { "x-0-control-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    const data = await result.json();
    assert(result.ok, `${method} ${path}: ${result.status} ${JSON.stringify(data)}`);
    return data;
  };
}
try {
  let request = await bootstrap(await start());
  assert.equal((await request("settings")).settings.onboardingCompleted, false);
  await request("providers");
  await request("models");
  await request("sessions");
  for (const [key, value] of [["analyticsLevel", "off"], ["diagnosticReporting", "ask"], ["onboardingCompleted", true]]) {
    const result = await request("settings", "PATCH", { key, value });
    assert.equal(result.persisted, true);
  }
  await stop();
  request = await bootstrap(await start());
  const { settings } = await request("settings");
  assert.equal(settings.onboardingCompleted, true);
  assert.equal(settings.analyticsLevel, "off");
  assert.equal(settings.diagnosticReporting, "ask");
  console.log("Web setup smoke passed: bundled assets, fresh control tokens, providers/models, and onboarding persisted across restart.");
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
