#!/usr/bin/env node
// Smoke: a compiled `0 scan` with no console running must start its own and get as far as the model.
// v0.41.0 shipped a binary whose scan waited 30 s for a console that never came up. With no provider credential
// the scan fails fast with a credential message, which proves the console started and the thread was created.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: smoke-scan-autostart.mjs <binary>");
const root = mkdtempSync(join(tmpdir(), "0-autostart-"));
try {
  const home = join(root, "home"); const folder = join(root, "app");
  mkdirSync(home, { recursive: true }); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.js"), "module.exports = (x) => eval(x);\n");
  // A clean environment: no provider key, no inherited console.
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const started = Date.now();
  const result = spawnSync(binary, ["scan", folder, "--budget", "0.01", "--timeout", "60"], { env, encoding: "utf8", timeout: 45_000 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failure =
    result.error ? `the scan did not finish: ${result.error.message}` :
    /Could not start a console|console this scan starts for itself stopped/.test(text) ? "the scan could not start its console" :
    !/starting one for this scan/.test(text) ? "the scan did not try to start a console" :
    !/No provider credential|credential|API key/i.test(text) ? "the scan did not reach the model credential check" : "";
  if (failure) { console.error(`scan auto-start smoke failed (${seconds}s): ${failure}\n${text.slice(0, 1500)}`); process.exit(1); }
  console.log(`scan auto-start smoke passed (${seconds}s)`);
} finally { rmSync(root, { recursive: true, force: true }); }
