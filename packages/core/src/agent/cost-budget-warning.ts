/** Dollar warnings are independent of turn limits and never assert a verdict. */
export function createCostBudgetWarnings(limitUsd: number | undefined) {
  let soft = false;
  let hard = false;
  return (spentUsd: number): Array<{ stage: "soft" | "hard"; spentUsd: number; limitUsd: number; message: string }> => {
    if (limitUsd === undefined || !Number.isFinite(limitUsd) || limitUsd <= 0 || !Number.isFinite(spentUsd) || spentUsd < 0 || spentUsd >= limitUsd) return [];
    const warnings: Array<{ stage: "soft" | "hard"; spentUsd: number; limitUsd: number; message: string }> = [];
    if (!soft && spentUsd >= limitUsd * 0.8) {
      soft = true;
      warnings.push({ stage: "soft", spentUsd, limitUsd, message: "[0 cost budget] At least 80% of the inference budget is used. Stop opening new investigation paths. Prioritize checking existing evidence, save relevant browser screenshots, and prepare the report. Budget pressure is not evidence: keep unverified issues and coverage gaps explicit." });
    }
    if (!hard && spentUsd >= limitUsd * 0.9) {
      hard = true;
      warnings.push({ stage: "hard", spentUsd, limitUsd, message: "[0 cost budget] At least 90% of the inference budget is used. Finish only essential checks and finalize the report now. Save findings with their supporting evidence and screenshots, then call done. Do not claim clean or complete coverage for unfinished work." });
    }
    return warnings;
  };
}
