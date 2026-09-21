/**
 * herdr pane integration (protocol 19).
 *
 * `herdr` (https://herdr.dev) is a terminal workspace manager for AI coding
 * agents. When 0 runs inside a herdr pane, herdr wants to know whether the
 * agent in that pane is `idle | working | blocked` — it drives the sidebar,
 * the completion sounds/toasts and `herdr agent wait` off exactly that signal.
 * Without a native reporter herdr falls back to screen-scraping our TUI and
 * essentially always shows `unknown`.
 *
 * On top of that coarse state, herdr's sidebar/pane chrome can display a rich
 * per-pane picture — the pane's live TOPIC (its title), the model in use, the
 * provider roster, the tool it is running, subagent/task counts, context-window
 * occupancy and the agent-session link. This module reports all of that so a
 * 0 pane is a first-class herdr citizen, on par with oh-my-pi.
 *
 * This module implements a `HerdrEventSink` — a normal `EventSink` (see
 * `../events/bus.ts`) that translates the bus's event vocabulary into herdr
 * pane reports, plus a set of explicit setters the CLI calls for state that
 * never rides the bus (the live-apply model/provider, context %, compaction,
 * the session link). It mirrors the shape, naming and registration style of
 * `CloudEventSink` in `bus.ts`: a passive sink object plus an env-gated
 * factory, OFF unless the environment says otherwise.
 *
 * ── Wire protocol (herdr's authoritative RPC, see herdr `src/api/schema/panes.rs`) ─
 * Transport is a Unix domain socket at `$HERDR_SOCKET_PATH` (a named pipe
 * `\\.\pipe\<path>` on Windows). Framing is newline-delimited JSON, one
 * request per line:
 *
 *     {"id":"…","method":"pane.report_agent","params":{…}}\n
 *
 * and the daemon answers `{"id",…,"result":{…}}` or `{"id",…,"error":{…}}`.
 * We connect per report (herdr's own bundled `pi` reference integration does
 * the same), treat the first `data` frame as "delivered", and never parse the
 * response — there is nothing actionable in it for us.
 *
 * Methods emitted:
 *   - `pane.report_agent`         coarse state (idle/working/blocked) + message
 *   - `pane.report_agent_session` link the pane to the 0 agent session
 *                                 (id/path/start-source) — herdr's session
 *                                 lifecycle signal (started/updated)
 *   - `pane.report_metadata`      the pane TOPIC (`title`) + a `tokens` map
 *                                 (model, provider roster, tool, task/subagent
 *                                 counts, findings, context %, phase, …)
 *   - `pane.release_agent`        we are done owning this pane's agent slot
 *
 * ── Non-negotiables ──────────────────────────────────────────────────────
 *
 *  1. FAIL-SOFT, ALWAYS. This is decoration for a pane title. A missing
 *     socket, a hung daemon, a malformed response or an EPIPE must never
 *     throw into, block, or slow down a security scan. Every path here
 *     swallows. One ~500 ms attempt plus one ~1500 ms retry, then we give up
 *     on that report — no backoff loop, no unbounded queue. Sockets are
 *     `unref`'d so a pending report never keeps the process alive, and the
 *     metadata TTL is clamped to herdr's 24h ceiling.
 *
 *  2. NO PRINTING. 0 runs inside a TUI that owns the terminal; a stray
 *     `console.log` or `process.stderr.write` corrupts the framebuffer. There
 *     is deliberately not a single write to stdout/stderr in this file, not
 *     even on error. Failures are silent by design.
 *
 *  3. CONTENT POLICY — deliberately RICH. This 0 build runs on a single
 *     operator's hardened, boxed pentester machine, and the operator has
 *     explicitly waived the shared-socket privacy concern in favour of full
 *     herdr visibility. We therefore DO send the useful engagement content —
 *     the target/objective as the pane topic, the finding/activity the agent
 *     is on, tool names and their salient args, the model and provider names.
 *     (An earlier build gated all of that behind a `SAFE_TOKEN_KEYS`
 *     allow-list; that gate is intentionally removed here.) We still enforce
 *     herdr's PROTOCOL limits — token keys must match its regex, at most 16
 *     token entries, values and the title are control-stripped and length-
 *     bounded so one report can never wedge the daemon or the pane chrome.
 */

