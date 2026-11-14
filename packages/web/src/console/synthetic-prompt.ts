/**
 * Engine-injected prompts that arrive as `user` events but were never typed by the operator.
 *
 * Origin: not present in this repository's sources (searched packages/*, docs, dist). The
 * auto-resume prompt is injected by the engine's recovery path without any marker on the
 * `user` event (see `DesktopConsoleEventPayload` in packages/engine/src/shared/desktop-console.ts),
 * so the UI falls back to these anchored patterns. Prefer an explicit `synthetic: true` marker
 * on the event once the engine emits one, then delete the matching pattern here.
 */
export interface SyntheticPromptPattern { kind: SyntheticPromptKind; pattern: RegExp }
export type SyntheticPromptKind = "dropped-connection" | "resume";

export const SYNTHETIC_PROMPT_PATTERNS: readonly SyntheticPromptPattern[] = [
  { kind: "dropped-connection", pattern: /^\s*Continue the existing authorized investigation from the latest retained state\b/i },
  { kind: "dropped-connection", pattern: /^\s*The runtime now handles dropped model connections automatically\b/i },
  { kind: "resume", pattern: /^\s*Resume only genuinely unfinished\b/i },
];

export const SYNTHETIC_PROMPT_LABELS: Record<SyntheticPromptKind, string> = {
  "dropped-connection": "Resumed automatically after a dropped connection",
  resume: "Resumed automatically",
};

/** Classify a user message; an explicit marker on the event wins over text matching. */
export function classifySyntheticPrompt(text: string, marker?: { synthetic?: boolean } | null): SyntheticPromptKind | undefined {
  const matched = SYNTHETIC_PROMPT_PATTERNS.find(entry => entry.pattern.test(text))?.kind;
  if (marker?.synthetic) return matched ?? "resume";
  return matched;
}
