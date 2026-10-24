import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireEvolutionController } from "../controller-lock.js";
import { campaignPromotionAllowed, createOrLoadEvolutionCampaign, loadEvolutionCampaign, reserveCampaignDispatch, settleCampaignDispatch, type EvolutionComparisonIdentity } from "../safety.js";

const [root, mode] = process.argv.slice(2) as [string, string];
const identity = JSON.parse(readFileSync(join(root, "identity.json"), "utf8")) as EvolutionComparisonIdentity;
const budgets = { maxModelCostUsd: 10, maxEvaluationCostUsd: 10 };
const release = acquireEvolutionController(root);
try {
 const ledger = createOrLoadEvolutionCampaign(root, identity, "subprocess-qualification", budgets);
 if (mode === "resume") {
  let blocked = false;
  try { reserveCampaignDispatch(root, "model", 1); } catch { blocked = true; }
  console.log(JSON.stringify({ blocked, ledger, promotion: campaignPromotionAllowed(root) }));
 } else {
  let reservation;
  if (mode !== "before-dispatch") reservation = reserveCampaignDispatch(root, mode === "during-evaluation" ? "evaluation" : "model", 1);
  if (["after-provider", "during-evaluation", "after-settlement"].includes(mode)) {
   // A deterministic provider boundary: one durable external-observation marker.
   appendFileSync(join(root, "external-calls.log"), JSON.stringify({ reservation: reservation!.id, mode }) + "\n", { mode: 0o600 });
  }
  if (mode === "after-settlement") settleCampaignDispatch(root, reservation!.id, 0.25, "sha256:" + "a".repeat(64));
  writeFileSync(join(root, "ready.json"), JSON.stringify({ pid: process.pid, mode, reservation }), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, mode, ledger: loadEvolutionCampaign(root) }));
  await new Promise(() => { setInterval(() => {}, 1000); });
 }
} finally { release(); }
