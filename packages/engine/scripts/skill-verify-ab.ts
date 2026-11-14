/**
 * Level-1 A/B for ZERO_FEATURE_SKILL_VERIFY (frozen candidates, verify stage only).
 *
 *   # 1. cost estimate only, no model calls (default; safe):
 *   pnpm --filter @0/engine exec tsx scripts/skill-verify-ab.ts --candidates <true-candidates.json> --model gpt-5.4
 *
 *   # 2. real run (spends money; requires --execute AND a provider key in env):
 *   pnpm --filter @0/engine exec tsx scripts/skill-verify-ab.ts --candidates <file> --model gpt-5.4 \
 *     --repeats 3 --target https://<authorized-target> --out ./evidence/skill-verify-ab.json --execute
 *
 * <true-candidates.json> = FrozenCandidate[] (label "true", origin "recorded") recorded from one
 * frozen discovery+attack pass, optionally with `oracle` results frozen in `oracles.json` (--oracles).
 * Synthetic false candidates are generated deterministically (bench/skill-verify-ab.ts mutateToFalse).
 * Never prints credentials; auth is taken from the engine's normal env/config, not from flags.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime } from "../src/runtime/index.js";
import type { NativeRuntime } from "../src/runtime/types.js";
import type { ScanConfig } from "../src/shared/index.js";
import { buildDataset, runArm, summarize, compareArms, estimateAbCost, type FrozenCandidate, type CandidateResult } from "../src/bench/skill-verify-ab.js";

const { values: a } = parseArgs({
  options: {
    candidates: { type: "string" }, oracles: { type: "string" }, model: { type: "string", default: "gpt-5.4" },
    runtime: { type: "string", default: "api" }, repeats: { type: "string", default: "3" }, depth: { type: "string", default: "default" },
    target: { type: "string" }, out: { type: "string" }, execute: { type: "boolean", default: false },
  },
});
if (!a.candidates) throw new Error("--candidates <file> is required");
const trues = JSON.parse(readFileSync(a.candidates, "utf8")) as FrozenCandidate[];
const oracleById = a.oracles ? JSON.parse(readFileSync(a.oracles, "utf8")) : undefined;
const dataset = buildDataset(trues);
const repeats = Number(a.repeats);
const nTrue = dataset.filter((c) => c.label === "true").length;
const est = estimateAbCost({ trueN: nTrue, falseN: dataset.length - nTrue, repeats, model: a.model! });
console.log(JSON.stringify({ dataset: { true: nTrue, false: dataset.length - nTrue }, repeats, model: a.model, estimate: est }, null, 2));
if (!a.execute) { console.log("Dry run: pass --execute to spend. (Target >= 100 true + 100 false.)"); process.exit(0); }
if (!a.target) throw new Error("--target is required with --execute (must be an authorized, in-scope target)");

const runtime = createRuntime({ type: a.runtime as "api", timeout: 120_000, model: a.model }) as unknown as NativeRuntime;
const config = { target: a.target, depth: a.depth, format: "json", model: a.model } as ScanConfig;
const runs: Record<"A" | "B", CandidateResult[][]> = { A: [], B: [] };
for (let r = 0; r < repeats; r++) {
  for (const arm of ["A", "B"] as const) runs[arm].push(await runArm({ arm, candidates: dataset, runtime, config, model: a.model, oracleById }));
}
const sA = summarize("A", runs.A.flat()), sB = summarize("B", runs.B.flat());
const report = { model: a.model, repeats, A: sA, B: sB, verdict: compareArms(sA, sB), runs };
if (a.out) { mkdirSync(dirname(a.out), { recursive: true }); writeFileSync(a.out, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ A: sA, B: sB, verdict: report.verdict }, null, 2));
