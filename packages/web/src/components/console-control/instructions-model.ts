/** Mirrors OPERATOR_INSTRUCTIONS_MAX_CHARS in the engine; the server re-enforces it on save. */
export const INSTRUCTIONS_MAX_CHARS = 32_000;

export type InstructionKind = "global" | "workspace";
export interface InstructionFile { kind: InstructionKind; fileName: string; content: string; revision: string; maxChars: number }

export const instructionCounter = (length: number, max = INSTRUCTIONS_MAX_CHARS) => `${length.toLocaleString("en-US")} of ${max.toLocaleString("en-US")}`;

export function instructionDraftState(saved: string, draft: string, max = INSTRUCTIONS_MAX_CHARS): { dirty: boolean; overLimit: boolean; canSave: boolean } {
  const dirty = draft !== saved;
  const overLimit = draft.length > max;
  return { dirty, overLimit, canSave: dirty && !overLimit };
}

export function instructionSummary(content: string): string {
  const length = content.trim().length;
  return length === 0 ? "Empty" : `${length.toLocaleString("en-US")} characters`;
}

export const instructionsUrl = (kind: InstructionKind, workspacePath?: string) =>
  `/api/console/instructions/${kind}${kind === "workspace" && workspacePath ? `?path=${encodeURIComponent(workspacePath)}` : ""}`;

export const instructionSaveBody = (kind: InstructionKind, content: string, revision: string, workspacePath?: string) =>
  JSON.stringify({ content, revision, ...(kind === "workspace" && workspacePath ? { path: workspacePath } : {}) });