import { createConnection } from "node:net";

import type { EventSink, EventType } from "../events/bus.js";

// ── Protocol constants ──────────────────────────────────────────────────────

/** herdr's four agent states. */
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** Identifies us as the reporter in herdr's sidebar / `herdr agent ls`. */
const HERDR_SOURCE = "0";
const HERDR_AGENT = "0";

/** Protocol 19: `tokens` is a map of at most 16 entries… */
const MAX_TOKENS = 16;
/** …whose keys must each match this (herdr `metadata_token_patch_schema`). */
const TOKEN_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** …and `ttl_ms` must be <= 24h. */
const MAX_TTL_MS = 86_400_000;

/**
 * herdr places no length or content constraint on a token VALUE or on the pane
 * `title` (both are free-form `Option<String>` on the wire). We nonetheless
 * bound them: a token value renders in a narrow sidebar cell and the title in
 * the pane tab, so an unbounded string helps no one and a control character
 * could corrupt the chrome. These are ergonomics, not privacy.
 */
const MAX_TOKEN_VALUE_LEN = 64;
const MAX_TITLE_LEN = 100;

/**
 * How long herdr should keep showing our metadata if we stop reporting.
 * Five minutes: long enough to survive a slow LLM turn, short enough that a
 * crashed scan's stale counters disappear from the sidebar on their own.
 */
const DEFAULT_TTL_MS = 300_000;

/** herdr's reference integration timings: one short attempt, one longer retry. */
const DEFAULT_ATTEMPT_MS = 500;
const DEFAULT_RETRY_MS = 1500;

/**
 * The canonical 0 pipeline phase names (documented on `PhaseStartedPayload`
 * in `bus.ts`). `phase_started` carries `name: string`, so a caller *could*
 * emit an off-script value; anything not in this closed set is ignored so a
 * stray phase name never becomes a pane label.
 */
const PHASE_NAMES: ReadonlySet<string> = new Set([
  "prepare",
  "analyze",
  "research",
  "verify",
  "report",
]);

// ── Injection seams ─────────────────────────────────────────────────────────

/** Minimal env shape — injected so tests never mutate `process.env`. */
export type HerdrEnvLike = Record<string, string | undefined>;

/** The slice of `net.Socket` we actually use. Fakes implement just this. */
export interface HerdrSocketLike {
  on(event: string, listener: (arg?: unknown) => void): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

/** Opens a connection to the herdr socket. MAY throw; callers must swallow. */
export type HerdrSocketFactory = (path: string) => HerdrSocketLike;

export interface HerdrEventSinkOptions {
  /** Override the transport (tests). Defaults to a real `node:net` socket. */
  connect?: HerdrSocketFactory;
  /** First-attempt deadline in ms. */
  attemptTimeoutMs?: number;
  /** Single-retry deadline in ms. */
  retryTimeoutMs?: number;
  /** Metadata TTL; clamped to the protocol's 24h ceiling. */
  ttlMs?: number;
}

/**
 * Real transport. Note `createConnection` can throw synchronously (an empty
 * or absurd path), which is why every call site wraps the factory in a
 * try/catch rather than relying on the socket's `error` event.
 */
function defaultSocketFactory(path: string): HerdrSocketLike {
  const socket = createConnection(normalizeSocketPath(path));
  // Never let a pending telemetry socket keep the CLI process alive after a
  // scan finishes.
  socket.unref();
  return {
    on: (event, listener) => socket.on(event, listener),
    write: (data) => socket.write(data),
    destroy: () => socket.destroy(),
  };
}

/**
 * On Windows the daemon listens on a named pipe; herdr hands us the bare
 * path and expects clients to apply the `\\.\pipe\` prefix themselves.
 */
export function normalizeSocketPath(path: string): string {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\.\\pipe\\")) return path;
  return `\\\\.\\pipe\\${path}`;
}

// ── Sanitizers (exported for direct testing) ────────────────────────────────

/** Clamp `ttl_ms` into the protocol's `(0, 86_400_000]` window. */
export function clampTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return DEFAULT_TTL_MS;
  return Math.min(Math.floor(ttlMs), MAX_TTL_MS);
}

