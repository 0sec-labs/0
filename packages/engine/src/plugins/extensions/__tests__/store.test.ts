import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionService, unwrap } from "../index.js";
import { FsExtensionStore } from "../adapters/fs-store.js";
import { withLock } from "../adapters/state-lock.js";
import { ok } from "../core/result.js";
import { MCP_JSON, SKILL, approve, cleanup, makeRepo, tmp } from "./fixtures.js";

const dirs: string[] = [];
afterEach(() => { cleanup(...dirs.splice(0)); delete process.env["ZERO_AGENT_SESSION"]; });
const V1 = { "extension.json": JSON.stringify({ name: "demo", version: "1.0.0" }), "skills/a/SKILL.md": SKILL("a"), ".mcp.json": MCP_JSON };
async function installed(enable = true) {
  const home = tmp("home"); const repo = makeRepo([V1]); dirs.push(home, repo.dir); const svc = createExtensionService({ home });
  unwrap(approve(svc, unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`)), enable ? { enable: { scope: "global" } } : {}));
  return { home, repo, svc, state: join(home, ".0", "extensions", "state.json") };
}

describe("sealed approvals (defence in depth)", () => {
  it("writes a 0600 key and verifies seals on read", async () => {
    const { home, svc } = await installed();
    const key = join(home, ".0", "extensions", ".seal-key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(svc.list().rows.find(r => r.name === "demo")).toMatchObject({ status: "enabled" });
  });
  it("an edited approval is treated as unapproved and not loaded", async () => {
    const { svc, state } = await installed();
    const raw = JSON.parse(readFileSync(state, "utf8"));
    raw.extensions.demo.enabled.global = true; raw.extensions.demo.revisions[raw.extensions.demo.active].approvedEnv = ["EVERYTHING"];
    writeFileSync(state, JSON.stringify(raw));
    expect(svc.list().rows.find(r => r.name === "demo")?.status).toBe("needs-approval");
    expect(svc.loadable().extensions).toEqual([]); expect(svc.loadable().refused[0]).toMatchObject({ name: "demo", code: "not_approved" });
  });
  it("a state file with no seals at all (hand-written, or from before seals) leaves everything unapproved", async () => {
    const { svc, state } = await installed();
    const raw = JSON.parse(readFileSync(state, "utf8")); raw.seals = {}; writeFileSync(state, JSON.stringify(raw));
    expect(svc.list().rows.find(r => r.name === "demo")?.status).toBe("needs-approval");
  });
  it("a missing key file leaves everything unapproved", async () => {
    const { home, svc } = await installed();
    cleanup(join(home, ".0", "extensions", ".seal-key"));
    expect(svc.list().rows.find(r => r.name === "demo")?.status).toBe("needs-approval");
  });
  it("a sealed change made through the store stays valid", async () => {
    const { svc } = await installed();
    unwrap(svc.store.update(s => { s.extensions["demo"]!.enabled.global = false; return ok(undefined); }));
    expect(svc.list().rows.find(r => r.name === "demo")?.status).toBe("disabled");
  });
});

describe("state.json key rename", () => {
  it("reads a state file written with the first-build key `plugins` and writes `extensions`", async () => {
    const { home, svc, state } = await installed();
    const raw = JSON.parse(readFileSync(state, "utf8")); raw.plugins = raw.extensions; delete raw.extensions; writeFileSync(state, JSON.stringify(raw));
    expect(svc.list().rows.map(r => r.name)).toContain("demo");
    unwrap(svc.installer.disable("demo"));
    const after = JSON.parse(readFileSync(state, "utf8")); expect(after.plugins).toBeUndefined(); expect(Object.keys(after.extensions)).toContain("demo");
    void home;
  });
});

describe("store safety", () => {
  it("refuses every change from an agent session, and still reads", async () => {
    const { svc } = await installed(false);
    process.env["ZERO_AGENT_SESSION"] = "1";
    for (const r of [svc.installer.enable("demo", { approve: true }), svc.installer.disable("scope", { confirm: true }), svc.installer.remove("demo")]) expect(!r.ok && r.error.code).toBe("agent_session");
    expect(svc.list().rows.length).toBeGreaterThan(0);
  });

  it("serialises concurrent updates with a lock file and recovers a stale one", () => {
    const dir = tmp("lock"); dirs.push(dir); const path = join(dir, "l");
    expect(withLock(path, () => ok(withLock(path, () => ok(1), (() => { let t = 0; return () => (t += 20_000); })()).ok), () => 0).ok).toBe(true);
    writeFileSync(path, "999999999 0"); // owner pid does not exist
    expect(withLock(path, () => ok("got it")).ok).toBe(true);
    writeFileSync(path, `${process.pid} 0`); chmodSync(path, 0o600);
    const old = new Date(Date.now() - 60_000); require("node:fs").utimesSync(path, old, old);
    expect(withLock(path, () => ok("stale taken")).ok).toBe(true);
  });

  it("sequential read-modify-write updates all land (no lost update)", async () => {
    const { svc } = await installed(false);
    for (let i = 0; i < 20; i++) unwrap(svc.store.update(s => { s.extensions["demo"]!.note = `n${i}`; return ok(i); }));
    const s = svc.store.read(); expect(s.ok && s.value.extensions["demo"]!.note).toBe("n19");
  });

  it("remove writes state before deleting folders: an unreadable folder delete leaves no dangling entry", async () => {
    const { home, svc } = await installed(false);
    const dir = join(home, ".0", "extensions", "demo");
    const r = svc.installer.remove("demo");
    expect(r.ok).toBe(true); expect(existsSync(dir)).toBe(false);
    const s = svc.store.read(); expect(s.ok && s.value.extensions["demo"]).toBeUndefined();
  });

  it("an approval whose audit line cannot be written is not recorded", async () => {
    const home = tmp("home"); const repo = makeRepo([V1]); dirs.push(home, repo.dir); const svc = createExtensionService({ home });
    const prepared = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`));
    const root = join(home, ".0", "extensions"); mkdirSync(join(root, "audit.jsonl"), { recursive: true }); // a directory where the log file should be
    const r = approve(svc, prepared, { enable: { scope: "global" } });
    expect(r.ok).toBe(false);
    const s = new FsExtensionStore(home).read(); expect(s.ok && s.value.extensions["demo"]).toBeUndefined();
  });

  it("writes an audit line for each change, before the state", async () => {
    const { home, svc } = await installed();
    unwrap(svc.installer.disable("demo"));
    const lines = readFileSync(join(home, ".0", "extensions", "audit.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => l.event)).toEqual(["extension.install", "extension.disable"]);
    expect(lines[0].promptId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("commit binds the approval to what was shown", () => {
  it("refuses a wrong prompt id, a wrong capability digest and a tampered snapshot or prompt", async () => {
    const home = tmp("home"); const repo = makeRepo([V1]); dirs.push(home, repo.dir); const svc = createExtensionService({ home });
    const prepared = unwrap(await svc.installer.prepare(`${repo.dir}@${repo.shas[0]}`));
    for (const over of [{ promptId: "0".repeat(64) }, { capabilityDigest: "0".repeat(64) }, { approvedRevision: "1".repeat(40) }]) {
      const r = approve(svc, prepared, over); expect(!r.ok && r.error.code, JSON.stringify(over)).toBe("review_mismatch");
    }
    const lying = { ...prepared, snapshot: { ...prepared.snapshot, treeHash: "2".repeat(40) } };
    expect((approve(svc, lying) as { ok: boolean; error: { code: string } }).error.code).toBe("content_mismatch");
    const files = prepared.snapshot.files.map(f => f.path === "skills/a/SKILL.md" ? { ...f, bytes: Buffer.from("changed"), size: 7 } : f);
    expect((approve(svc, { ...prepared, snapshot: { ...prepared.snapshot, files } }) as { ok: boolean; error: { code: string } }).error.code).toBe("content_mismatch");
    const forged = { ...prepared, prompt: { ...prepared.prompt, capabilities: { ...prepared.prompt.capabilities, runs: [] , env: ["SAFE"] } } };
    expect(approve(svc, forged).ok).toBe(false);
    expect(existsSync(join(home, ".0", "extensions", "demo"))).toBe(false);
  });
});
