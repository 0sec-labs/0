/** Runtimes dropped in 0.35. Their names stay recognised so the failure says what to do instead. */
export const REMOVED_RUNTIMES = ["ollama", "gemini"] as const;

export function removedRuntimeMessage(type: string): string {
  return (REMOVED_RUNTIMES as readonly string[]).includes(type)
    ? `--runtime ${type} was removed in 0.35: use an OpenAI-compatible endpoint with --runtime api ${type === "ollama" ? "(Ollama serves one at http://localhost:11434/v1)" : "(Gemini offers one at https://generativelanguage.googleapis.com/v1beta/openai/)"}.`
    : `Unknown runtime "${type}". Use api, claude, codex or auto.`;
}