/**
 * Strip control characters, collapse internal whitespace and trim. Shared by
 * the token-value and title bounding so nothing we send can carry a newline
 * (which would break NDJSON framing on a naive reader) or a spinner frame.
 */
function cleanText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bound a pane title/topic: control-stripped, whitespace-collapsed, and capped
 * with an ellipsis. Returns `undefined` for an empty/blank input so the caller
 * omits the field rather than sending an empty title.
 */
export function sanitizeHerdrTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = cleanText(value);
  if (clean.length === 0) return undefined;
  return clean.length > MAX_TITLE_LEN ? `${clean.slice(0, MAX_TITLE_LEN - 1)}…` : clean;
}

/**
 * Enforce every protocol constraint on a token map: an optional key allow-list
 * (default: none — send whatever the caller built), the protocol key regex,
 * value coercion, and the 16-entry cap. Returns a brand new object — the
 * caller's map is never mutated.
 *
 * Values are coerced richly: finite numbers, booleans, and non-empty strings
 * (control-stripped and length-bounded). Unlike an earlier build this does NOT
 * reject strings that contain spaces or look identifying — the operator wants
 * the real content — it only drops values that cannot be represented (objects,
 * arrays, null/undefined, non-finite numbers, blank strings).
 */
export function sanitizeHerdrTokens(
  input: Record<string, unknown>,
  allow: ReadonlySet<string> | null = null,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (count >= MAX_TOKENS) break;
    if (allow && !allow.has(rawKey)) continue;
    if (!TOKEN_KEY_RE.test(rawKey)) continue;
    const value = coerceTokenValue(rawValue);
    if (value === null) continue;
    out[rawKey] = value;
    count++;
  }
  return out;
}

function coerceTokenValue(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Trim float noise so `$0.043200000000000005` doesn't reach a pane cell.
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(4);
    return rounded.length <= MAX_TOKEN_VALUE_LEN ? rounded : null;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    const clean = cleanText(value);
    if (clean.length === 0) return null;
    return clean.length > MAX_TOKEN_VALUE_LEN ? `${clean.slice(0, MAX_TOKEN_VALUE_LEN - 1)}…` : clean;
  }
  return null;
}

// ── Event → state mapping ───────────────────────────────────────────────────

/**
 * Derived from the real `osecEvent` union in `../events/bus.ts`:
 *
 *   working  ← step_started, phase_started, agent_turn_started,
 *              tool_call_started, llm_planner_invoked,
 *              subagent_lifecycle{queued,running},
 *              agent_turn_completed{reason:"continue"}
 *   idle     ← scan_completed,
 *              agent_turn_completed{reason: finished | max_turns | error |
 *                                   cost_ceiling | early_stop}
 *   blocked  ← (nothing on the bus — exposed as `reportBlocked()` for the
 *              operator-gate call sites; see herdr-state.ts in the CLI)
 *
 * WHY `step_completed` / `phase_completed` DO NOT MAP TO `idle`: a phase
 * completing is immediately followed by the next phase starting. Reporting
 * idle there would flap the pane between idle and working several times per
 * scan, and herdr fires a completion sound/toast on every working→idle edge.
 * Only genuinely terminal events (`scan_completed`, a turn that is not
 * continuing) settle us to idle.
 */
function mapEventToState(
  type: EventType,
  payload: Record<string, unknown>,
): HerdrAgentState | null {
  switch (type) {
    case "step_started":
    case "phase_started":
    case "agent_turn_started":
    case "tool_call_started":
    case "llm_planner_invoked":
      return "working";

    case "subagent_lifecycle": {
      const status = payload["status"];
      return status === "queued" || status === "running" ? "working" : null;
    }

    case "agent_turn_completed":
      return payload["reason"] === "continue" ? "working" : "idle";

    case "scan_completed":
      return "idle";

    default:
      return null;
  }
}

// ── HerdrEventSink ──────────────────────────────────────────────────────────

interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface PendingReport {
  state: HerdrAgentState;
  message?: string;
}

/** The agent-session link reported via `pane.report_agent_session`. */
export interface HerdrSessionRef {
  sessionId?: string;
  sessionPath?: string;
  /** Why the session started: `new` | `resume` | `fork` | … (display only). */
  startSource?: string;
}

