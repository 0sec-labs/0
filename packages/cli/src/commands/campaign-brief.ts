/**
 * Pure brief generator for `0 campaign` chat iterations.
 *
 * No I/O, no commander, no environment access — the campaign test suite
 * imports this module directly to assert the safety-critical wording
 * (scope reminder, save_finding requirement, no-fabrication rule).
 */

/**
 * Build the operator-authored brief that seeds one campaign chat session.
 * Every safety requirement of the campaign spec is embedded here:
 *   • states the objective,
 *   • lists the concrete tests to try,
 *   • reminds the agent of the scope boundaries (only the scope hosts, no
 *     destructive actions, stay within the authorized identities),
 *   • requires save_finding for anything confirmed,
 *   • forbids fabricating results.
 */
export function buildObjectiveBrief(
  target: string,
  scopeHosts: readonly string[],
  objective: string,
  tests: readonly string[],
  priorFindingTitles: readonly string[],
  iterationIndex: number,
): string {
  const scopeList = scopeHosts.length > 0
    ? scopeHosts.join(", ")
    : "the in_scope rules of the provided scope file";

  const lines: string[] = [];
  lines.push(
    `You are iteration ${iterationIndex} of a self-directed security research campaign against ${target}.`,
  );
  lines.push("");
  lines.push("OBJECTIVE");
  lines.push(objective);
  lines.push("");
  if (tests.length > 0) {
    lines.push("CONCRETE TESTS TO TRY");
    for (const test of tests) lines.push(`- ${test}`);
  } else {
    lines.push(
      "CONCRETE TESTS TO TRY — plan your own specific tests that advance the objective.",
    );
  }
  lines.push("");
  lines.push("SCOPE BOUNDARIES (MANDATORY)");
  lines.push(
    `- Only the scope hosts are authorized for testing: ${scopeList}. Every request must stay inside this boundary.`,
  );
  lines.push(
    "- No destructive actions: do not delete data, corrupt state, exhaust resources, or run denial-of-service techniques.",
  );
  lines.push(
    "- Stay within the authorized identities supplied for this engagement; do not invent or steal credentials.",
  );
  lines.push("");
  if (priorFindingTitles.length > 0) {
    lines.push("FINDINGS ALREADY RECORDED — do not re-report these, probe what they do not cover:");
    for (const title of priorFindingTitles) lines.push(`- ${title}`);
    lines.push("");
  }
  lines.push("REPORTING RULES (MANDATORY)");
  lines.push(
    "- VERIFICATION DUTY: before reporting a critical or high finding, produce hands-on proof of the claimed impact — drive the actual surface (terminal, API, browser) and capture the observable result. Severity claims without a working demonstration must be downgraded in the finding text and marked 'needs verification'.",
  );
  lines.push(
    "- Work fully autonomously: never use ask_operator or wait for operator input — the campaign runs unattended and nobody will answer. Make reasonable decisions yourself and record them.",
  );
  lines.push(
    "- Do not modify files outside your own scratch locations; this machine and repository are shared.",
  );
  lines.push(
    "- Use save_finding for anything you confirm. A confirmed result that is not saved with save_finding is lost from the campaign.",
  );
  lines.push(
    "- Never fabricate results: report only what your tools actually returned. If a probe fails or returns nothing, say so and move on.",
  );
  lines.push(
    "- When the objective is exhausted, summarize what was covered and what you would probe next.",
  );
  return lines.join("\n");
}
