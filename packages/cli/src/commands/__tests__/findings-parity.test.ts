import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { osecDB } from "@0/engine/storage";
import type { Finding } from "@0/engine/shared";
import { registerCommandTree } from "../tree.js";
import { runFindingsExport, type FindingsExportDeps } from "../findings-export.js";
import { registerFindingsKeysCommand, type FindingsKeysDeps } from "../findings-keys.js";
import { FindingsAccessTokenStore } from "../../web/findings-access-tokens.js";
import { openConsole } from "../../console-client.js";

let directory: string; let dbPath: string;
const finding = (id: string): Finding => ({ id, templateId: "source", title: `Finding ${id}`, description: "Issue", severity: "high", category: "path-traversal", status: "confirmed", timestamp: 1800000000000,
  evidence: { request: "src/a.ts:4", response: "evidence", analysis: "Reproduced" } } as Finding);
beforeEach(() => {
  process.exitCode = 0;
  directory = mkdtempSync(join(tmpdir(), "0-cli-parity-"));
  dbPath = join(directory, "findings.db");
  const db = new osecDB(dbPath);
  try { db.createScan({ target: "repo", depth: "deep", format: "json" }, "scan1"); db.saveFinding("scan1", finding("abc12345")); db.saveFinding("scan1", finding("abd99999")); db.completeScan("scan1", { totalAttacks: 1 }); } finally { db.close(); }
});
afterEach(() => { process.exitCode = 0; rmSync(directory, { recursive: true, force: true }); });

function exportDeps() {
  const out: string[] = []; const err: string[] = []; const files = new Map<string, Uint8Array>(); const stdout: Uint8Array[] = [];
  const deps: FindingsExportDeps = { out: t => out.push(t), err: t => err.push(t), writeBytes: (p, b) => { files.set(p, b); }, writeStdout: b => { stdout.push(b); } };
  return { deps, out, err, files, stdout };
}

describe("0 findings export", () => {
  it("is in the command tree", () => {
    const program = new Command(); registerCommandTree(program);
    const findings = program.commands.find(c => c.name() === "findings")!;
    expect(findings.commands.map(c => c.name())).toEqual(expect.arrayContaining(["export", "keys"]));
  });
  it("exports selected findings by prefix as sarif to a file", async () => {
    const h = exportDeps();
    await runFindingsExport(["abc1"], { format: "sarif", output: "/tmp/f.sarif", dbPath }, h.deps);
    expect(process.exitCode).toBe(0);
    const sarif = JSON.parse(Buffer.from(h.files.get("/tmp/f.sarif")!).toString("utf8"));
    expect(sarif.runs[0].results).toHaveLength(1);
  });
  it("exports a whole scan to stdout as markdown", async () => {
    const h = exportDeps();
    await runFindingsExport([], { scan: "scan1", format: "md", dbPath }, h.deps);
    expect(Buffer.concat(h.stdout).toString("utf8")).toContain("Finding abc12345");
  });
  it("exports every finding when no IDs are given, narrowed by a filter", async () => {
    const h = exportDeps();
    await runFindingsExport([], { format: "json", dbPath }, h.deps);
    expect(process.exitCode).toBe(0);
    expect(Buffer.concat(h.stdout).toString("utf8")).toContain("Finding abd99999");
    const high = exportDeps();
    await runFindingsExport([], { format: "md", dbPath, severity: "high" }, high.deps);
    expect(Buffer.concat(high.stdout).toString("utf8")).toContain("Finding abc12345");
  });
  it("reports usage errors with exit 2 and missing findings with exit 1", async () => {
    const h = exportDeps();
    await runFindingsExport([], { format: "json", dbPath, severity: "low" }, h.deps); expect(process.exitCode).toBe(0); // nothing matches the filter: an empty list, not an error
    process.exitCode = 0;
    process.exitCode = 0; await runFindingsExport(["ab"], { format: "json", dbPath }, h.deps); expect(process.exitCode).toBe(2); // ambiguous prefix
    process.exitCode = 0; await runFindingsExport(["zzz"], { format: "json", dbPath }, h.deps); expect(process.exitCode).toBe(1);
    process.exitCode = 0; await runFindingsExport(["abc1"], { format: "pdf", dbPath }, h.deps); expect(process.exitCode).toBe(2);
    process.exitCode = 0; await runFindingsExport(["abc1"], { format: "docx", dbPath }, h.deps); expect(process.exitCode).toBe(2);
  });
});

describe("0 findings keys", () => {
  function keysHarness() {
    const out: string[] = []; const err: string[] = [];
    const store = new FindingsAccessTokenStore({ workspaceId: "ws-test", stateDir: join(directory, "keys") });
    const deps: FindingsKeysDeps = { out: t => out.push(t), err: t => err.push(t), store: () => store };
    const run = async (...argv: string[]) => {
      const program = new Command().exitOverride(); registerFindingsKeysCommand(program.command("findings"), deps);
      await program.parseAsync(["node", "0", "findings", "keys", ...argv]);
    };
    return { out, err, run, store };
  }
  it("creates, lists and revokes a key without ever listing the secret", async () => {
    const h = keysHarness();
    await h.run("create", "ci-reader", "--expires-in", "30");
    const secret = h.out[0]!.trim();
    expect(secret).toMatch(/^0_find_/);
    h.out.length = 0;
    await h.run("list", "--json");
    const listed = JSON.parse(h.out[0]!).credentials as Array<{ id: string; name: string; revokedAt: string | null }>;
    expect(listed).toHaveLength(1); expect(h.out[0]).not.toContain(secret);
    h.out.length = 0;
    await h.run("revoke", listed[0]!.id); expect(process.exitCode).toBe(2); // needs --yes
    await h.run("revoke", listed[0]!.id, "--yes");
    expect(h.store.list()[0]!.revokedAt).not.toBeNull();
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    await h.run("revoke", "00000000-0000-4000-8000-000000000000", "--yes"); expect(process.exitCode).toBe(1);
  });
  it("validates inputs", async () => {
    const h = keysHarness();
    await h.run("create", "x", "--expires-in", "0"); expect(process.exitCode).toBe(2);
    process.exitCode = 0; await h.run("revoke", "not-a-uuid", "--yes"); expect(process.exitCode).toBe(2);
  });
});

describe("console client transport", () => {
  it("fails clearly when no engine is running", async () => {
    await expect(openConsole({}, { connectLocal: async () => null })).rejects.toThrow(/No console running/);
  });
  it("rejects conflicting transport flags", async () => {
    await expect(openConsole({ engineUrl: "http://127.0.0.1:1", computer: "x" })).rejects.toThrow(/cannot be combined/);
    await expect(openConsole({ engineTokenEnv: "T" })).rejects.toThrow(/requires --engine-url/);
  });
  it("passes server errors through with their status", async () => {
    const response = new Response(JSON.stringify({ error: "browser_only" }), { status: 403 });
    const client = await openConsole({}, { connectLocal: async () => ({ backendId: "b", registry: { request: async () => response, dispose() {} } }) });
    await expect(client.request("POST", "/api/console/settings", {})).rejects.toMatchObject({ message: "browser_only", status: 403 });
    client.dispose();
  });
});