export class HerdrEventSink implements EventSink {
  private readonly paneId: string;
  private readonly socketPath: string;
  private readonly connect: HerdrSocketFactory;
  private readonly attemptTimeoutMs: number;
  private readonly retryTimeoutMs: number;
  private readonly ttlMs: number;

  /**
   * Monotonic sequence number. Seeded from wall-clock micros exactly like
   * herdr's `pi` integration so that a restarted 0 in the same pane still
   * produces seqs above the ones the daemon already saw — otherwise the
   * daemon drops our first reports as stale.
   */
  private seq = Date.now() * 1000;

  // Single-flight queue: at most ONE report in flight, and at most ONE
  // pending report behind it. A newer state simply overwrites the older
  // pending one — herdr only cares about the LATEST state, so queueing a
  // backlog would just replay history slowly and unboundedly.
  private pendingState: PendingReport | null = null;
  private pendingTokens = false;
  private pendingSession = false;
  private flushPromise: Promise<void> | null = null;
  private lastReported: string | null = null;
  private released = false;

  // Counters, mirrored into `tokens` on every metadata report.
  private findings = 0;
  private toolCalls = 0;
  private turn = 0;
  private maxTurns = 0;
  private costUsd = 0;
  private activeSubagents = 0;
  private compactions = 0;
  private phase: string | null = null;

  // Rich, content-bearing fields (operator waived the shared-socket privacy
  // concern; see the file header). Every one is bounded at report time.
  private model: string | null = null;
  private providers: string | null = null;
  private contextPercent: number | null = null;
  private latestTool: string | null = null;
  /** The pane TOPIC ingredients, composed into `title` by {@link buildTitle}. */
  private target: string | null = null;
  private objective: string | null = null;
  private activity: string | null = null;
  private latestFinding: string | null = null;
  /** The agent-session link, sent via `pane.report_agent_session`. */
  private session: HerdrSessionRef | null = null;

  constructor(paneId: string, socketPath: string, options: HerdrEventSinkOptions = {}) {
    this.paneId = paneId;
    this.socketPath = socketPath;
    this.connect = options.connect ?? defaultSocketFactory;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_MS;
    this.retryTimeoutMs = options.retryTimeoutMs ?? DEFAULT_RETRY_MS;
    this.ttlMs = clampTtlMs(options.ttlMs ?? DEFAULT_TTL_MS);
  }

  /**
   * `EventSink.emit`. Synchronous, allocation-light and total: the whole body
   * is wrapped so that a malformed payload can never propagate into the bus's
   * fan-out (which would print to stderr and corrupt the TUI).
   */
  emit(type: EventType, payload: Record<string, unknown>): void {
    try {
      const changed = this.updateFromEvent(type, payload);
      const state = mapEventToState(type, payload);
      if (state) this.queueState(state);
      // Only re-report metadata when a reported field actually moved. `delta`
      // events fire hundreds of times per turn; without this guard every batch
      // would schedule a socket connection for identical numbers.
      if (changed) this.queueTokens();
    } catch {
      /* fail-soft: telemetry must never break a scan */
    }
  }

  // ── Explicit setters (CLI-side state that never rides the bus) ───────────

  /** The active (live-apply) model, and optionally the resolved provider. */
  setModel(model: string | null, provider?: string | null): void {
    try {
      const nextModel = typeof model === "string" && model.trim() ? model.trim() : null;
      let changed = nextModel !== this.model;
      this.model = nextModel;
      if (provider !== undefined) {
        const nextProvider = typeof provider === "string" && provider.trim() ? provider.trim() : null;
        changed = changed || nextProvider !== this.providers;
        this.providers = nextProvider;
      }
      if (changed) this.queueTokens();
    } catch {
      /* fail-soft */
    }
  }

  /** The provider roster (names only). Joined into one bounded token value. */
  setProviders(providers: readonly string[]): void {
    try {
      const joined = providers.map((p) => String(p).trim()).filter(Boolean).join(",");
      const next = joined.length > 0 ? joined : null;
      if (next === this.providers) return;
      this.providers = next;
      this.queueTokens();
    } catch {
      /* fail-soft */
    }
  }

