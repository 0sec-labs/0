#!/usr/bin/env node
/** Real, offline workbench inventory and owned-fixture checks. No provider calls,
 * image pulls or configuration changes. Exit 1 preserves incomplete receipts.
 * node scripts/smoke-smolvm-workbench.mjs IMAGE.tar [core-web|kali] [REPORT.json]
 */
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSmolvm, resolveSmolvmImage } from "../packages/core/dist/runtime/smolvm.js";
import { resolveWorkbenchProfile } from "./workbench-profile.mjs";

assert(process.argv[2], "provide a local image archive");
assert.notEqual(process.getuid?.(), 0, "run qualification as a non-root host user");
const profile = resolveWorkbenchProfile(process.argv[3] ?? "core-web");
const imageArchive = resolve(process.argv[2]);
const imageDigest = await resolveSmolvmImage(imageArchive);
const outputPath = resolve(process.argv[4] ?? `smolvm-${profile.name}-qualification.json`);
const root = mkdtempSync(join(tmpdir(), "0-workbench-qualification-"));
const resources = { cpus: 2, memoryMb: 4096, storageGb: 20, timeoutMs: 240000, maxOutputBytes: 256 * 1024 };
async function guest(profile, expectedUid) {
  const fs = await import("node:fs");
  const cp = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { promisify } = await import("node:util");
  const { assertWorkbenchToolProbe, workbenchProbeFallback } = await import("/qualification/workbench-profile.mjs");
  const run = promisify(cp.execFile);
  const report = { platform: process.platform, arch: process.arch, uid: process.getuid(), profile: profile.name, probes: [], checks: [] };
  fs.mkdirSync("/tmp/qualification-home", { recursive: true });
  process.env.HOME = "/tmp/qualification-home";
  process.env.XDG_CONFIG_HOME = "/tmp/qualification-home/config";
  const check = async (name, action) => { try { await action(); report.checks.push({ name, passed: true }); } catch (error) { report.checks.push({ name, passed: false, diagnostic: String(error.message).slice(0, 500) }); } };
  for (const [name, args, accepted] of profile.probes) {
    let result = cp.spawnSync(name, args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    const fallback = workbenchProbeFallback(name, args, result);
    if (fallback) result = cp.spawnSync(name, fallback, { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    try { const receipt = assertWorkbenchToolProbe(name, result, accepted); report.probes.push({ name, passed: true, exitCode: receipt.exitCode, ...(name === "0" ? { version: receipt.versionOutput } : {}) }); }
    catch (error) { report.probes.push({ name, passed: false, exitCode: result.status, diagnostic: error.message }); }
  }
  await check("non-root Linux ARM64", () => { if (process.platform !== "linux" || process.arch !== "arm64" || process.getuid() !== expectedUid || expectedUid === 0) throw new Error("guest identity mismatch"); });
  await check("Python modules", () => run("python3", ["-c", `import importlib; [importlib.import_module(n) for n in ${JSON.stringify(profile.pythonModules)}]`], { timeout: 10000 }));
  await check("read-only fixture", () => { if (fs.readFileSync("/qualification/fixture.txt", "utf8") !== "owned offline fixture\n") throw new Error("fixture mismatch"); try { fs.writeFileSync("/qualification/fixture.txt", "changed"); throw new Error("source unexpectedly writable"); } catch (error) { if (error.code !== "EROFS") throw error; } });
  await check("native parser", async () => { const { createRequire } = await import("node:module"); const require = createRequire("/opt/0/package.json"); const Parser = require("tree-sitter"); const parser = new Parser(); parser.setLanguage(require("tree-sitter-c")); if (parser.parse("int fixture(void) { return 0; }").rootNode.hasError) throw new Error("parser rejected fixture"); });
  await check("offline browser", async () => { const { chromium } = await import("/opt/0/node_modules/playwright/index.mjs"); const browser = await chromium.launch({ headless: true, timeout: 15000 }); try { const page = await browser.newPage(); await page.setContent("<title>Owned qualification</title>"); if (await page.title() !== "Owned qualification") throw new Error("browser fixture mismatch"); } finally { await browser.close(); } });
  await check("owned loopback HTTP and TCP scan", async () => { const server = createServer((_req, res) => res.end("owned fixture")); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); try { const port = server.address().port; const response = await run("curl", ["--fail", "--silent", `http://127.0.0.1:${port}/`], { timeout: 10000 }); if (response.stdout !== "owned fixture") throw new Error("HTTP fixture mismatch"); const scan = await run("nmap", ["-sT", "-Pn", "-n", "-p", String(port), "127.0.0.1", "-oX", "-"], { timeout: 15000 }); if (!scan.stdout.includes(`portid="${port}"`) || !scan.stdout.includes('state="open"')) throw new Error("scan missed owned listener"); } finally { await new Promise(resolve => server.close(resolve)); } });
  console.log("QUALIFICATION_REPORT " + JSON.stringify(report));
}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), imageDigest, profile: profile.name, network: false, providerCalls: 0, imageDownloads: 0, resources };
try {
  for (const file of ["workbench-profile.mjs", "workbench-profiles.json"]) copyFileSync(new URL(file, import.meta.url), join(root, file));
  writeFileSync(join(root, "fixture.txt"), "owned offline fixture\n");
  writeFileSync(join(root, "guest.mjs"), `(${guest.toString()})(${JSON.stringify(profile)},${process.platform === "darwin" ? process.getuid() : 1000}).catch(error => { console.error(error.message); process.exitCode=1; });`);
  const execution = await runSmolvm({ imageArchive, imageDigest, ...resources, mounts: [{ source: root, target: "/qualification" }], command: ["node", "/qualification/guest.mjs"] });
  report.execution = { exitCode: execution.exitCode, timedOut: execution.timedOut, cleanupFailed: execution.cleanupFailed ?? false, error: execution.error, durationMs: execution.durationMs };
  const marker = execution.stdout.split("\n").find(line => line.startsWith("QUALIFICATION_REPORT "));
  if (marker) report.guest = JSON.parse(marker.slice("QUALIFICATION_REPORT ".length));
  report.outcome = execution.exitCode === 0 && !execution.error && !execution.cleanupFailed && report.guest && [...report.guest.probes, ...report.guest.checks].every(check => check.passed) ? "passed" : "failed";
  if (report.outcome !== "passed") process.exitCode = 1;
} catch (error) { report.outcome = "failed"; report.error = error.message; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (!report.execution?.cleanupFailed) rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome: report.outcome, imageDigest, report: outputPath, failedChecks: report.guest ? [...report.guest.probes, ...report.guest.checks].filter(check => !check.passed).map(check => check.name) : [], execution: report.execution }));
}
