// Diagnostic fixture only. It never changes the production 5s deadline.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateWindowsAcl } from "../packages/core/src/improvement/private-storage.ts";
if (process.platform !== "win32") throw new Error("Native Windows required");
const source = readFileSync(new URL("../packages/core/src/improvement/private-storage.ts", import.meta.url), "utf8");
const script = source.match(/const ACL_SCRIPT = String\.raw`([\s\S]*?)`;/)?.[1];
if (!script) throw new Error("Production ACL script not found");
const root = mkdtempSync(join(homedir(), "zero-storage-measure-"));
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const env = { ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}), ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}), ZERO_STORAGE_ACL_PATHS: JSON.stringify([root]), SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir(), PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
async function probe(label, code, expectPrivate) {
  const start = performance.now();
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { cwd: systemRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const seen = new Set();
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    for (const stage of stderr.match(/ACL_STAGE:[a-z]+/g) ?? []) if (!seen.has(stage)) { seen.add(stage); console.log(JSON.stringify({ label, stage: stage.slice(10), elapsedMs: Math.round(performance.now() - start) })); }
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  clearTimeout(timeout);
  const elapsedMs = Math.round(performance.now() - start);
  let isPrivate = null;
  if (expectPrivate !== undefined && status.code === 0) { const records = JSON.parse(stdout); isPrivate = Array.isArray(records) && records.length === 1 && records.every(isPrivateWindowsAcl); }
  console.log(JSON.stringify({ label, elapsedMs, ...status, isPrivate }));
  if (status.code !== 0 || expectPrivate !== undefined && isPrivate !== expectPrivate) throw new Error(`Fixture ${label} failed; see timing/status only above`);
}
try {
  // The actual production script runs first so the measurement is genuinely cold.
  await probe("cold-production", script, true);
  for (let i = 1; i <= 4; i++) await probe(`warm-production-${i}`, script, true);
  await probe("minimal-host", "[Console]::Error.WriteLine('ACL_STAGE:start'); [Console]::Out.Write('ok')");
  execFileSync("icacls.exe", [root, "/grant", "*S-1-1-0:(R)"], { stdio: "pipe", windowsHide: true });
  await probe("broad-acl-negative", script, false);
} finally { rmSync(root, { recursive: true, force: true }); }
