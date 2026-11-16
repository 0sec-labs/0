/**
 * The sidebar "Finish setting up" checklist. Only what a person must do; every step is derived from state the app can really observe;
 * a signal that is still loading or failed is `undefined`, and the card stays hidden rather than guess.
 */
export type SetupStepId = "provider" | "mission";

export interface SetupSignals {
  /** Any connected provider whose diagnostics are valid (GET /api/console/providers). */
  providerConnected?: boolean;
  /** At least one conversation has a message (GET /api/console/sessions). */
  missionStarted?: boolean;
}

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  /** In-app route that finishes the step; `prompt` starts a mission with that first message instead. */
  to?: string;
  prompt?: string;
  /** Button text on the sidebar card. */
  action: string;
}

export interface SetupProgress { steps: SetupStep[]; done: number; total: number; next: SetupStep | null; complete: boolean }

export const MISSION_PROMPT = "Get me set up. Look at the folder I selected and tell me what it contains, then check that my connected model works. Ask which target I am authorized to test first (a repository, a dependency or a web app), and propose one small first task.";

const DEFINITIONS: ReadonlyArray<{ id: SetupStepId; label: string; action: string; to?: string; prompt?: string }> = [
  { id: "provider", label: "Connect a model provider", action: "Connect a provider", to: "/connections" },
  { id: "mission", label: "Start your first {mission}", action: "Ask 0 to get started", prompt: MISSION_PROMPT },
];

/** Null until every signal is known, so an unknown never reads as done or as missing. */
export function deriveSetupProgress(signals: SetupSignals): SetupProgress | null {
  const values: Record<SetupStepId, boolean | undefined> = {
    provider: signals.providerConnected, mission: signals.missionStarted,
  };
  if (Object.values(values).some(value => value === undefined)) return null;
  const steps = DEFINITIONS.map(definition => ({ ...definition, done: values[definition.id] === true }));
  const done = steps.filter(step => step.done).length;
  return { steps, done, total: steps.length, next: steps.find(step => !step.done) ?? null, complete: done === steps.length };
}

/** The card shows only for people who can act on it: everyone locally, owners in team mode. */
export function canSeeSetupCards(team: { enabled: boolean; user?: { role: string } | null }): boolean {
  return !team.enabled || team.user?.role === "owner";
}

export function showSetupCard(progress: SetupProgress | null, dismissed: boolean): progress is SetupProgress {
  return progress !== null && !progress.complete && !dismissed;
}

/**
 * Has the person ever had a thread with a message? Live threads are only the ones open in this run of the app:
 * after a restart earlier threads are saved, so both lists count. Undefined until a list that could say yes has loaded.
 */
export function firstThreadStarted(live: readonly { messageCount?: number }[] | undefined, saved: readonly { messageCount?: number }[] | undefined): boolean | undefined {
  if (live?.some(thread => (thread.messageCount ?? 0) > 0) || saved?.some(thread => (thread.messageCount ?? 0) > 0)) return true;
  return live === undefined || saved === undefined ? undefined : false;
}
