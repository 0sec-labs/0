import { strict as assert } from "node:assert";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertPrivateStorage } from "../packages/engine/src/improvement/private-storage.js";

if (process.platform !== "win32") throw new Error("This qualification requires native Windows.");
const directory = mkdtempSync(join(homedir(), "zero-bun-storage-"));
try {
  const file = join(directory, "artifact.json");
  writeFileSync(file, JSON.stringify({ fixture: true }), { mode: 0o600 });
  // Bun's Windows mode bits are synthetic; real profile ACLs are authoritative.
  assertPrivateStorage([{ path: directory, stat: lstatSync(directory) }, { path: file, stat: lstatSync(file) }]);
  execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "pipe", windowsHide: true });
  assert.throws(() => assertPrivateStorage([{ path: file, stat: lstatSync(file) }]), /private Windows ACL/);
  console.log("Compiled Bun Windows ACL qualification passed.");
} finally { rmSync(directory, { recursive: true, force: true }); }