  /** Context-window occupancy as a whole-number percent (the status-bar figure). */
  setContextPercent(percent: number | null): void {
    try {
      const next =
        typeof percent === "number" && Number.isFinite(percent)
          ? Math.max(0, Math.min(100, Math.round(percent)))
          : null;
      if (next === this.contextPercent) return;
      this.contextPercent = next;
      this.queueTokens();
    } catch {
      /* fail-soft */
    }
  }

  /** The engagement target/scope — the base of the pane topic. */
  setTarget(target: string | null): void {
    this.setTopicField("target", target);
  }

  /** The "what am I working on" objective (session-objective pill). */
  setObjective(objective: string | null): void {
    this.setTopicField("objective", objective);
  }

  /** The live one-liner (running tool + args, or the fleet activity). */
  setActivity(activity: string | null): void {
    this.setTopicField("activity", activity);
  }

  private setTopicField(field: "target" | "objective" | "activity", value: string | null): void {
    try {
      const next = typeof value === "string" && value.trim() ? value.trim() : null;
      if (next === this[field]) return;
      this[field] = next;
      this.queueTokens();
    } catch {
      /* fail-soft */
    }
  }

  /** Note that the compaction path ran (herdr has no compaction method; we
   * surface it as a monotonic `compactions` count token — the truthful,
   * non-flapping representation, since 0 only observes compaction after it
   * completes). */
  reportCompacting(): void {
    try {
      this.compactions++;
      this.queueTokens();
    } catch {
      /* fail-soft */
    }
  }

  /**
   * Link this pane to the 0 agent session, or refresh the link. This is
   * herdr's session-lifecycle signal: the first call after mount is the
   * session "start", later calls (a resume/fork, or a session id becoming
   * known) are "updates". Sends `pane.report_agent_session`.
   */
  reportSession(ref: HerdrSessionRef): void {
    try {
      if (this.released) return;
      const sessionId = ref.sessionId?.trim() || undefined;
      const sessionPath = ref.sessionPath?.trim() || undefined;
      const startSource = ref.startSource?.trim() || undefined;
      if (!sessionId && !sessionPath) return; // nothing to link
      this.session = { sessionId, sessionPath, startSource };
      this.pendingSession = true;
      this.scheduleFlush();
    } catch {
      /* fail-soft */
    }
  }

  /** Explicit state hooks for the operator-gate call sites (see mapping note). */
  reportBlocked(): void {
    this.queueState("blocked");
  }

  reportWorking(): void {
    this.queueState("working");
  }

  /**
   * Tell herdr we are done owning this pane's agent slot. Best-effort and
   * awaited by the caller only if it wants to; like everything else it never
   * throws.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.pendingState = null;
    this.pendingTokens = false;
    this.pendingSession = false;
    await this.drain();
    await this.send({
      id: this.nextId(),
      method: "pane.release_agent",
      params: {
        pane_id: this.paneId,
        source: HERDR_SOURCE,
        agent: HERDR_AGENT,
        seq: this.nextSeq(),
      },
    });
  }

  /** Resolves once the single-flight queue has drained. Never rejects. */
  async drain(): Promise<void> {
    while (this.flushPromise) {
      await this.flushPromise;
    }
  }

  // ── event ingestion ───────────────────────────────────────────────────

