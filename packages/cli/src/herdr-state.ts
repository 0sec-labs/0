/**
 * Bridge between the interactive console's operator gates and the herdr
 * pane-state sink.
 *
 * herdr distinguishes `working` from `blocked`, and `blocked` is the state
 * that actually earns its keep: it is what drives the "this agent needs
 * you" attention queue, the sidebar highlight and the toast. 0sec's event
 * bus has no event meaning "waiting on the operator" — the scope-approval
 * and co-pilot gates resolve their promises inline and emit nothing — so
 * the signal has to come from the surface that owns the prompt.
 *
 * The sink instance is created once at CLI bootstrap and parked here so the
 * TUI can reach it without threading a core object through every screen.
 * Everything is a no-op when 0sec is not running inside herdr.
 */

import type { HerdrEventSink } from "@0/core"

let sink: HerdrEventSink | null = null;

/** Called once at bootstrap. Passing null (not under herdr) is fine. */
export function setHerdrSink(next: HerdrEventSink | null): void {
  sink = next;
}

/**
 * Report whether 0sec is currently waiting on a human decision.
 *
 * Never throws: the sink is fail-soft by contract, and an approval prompt
 * must not be able to fail because a pane-decoration socket is unhappy.
 */
export function reportOperatorGate(blocked: boolean): void {
  if (!sink) return;
  try {
    if (blocked) sink.reportBlocked();
    else sink.reportWorking();
  } catch {
    // Telemetry for a pane label must never affect the approval path.
  }
}

// ── Rich pane reporting bridges ───────────────────────────────────────────
//
// These carry CLI-side state that never rides the core event bus (the live
// model/provider, context-window %, compaction, the objective/target topic,
// the agent-session link) into the herdr sink. Every one is a no-op off-herdr
// and swallows: pane chrome must never affect the interactive session.

/** Wrap a sink call so a pane-decoration failure can never surface in the TUI. */
function withSink(fn: (s: NonNullable<typeof sink>) => void): void {
  if (!sink) return;
  try {
    fn(sink);
  } catch {
    // Fail-soft: a pane label is never worth an exception in the UI path.
  }
}

/** The active (live-apply) model, and optionally its resolved provider id. */
export function reportHerdrModel(model: string | null, provider?: string | null): void {
  withSink((s) => s.setModel(model, provider));
}

/** The provider roster (names only). */
export function reportHerdrProviders(providers: readonly string[]): void {
  withSink((s) => s.setProviders(providers));
}

/** Context-window occupancy as a whole-number percent (the status-bar figure). */
export function reportHerdrContextPercent(percent: number | null): void {
  withSink((s) => s.setContextPercent(percent));
}

/** The engagement target/scope — anchors the pane topic. */
export function reportHerdrTarget(target: string | null): void {
  withSink((s) => s.setTarget(target));
}

/** The "what am I working on" objective (session-objective pill). */
export function reportHerdrObjective(objective: string | null): void {
  withSink((s) => s.setObjective(objective));
}

/** The live one-liner (running tool + args, or the fleet activity). */
export function reportHerdrActivity(activity: string | null): void {
  withSink((s) => s.setActivity(activity));
}

/** A compaction just ran (surfaced as a `compactions` count token). */
export function reportHerdrCompaction(): void {
  withSink((s) => s.reportCompacting());
}

/** Link/refresh the pane's agent-session (herdr session lifecycle). */
export function reportHerdrSession(ref: {
  sessionId?: string;
  sessionPath?: string;
  startSource?: string;
}): void {
  withSink((s) => s.reportSession(ref));
}

/**
 * Tell herdr we are releasing this pane's agent slot on exit. Fire-and-forget;
 * the returned promise is best-effort and never rejects.
 */
export function reportHerdrSessionClose(): void {
  withSink((s) => {
    void s.release();
  });
}
