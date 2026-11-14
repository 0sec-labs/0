import { loadEvolutionCampaign } from "./safety.js";
import type { EvolutionConfig } from "./types.js";

/** Only explicit offline safety campaigns call this, before a proposal dispatch. */
export function campaignValidationBudget(config: EvolutionConfig): { executions: number; computeUsd: number; workerUsd: number; proposalUsd: number } {
 const ledger = loadEvolutionCampaign(config.storePath);
 if (ledger.unknownCost || ledger.status === "blocked" || ledger.status === "exhausted") throw new Error("campaign is blocked or exhausted before proposal dispatch");
 // One shortlisted baseline/candidate evaluation plus every declared canary
 // trial. Rejected drafts need not execute canaries, but cannot spend their
 // final validation reserve on proposals instead.
 const executions = config.cases.length * 2 * config.repeats * (1 + config.canaryTrials);
 const workerUsd = executions * (config.safety?.workerModel?.maxCostUsdPerExecution ?? 0);
 const computeUsd = executions * config.timeoutMs / 1000 * config.computeUsdPerSecond;
 const pending = (kind: "model" | "evaluation") => ledger.reservations.filter(record => record.kind === kind && record.state === "reserved").reduce((sum, record) => sum + record.reservedCostUsd, 0);
 const recordCount = executions * (config.safety?.workerModel ? 2 : 1) + config.maxModelTurns;
 if (!Number.isSafeInteger(executions) || recordCount + ledger.reservations.length > 10_000) throw new Error("complete validation exceeds bounded campaign dispatch record capacity");
 if (computeUsd > ledger.maxEvaluationCostUsd - ledger.cumulativeEvaluationCostUsd - pending("evaluation")) throw new Error("campaign evaluation budget cannot reserve complete independent validation");
 const proposalUsd = Math.min(config.maxModelCostUsd, ledger.maxModelCostUsd - ledger.cumulativeModelCostUsd - pending("model")) - workerUsd;
 if (!Number.isFinite(proposalUsd) || proposalUsd <= 0) throw new Error("campaign model budget cannot reserve proposal plus complete worker validation");
 return { executions, computeUsd, workerUsd, proposalUsd };
}
