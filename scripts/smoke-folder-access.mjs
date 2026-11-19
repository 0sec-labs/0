// Smoke: a compiled `0` can read a folder. `threads start --folder` checks the folder before it sends anything,
// so no model is needed. Under Bun, Dir.close() returns nothing and a `.catch` on it threw, which made every
// folder look unreadable in the release binary (0.36.0 to 0.40.0) while the node build worked.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const entry = process.argv[2];
if (!entry) throw new Error("Usage: node scripts/smoke-folder-access.mjs <CLI entry or binary>");
const cli = realpathSync(resolve(entry));
const root = realpathSync(mkdtempSync(join(tmpdir(), "0-folder-access-")));
const home = join(root, "home");
const folder = join(root, "project");
mkdirSync(home);
mkdirSync(folder);
writeFileSync(join(folder, "app.js"), "console.log(1)\n");
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
const command = cli.endsWith(".js") ? process.execPath : cli;
const prefix = cli.endsWith(".js") ? [cli] : [];
const run = (args, timeout = 30_000) => spawnSync(command, [...prefix, ...args], { env, encoding: "utf8", timeout });

let host;
try {
  host = spawn(command, [...prefix, "--headless"], { env, stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    await delay(500);
    ready = run(["threads", "list"], 10_000).status === 0;
  }
  assert.ok(ready, "the console did not start");
  const result = run(["threads", "start", "folder smoke", "--folder", folder, "--cost-ceiling", "0.01"]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.ok(!/read that folder/i.test(output), `the compiled binary could not read an ordinary folder:\n${output}`);
  console.log("folder access smoke passed");
} finally {
  if (host && host.exitCode === null) host.kill();
  rmSync(root, { recursive: true, force: true });
}
