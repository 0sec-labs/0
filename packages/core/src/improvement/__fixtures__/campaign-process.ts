import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvolutionConfig } from "../config.js";
import { evaluateEvolutionCandidate } from "../evaluation.js";
import { createEvolutionCandidate, snapshotEvolutionSource } from "../registry.js";
import { acquireEvolutionController } from "../controller-lock.js";
import { campaignPromotionAllowed, createOrLoadEvolutionCampaign, loadEvolutionCampaign, reserveCampaignDispatch, settleCampaignDispatch, type EvolutionComparisonIdentity } from "../safety.js";

const [root, mode] = process.argv.slice(2) as [string, string];
const identity = mode === "resume" ? loadEvolutionCampaign(root).comparisonIdentity
 : JSON.parse(readFileSync(join(root, "identity.json"), "utf8")) as EvolutionComparisonIdentity;
const budgets = { maxModelCostUsd: 10, maxEvaluationCostUsd: 10 };
const release = acquireEvolutionController(root);
try {
 if (mode === "during-evaluation") {
  const sourceRoot = root + "-source"; mkdirSync(sourceRoot, { mode: 0o700 });
  writeFileSync(join(sourceRoot, "worker.js"), "export const revision = 1;\n");
  const config = parseEvolutionConfig({ schemaVersion: 1, sourceRoot, storePath: root, image: "node:22-alpine",
   sourcePaths: ["worker.js"], editablePaths: ["worker.js"], command: ["node", "worker.js"], objective: "deterministic process crash fixture",
   promotionPolicy: { minimumCases: 3 }, repeats: 2, canaryTrials: 1, timeoutMs: 1000, computeUsdPerSecond: 0.001,
   safety: { enabled: true, holdoutExposureLimit: 100 },
   cases: ["development", "held-out", "negative-control"].flatMap((lane, group) => [0, 1, 2].map(index => ({ id: `${lane}-${index}`, lane, input: { index, group }, expected: {} }))),
  });
  const baseline = await snapshotEvolutionSource(config);
  const candidate = await createEvolutionCandidate(baseline, { rationale: "fixture change", modelCostUsd: 0,
   edits: [{ path: "worker.js", beforeDigest: baseline.files[0]!.digest, content: "export const revision = 2;\n" }] }, config);
  await evaluateEvolutionCandidate(baseline, candidate, config, {
   modelIdentity: () => ({ provider: "openai", model: "gpt-4o" }),
   sandbox: async () => {
    const reservation = loadEvolutionCampaign(root).reservations.at(-1)!;
    appendFileSync(join(root, "external-calls.log"), JSON.stringify({ reservation: reservation.id, mode }) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ ready: true, mode, actualEvaluationDispatch: true }));
    return await new Promise<never>(() => { setInterval(() => {}, 1000); });
   },
  });
  throw new Error("in-flight fixture unexpectedly returned");
 }
 const ledger = createOrLoadEvolutionCampaign(root, identity, "subprocess-qualification", budgets);
 if (mode === "resume") {
  let blocked = false;
  try { reserveCampaignDispatch(root, "model", 1); } catch { blocked = true; }
  console.log(JSON.stringify({ blocked, ledger, promotion: campaignPromotionAllowed(root) }));
 } else {
  let reservation;
  if (mode !== "before-dispatch") reservation = reserveCampaignDispatch(root, "model", 1);
  if (["after-provider", "after-settlement"].includes(mode)) {
   // A deterministic provider boundary: one durable external-observation marker.
   appendFileSync(join(root, "external-calls.log"), JSON.stringify({ reservation: reservation!.id, mode }) + "\n", { mode: 0o600 });
  }
  if (mode === "after-settlement") settleCampaignDispatch(root, reservation!.id, 0.25, "sha256:" + "a".repeat(64));
  writeFileSync(join(root, "ready.json"), JSON.stringify({ pid: process.pid, mode, reservation }), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, mode, ledger: loadEvolutionCampaign(root) }));
  await new Promise<never>(() => { setInterval(() => {}, 1000); });
 }
} finally { release(); }
