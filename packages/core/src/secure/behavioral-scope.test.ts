import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runBehavioralRepair } from "./behavioral-repair.js";
import type { NativeRuntime } from "../runtime/types.js";
import type { Finding } from "@0/shared";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const before = "exports.lookup = (rows, actor, id) => rows.filter(row => row.id === id);";
const after = "exports.lookup = (rows, actor, id) => rows.filter(row => row.id === id && row.tenantId === actor.tenantId);";
const probe = `import {createRequire} from "node:module"; const require=createRequire(import.meta.url); const {lookup}=require(process.cwd()+'/service/app.cjs'); const rows=[{id:1,tenantId:'own'},{id:1,tenantId:'other'}]; const found=lookup(rows,{tenantId:'own'},1); console.log(JSON.stringify({status:found.some(row=>row.tenantId==='other')?'vulnerable':'safe',controlsPassed:found.some(row=>row.tenantId==='own'),detail:'Actual tenant-isolation comparison'}));`;
function fixture(patch: string, readOutside = false) {
  const root = mkdtempSync(join(tmpdir(), "0-behavioral-scope-")); directories.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, "service"), { recursive: true });
  writeFileSync(join(repo, "service/app.cjs"), before + "\n"); writeFileSync(join(repo, "outside.txt"), "OUTSIDE_SECRET_CONTROL");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture");
  const executeNative = vi.fn().mockResolvedValueOnce({ stopReason: "tool_use", content: [
    ...(readOutside ? [{ type: "tool_use", id: "outside", name: "read_file", input: { path: "outside.txt" } }] : []),
    { type: "tool_use", id: "probe", name: "propose_probe", input: { language: "node", script: probe, description: "Tenant comparison" } },
  ] }).mockResolvedValueOnce({ stopReason: "tool_use", content: [{ type: "tool_use", id: "patch", name: "propose_patch", input: { patch } }] });
  const runtime = { executeNative } as unknown as NativeRuntime;
  const rootCheck = `node -e "if(!require('fs').existsSync('outside.txt'))process.exit(1)"`;
  return { repoRoot: repo, sourcePath: "service", artifactDir: join(root, "artifacts"), runtime,
    finding: { id: "tenant", title: "Tenant lookup", description: "Missing tenant condition", severity: "high", category: "authorization" } as Finding,
    setupCommand: rootCheck, testCommand: rootCheck, maxAttempts: 1, maxTurns: 3, timeoutMs: 10000, executeNative };
}

it("rejects out-of-scope reads and patches without exposing source or touching it", async () => {
  const f = fixture("*** Begin Patch\n*** Add File: outside-new.txt\n+changed\n*** End Patch", true);
  const result = await runBehavioralRepair(f);
  expect(result.status).toBe("not_fixed");
  const attempt = readFileSync(join(f.artifactDir, "attempts.json"), "utf8");
  expect(attempt).toContain("outside the approved scan folder");
  const sent = JSON.stringify(f.executeNative.mock.calls[1]);
  expect(sent).toContain("outside the approved scan folder"); expect(sent).not.toContain("OUTSIDE_SECRET_CONTROL");
  expect(existsSync(join(f.repoRoot, "outside-new.txt"))).toBe(false);
});

it("reproduces and verifies a scoped repair while setup and tests keep repo-root cwd", async () => {
  const f = fixture(`*** Begin Patch\n*** Update File: service/app.cjs\n@@\n-${before}\n+${after}\n*** End Patch`);
  const result = await runBehavioralRepair(f);
  expect(result.status, readFileSync(join(f.artifactDir, "attempts.json"), "utf8")).toBe("verified"); expect(result.changedFiles).toEqual(["service/app.cjs"]);
  expect(result.baseline?.status).toBe("vulnerable"); expect(result.verification?.status).toBe("safe");
  expect(readFileSync(join(f.repoRoot, "service/app.cjs"), "utf8")).toBe(before + "\n");
});