  /**
   * The one place bus payloads are read. Updates counters AND the rich topic
   * fields. Returns `true` when a reported field actually changed, so the
   * caller can skip a metadata report for the (very frequent) events that move
   * nothing.
   */
  private updateFromEvent(type: EventType, payload: Record<string, unknown>): boolean {
    switch (type) {
      case "finding_ingested": {
        this.findings++;
        const title = payload["title"];
        if (typeof title === "string" && title.trim()) this.latestFinding = title.trim();
        return true;
      }
      case "tool_call_completed":
        this.toolCalls++;
        return true;
      case "tool_call_started": {
        const tool = payload["tool"];
        const args = payload["args_preview"];
        let changed = false;
        if (typeof tool === "string" && tool.trim()) {
          this.latestTool = tool.trim();
          const line =
            typeof args === "string" && args.trim()
              ? `${this.latestTool} · ${args.trim()}`
              : this.latestTool;
          this.activity = line;
          changed = true;
        }
        return changed;
      }
      case "llm_planner_invoked": {
        const model = payload["model"];
        if (typeof model === "string" && model.trim() && model.trim() !== this.model) {
          this.model = model.trim();
          return true;
        }
        return false;
      }
      case "session_objective": {
        const objective = payload["objective"];
        const next = typeof objective === "string" && objective.trim() ? objective.trim() : null;
        if (next !== this.objective) {
          this.objective = next;
          return true;
        }
        return false;
      }
      case "step_started": {
        const step = payload["step"];
        if (typeof step === "string" && step.trim() && step.trim() !== this.activity) {
          this.activity = step.trim();
          return true;
        }
        return false;
      }
      case "agent_turn_started": {
        const turn = numberOr(payload["turn"], this.turn);
        const maxTurns = numberOr(payload["max_turns"], this.maxTurns);
        const changed = turn !== this.turn || maxTurns !== this.maxTurns;
        this.turn = turn;
        this.maxTurns = maxTurns;
        return changed;
      }
      case "cost_update": {
        const cost = numberOr(payload["cost_usd"], this.costUsd);
        const changed = cost !== this.costUsd;
        this.costUsd = cost;
        return changed;
      }
      case "phase_started": {
        const name = payload["name"];
        const phase = typeof name === "string" && PHASE_NAMES.has(name) ? name : null;
        const changed = phase !== this.phase;
        this.phase = phase;
        return changed;
      }
      case "scan_completed": {
        const findings = numberOr(payload["findings"], this.findings);
        const cost = numberOr(payload["cost_usd"], this.costUsd);
        const changed = findings !== this.findings || cost !== this.costUsd;
        this.findings = findings;
        this.costUsd = cost;
        // A completed scan is no longer actively working a tool.
        this.activity = null;
        return changed;
      }
      case "subagent_lifecycle": {
        const status = payload["status"];
        if (status === "running") {
          this.activeSubagents++;
          return true;
        }
        if (status === "completed" || status === "failed") {
          this.activeSubagents = Math.max(0, this.activeSubagents - 1);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  private buildTokens(): Record<string, string> {
    return sanitizeHerdrTokens({
      findings: this.findings,
      turn: this.turn,
      max_turns: this.maxTurns,
      tools: this.toolCalls,
      cost_usd: this.costUsd,
      subagents: this.activeSubagents,
      ...(this.compactions > 0 ? { compactions: this.compactions } : {}),
      ...(this.phase ? { phase: this.phase } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.providers ? { providers: this.providers } : {}),
      ...(this.latestTool ? { tool: this.latestTool } : {}),
      ...(this.contextPercent !== null ? { ctx: `${this.contextPercent}%` } : {}),
    });
  }

  /**
   * Compose the pane TOPIC (herdr `title`). The target/scope anchors it; the
   * live objective, current finding, or running activity says what is
   * happening on it right now. Returns `undefined` when we have nothing
   * meaningful — the caller then omits the field.
   */
  private buildTitle(): string | undefined {
    const focus = this.objective ?? this.latestFinding ?? this.activity ?? null;
    const composed = this.target && focus ? `${this.target} · ${focus}` : (this.target ?? focus ?? null);
    return sanitizeHerdrTitle(composed);
  }

  // ── single-flight queue ───────────────────────────────────────────────

  private queueState(state: HerdrAgentState): void {
    if (this.released) return;
    // Suppress no-op churn: dozens of `tool_call_started`s in one turn all map
    // to `working`, and re-reporting it would spam the daemon for nothing.
    const key = `${state}|${this.phase ?? ""}`;
    if (key === this.lastReported && this.pendingState === null) return;
    this.pendingState = {
      state,
      ...(this.phase ? { message: this.phase } : {}),
    };
    this.scheduleFlush();
  }

  private queueTokens(): void {
    if (this.released) return;
    this.pendingTokens = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise) return;
    // `flush()` is total (its body is fully guarded), but the extra `.catch`
    // guarantees we can never produce an unhandled rejection in a host that
    // treats those as fatal.
    this.flushPromise = this.flush().catch(() => undefined);
  }

  private async flush(): Promise<void> {
    try {
      while (this.pendingState !== null || this.pendingTokens || this.pendingSession) {
        const state = this.pendingState;
        this.pendingState = null;
        if (state) {
          this.lastReported = `${state.state}|${state.message ?? ""}`;
          await this.send({
            id: this.nextId(),
            method: "pane.report_agent",
            params: {
              pane_id: this.paneId,
              source: HERDR_SOURCE,
              agent: HERDR_AGENT,
              state: state.state,
              ...(state.message ? { message: state.message } : {}),
              seq: this.nextSeq(),
            },
          });
        }
        if (this.pendingSession) {
          this.pendingSession = false;
          const ref = this.session;
          if (ref && (ref.sessionId || ref.sessionPath)) {
            await this.send({
              id: this.nextId(),
              method: "pane.report_agent_session",
              params: {
                pane_id: this.paneId,
                source: HERDR_SOURCE,
                agent: HERDR_AGENT,
                ...(ref.sessionId ? { agent_session_id: ref.sessionId } : {}),
                ...(ref.sessionPath ? { agent_session_path: ref.sessionPath } : {}),
                ...(ref.startSource ? { session_start_source: ref.startSource } : {}),
                seq: this.nextSeq(),
              },
            });
          }
        }
        if (this.pendingTokens) {
          this.pendingTokens = false;
          const title = this.buildTitle();
          await this.send({
            id: this.nextId(),
            method: "pane.report_metadata",
            params: {
              pane_id: this.paneId,
              source: HERDR_SOURCE,
              // The pane TOPIC: target/scope + live focus. Omitted when empty.
              ...(title ? { title } : {}),
              tokens: this.buildTokens(),
              ttl_ms: this.ttlMs,
              seq: this.nextSeq(),
            },
          });
        }
      }
    } catch {
      /* fail-soft */
    } finally {
      this.flushPromise = null;
    }
  }

  // ── transport ─────────────────────────────────────────────────────────

  private nextSeq(): number {
    return ++this.seq;
  }

  private nextId(): string {
    return `0-${this.seq + 1}`;
  }

  /**
   * One attempt, then exactly one retry — matching herdr's own integration.
   * No further backoff: a daemon that ignored two writes is not going to be
   * helped by a third, and the scan is more important than the pane title.
   */
  private async send(request: HerdrRequest): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(request)}\n`;
    } catch {
      return; // unserializable — drop rather than throw
    }
    if (await this.deliver(line, this.attemptTimeoutMs)) return;
    await this.deliver(line, this.retryTimeoutMs);
  }

  /**
   * Connect, write one NDJSON frame, resolve `true` on the first `data` event.
   * NEVER rejects: connect throwing, `write` throwing, `error`, an early
   * `close`, and the timeout all resolve `false`.
   */
  private deliver(line: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let socket: HerdrSocketLike | undefined;

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          socket?.destroy();
        } catch {
          /* already gone */
        }
        resolve(ok);
      };

      timer = setTimeout(() => finish(false), timeoutMs);
      // Don't hold the event loop open on a telemetry deadline.
      (timer as { unref?: () => void }).unref?.();

      try {
        socket = this.connect(this.socketPath);
        socket.on("error", () => finish(false));
        socket.on("close", () => finish(false));
        // We never parse the response. A `{"error":…}` body and a malformed
        // one are equally uninteresting: there is no recovery either way, and
        // parsing is one more thing that could throw on the hot path.
        socket.on("data", () => finish(true));
        socket.on("connect", () => {
          try {
            socket?.write(line);
          } catch {
            finish(false);
          }
        });
      } catch {
        finish(false);
      }
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a `HerdrEventSink`, or `null` when we are not running under herdr.
 *
 * Gating mirrors herdr's reference integration exactly: all three of
 * `HERDR_ENV === "1"`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` must be
 * present. `HERDR_ENV` is compared strictly against `"1"` — a truthy-ish
 * `"true"` or `"0"` is NOT herdr and must not open a socket.
 *
 * The env is injected (defaulting to `process.env`) so tests never have to
 * mutate the real process environment.
 */
export function createHerdrEventSink(
  env: HerdrEnvLike = process.env,
  options: HerdrEventSinkOptions = {},
): HerdrEventSink | null {
  if (env["HERDR_ENV"] !== "1") return null;
  const socketPath = env["HERDR_SOCKET_PATH"];
  const paneId = env["HERDR_PANE_ID"];
  if (!socketPath || !paneId) return null;
  return new HerdrEventSink(paneId, socketPath, options);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
