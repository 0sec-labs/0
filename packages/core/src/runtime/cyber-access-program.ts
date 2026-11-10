import type { CyberAccessProgram } from "./types.js";

/** Codex CLI spelling, independent of model IDs and account eligibility. */
export function validateCyberAccessProgram(value: unknown): CyberAccessProgram {
  if (value === "standard" || value === "daybreak_blue" || value === "daybreak_red") return value;
  throw new Error("Invalid cyber access program. Choose standard, daybreak_blue, or daybreak_red.");
}
