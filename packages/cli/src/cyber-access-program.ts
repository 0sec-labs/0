import { validateCyberAccessProgram } from "@0/core";

/** Recognize explicit intent without silently switching provider or authority. */
export function assertAssessmentAccessProgram(value: unknown, runtime: unknown): void {
  if (value === undefined) return;
  validateCyberAccessProgram(value);
  if (runtime !== "codex") throw new Error("--cyber-access-program requires explicit --runtime codex; selecting a model does not select an access program.");
  throw new Error("--cyber-access-program is not supported by managed scan/review or the direct ChatGPT subscription backend. The Codex exec library adapter supports this selection, but cannot enforce managed source/tool authority. No assessment was started. A qualified native adapter is required; account eligibility and provider acceptance are not implied.");
}
