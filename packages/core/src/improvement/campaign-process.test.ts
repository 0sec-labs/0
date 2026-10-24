import { createHash } from "node:crypto";
import { build } from "esbuild";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireEvolutionController } from "./controller-lock.js";
import { createOrLoadEvolutionCampaign, loadEvolutionCampaign, reconcileCampaignDispatch, reserveCampaignDispatch, settleCampaignDispatch, type EvolutionComparisonIdentity } from "./safety.js";

const digest = (label: string) => "sha256:" + createHash("sha256").update(label).digest("hex");
const identity: EvolutionComparisonIdentity = {
 schemaVersion: 1, development: { digest: digest("development-fixture"), cases: 1 }, heldOut: { digest: digest("heldout-fixture"), cases: 1 }, negativeControl: { digest: digest("negative-fixture"), cases: 1 },
 evaluatorDigest: digest("synthetic-evaluator"), evaluatorSemantics: digest("synthetic-semantics"), requestedModel: "fixture", resolvedModel: "fixture", provider: "deterministic-fixture",
 harnessRevision: digest("synthetic-harness"), toolRevision: digest("synthetic-tool"), sourceRevision: "sha256:" + "f".repeat(64), evaluatedWorker: { kind: "deterministic" }, compatibilityStatus: "compatible",
};
const budgets = { maxModelCostUsd: 10, maxEvaluationCostUsd: 10 };
let directory: string, executable: string;
beforeAll(async () => {
 directory = mkdtempSync(join(tmpdir(), "0-campaign-process-"));
 executable = join(directory, "probe.js");
 writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
 symlinkSync(new URL("../../node_modules", import.meta.url), join(directory, "node_modules"), "dir");
 await build({ entryPoints: [join(import.meta.dirname, "__fixtures__/campaign-process.ts")], alias: { "@0/shared": join(import.meta.dirname, "../../../shared/src/index.ts") }, bundle: true, packages: "external",
  // Curation's pure fixture validation shares a module with optional scanner
  // entry points. Disable those unused capabilities explicitly in this ledger
  // process fixture; any accidental scanner call must throw, never dispatch.
  plugins: [{ name: "ledger-fixture-no-scanners", setup(builder) {
   builder.onResolve({ filter: /(?:hunt-scan|appsec-catalog|bench\/index)\.js$/ }, args =>
    args.importer.endsWith("/stages/lens-synthesis/validate.ts") ? { path: "disabled-scanners", namespace: "ledger-fixture" } : undefined);
   builder.onLoad({ filter: /.*/, namespace: "ledger-fixture" }, () => ({ contents: 'export function runHuntScan(){throw new Error("scanner disabled in ledger process fixture")}; export const loadAppsecFinderLenses=runHuntScan; export const aggregateScorecard=runHuntScan; export const pickChampion=runHuntScan;', loader: "js" }));
  } }], define: { __ZERO_COMPILED_TARGET__: "undefined" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, platform: "node", format: "esm", outfile: executable, logLevel: "silent" });
});
afterAll(() => {
 const unlock = (path: string) => { chmodSync(path, 0o700); for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(path, entry.name)); };
 unlock(directory); rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
function fresh(): string {
 const root = mkdtempSync(join(directory, "campaign-"));
 writeFileSync(join(root, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
 return root;
}
async function start(root: string, mode: string): Promise<ChildProcess> {
 const child = spawn(process.execPath, [executable, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
 let output = "", errors = "";
 child.stderr!.on("data", data => { errors += data; });
 await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`fixture startup timed out: ${errors}`)); }, 10000);
  child.stdout!.on("data", data => { output += data; if (output.includes('"ready":true')) { clearTimeout(timer); resolve(); } });
  child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${errors}`)); });
 });
 return child;
}
async function kill(child: ChildProcess, root: string): Promise<void> {
 const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
 // Skip the documented 1s partial-owner-record grace without sleeping: this
 // changes only test fixture time, preserving the actual dead PID/inode check.
 utimesSync(join(root, "controller.lock"), new Date(0), new Date(0));
}
function calls(root: string): number { const path = join(root, "external-calls.log"); return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0; }

describe("durable campaign real process recovery", () => {
 it.each(["after-reservation", "after-provider", "during-evaluation"])("blocks blind replay after SIGKILL at %s", async mode => {
  const root = fresh(), child = await start(root, mode);
  try {
   const before = calls(root); await kill(child, root);
   const resumed = spawnSync(process.execPath, [executable, root, "resume"], { encoding: "utf8", timeout: 10000 });
   expect(resumed.status, resumed.stderr).toBe(0);
   const result = JSON.parse(resumed.stdout);
   expect(result.blocked).toBe(true); expect(result.ledger.unknownCost).toBe(true);
   expect(result.promotion.allowed).toBe(false); expect(calls(root)).toBe(before);
   const pending = loadEvolutionCampaign(root).reservations[0]!;
   reconcileCampaignDispatch(root, pending.id, 0.25, "sha256:" + "b".repeat(64));
   expect(loadEvolutionCampaign(root).unknownCost).toBe(false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
 });
 it("recovers a pre-dispatch crash without inventing spend", async () => {
  const root = fresh(), child = await start(root, "before-dispatch"); await kill(child, root);
  const release = acquireEvolutionController(root);
  try { expect(createOrLoadEvolutionCampaign(root, identity, "restarted", budgets).reservations).toEqual([]); expect(calls(root)).toBe(0); }
  finally { release(); }
 });
 it("does not reset completed spend after a crash before the next promotion step", async () => {
  const root = fresh(), child = await start(root, "after-settlement"); await kill(child, root);
  const release = acquireEvolutionController(root);
  try { const ledger = createOrLoadEvolutionCampaign(root, identity, "restarted", budgets); expect(ledger.cumulativeModelCostUsd).toBe(0.25); expect(ledger.unknownCost).toBe(false); expect(calls(root)).toBe(1); }
  finally { release(); }
 });
 it("refuses a competing controller while the first process owns the pass", async () => {
  const root = fresh(), child = await start(root, "before-dispatch");
  try {
   expect(() => acquireEvolutionController(root)).toThrow(/controller/);
   expect(() => createOrLoadEvolutionCampaign(root, identity, "competing", budgets)).toThrow(/another controller/);
   expect(calls(root)).toBe(0);
  } finally { await kill(child, root); }
 });
 it("treats an old pass lease as unknown even when its numeric PID matches", () => {
  const root = fresh(); let release = acquireEvolutionController(root);
  createOrLoadEvolutionCampaign(root, identity, "first-pass", budgets);
  const reservation = reserveCampaignDispatch(root, "model", 1); release();
  const path = join(root, "campaign-ledger.json"), raw = JSON.parse(readFileSync(path, "utf8"));
  raw.reservations[0].ownerLeaseId = "prior-pass"; chmodSync(path, 0o600); writeFileSync(path, JSON.stringify(raw));
  release = acquireEvolutionController(root);
  try {
   const resumed = createOrLoadEvolutionCampaign(root, identity, "new-pass", budgets);
   expect(resumed.unknownCost).toBe(true);
   expect(() => reserveCampaignDispatch(root, "model", 1)).toThrow(/blocked/);
   expect(resumed.reservations[0]!.id).toBe(reservation.id);
  } finally { release(); }
 });
 it("records real reservation/settlement latency and bounded storage growth", () => {
  const root = fresh(), release = acquireEvolutionController(root);
  try {
   createOrLoadEvolutionCampaign(root, identity, "io-study", budgets);
   const reserve: number[] = [], settle: number[] = [];
   for (let i = 0; i < 100; i++) {
    let start = performance.now(); const record = reserveCampaignDispatch(root, "model", 0.01); reserve.push(performance.now() - start);
    start = performance.now(); settleCampaignDispatch(root, record.id, 0.001, "sha256:" + "c".repeat(64)); settle.push(performance.now() - start);
   }
   const stats = (values: number[]) => { values.sort((a,b) => a-b); return { p50Ms: values[49], p95Ms: values[94], maxMs: values.at(-1) }; };
   const ledger = loadEvolutionCampaign(root);
   expect(ledger.reservations).toHaveLength(100); expect(ledger.cumulativeModelCostUsd).toBeCloseTo(0.1);
   if (process.env.CAMPAIGN_IO_REPORT) writeFileSync(process.env.CAMPAIGN_IO_REPORT, JSON.stringify({ schemaVersion: 1, platform: process.platform, node: process.version, dispatches: 100, reservation: stats(reserve), settlement: stats(settle), ledgerBytes: readFileSync(join(root, "campaign-ledger.json")).length, ordinaryScanModelCalls: 0, externalProviderCalls: 0 }, null, 2) + "\n");
  } finally { release(); }
 });
});
