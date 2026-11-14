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
  /** In-app route that finishes the step; `prompt` opens a prefilled mission instead. */
  to?: string;
  prompt?: string;
}

export interface SetupProgress { steps: SetupStep[]; done: number; total: number; next: SetupStep | null; complete: boolean }

const MISSION_PROMPT = "Help me start my first mission with 0. Ask what I want to look at (a repository, a dependency, a web app I am authorized to test), then propose a small first task and run it.";

const DEFINITIONS: ReadonlyArray<{ id: SetupStepId; label: string; to?: string; prompt?: string }> = [
  { id: "provider", label: "Connect a model provider", to: "/connections" },
  { id: "mission", label: "Start your first {mission}", prompt: MISSION_PROMPT },
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
