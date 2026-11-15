import { createHash } from "node:crypto";

/**
 * Whether a provider's credentials actually work, as opposed to merely being present.
 * ok: the provider accepted the key. rejected: it answered 401/403. unreachable: no answer in time.
 * unknown: nothing was proven (no probe exists for this provider, a gateway without a model list, or not probed yet).
 */
export type HealthState = "ok" | "rejected" | "unreachable" | "unknown";
export interface ConnectionHealth { state: HealthState; checking: boolean; checkedAt: number | null }

/** A verdict is reused this long; a transient outage is retried sooner. */
export const HEALTH_TTL_MS = 5 * 60_000;
export const HEALTH_UNREACHABLE_TTL_MS = 30_000;
/** Longest the cheap probe may take; the UI never waits on it. */
export const HEALTH_TIMEOUT_MS = 3_000;

/** Authenticated endpoint that rejects a bad key, for providers whose model list does not. */
export function authProbeUrl(providerId: string, baseUrl: string | undefined): string | undefined {
  if (providerId === "openrouter") return `${baseUrl ?? "https://openrouter.ai/api/v1"}/key`;
  if (providerId === "z-ai" && (!baseUrl || new URL(baseUrl).hostname === "api.z.ai")) return "https://api.z.ai/api/paas/v4/models";
  // Zen's model catalog falls back to a public snapshot, so discovery cannot prove the key.
  if (providerId === "opencode") return `${baseUrl ?? "https://opencode.ai/zen/v1"}/models`;
  return undefined;
}

/** Turn a discovery failure message into a health verdict. */
export function classifyDiscoveryMessage(providerId: string, message: string | undefined): HealthState {
  if (!message) return "ok";
  // xAI answers a wrong key with HTTP 400 "Incorrect API key provided".
  if (/HTTP 40[13]\b/.test(message) || (providerId === "xai" && /HTTP 400\b/.test(message)) || /expired or was rejected/i.test(message)) return "rejected";
  if (/could not reach|timed out|cancelled|fetch failed|ECONN|ENOTFOUND|network/i.test(message)) return "unreachable";
  // Gateways without a /models route (404) or with an unusual catalog cannot be verified this way.
  return "unknown";
}

export function classifyStatus(status: number): HealthState {
  if (status === 401 || status === 403) return "rejected";
  return status >= 200 && status < 300 ? "ok" : "unknown";
}

export interface ProbeDeps {
  discover: (env: Record<string, string>, providerIds: readonly string[], signal?: AbortSignal) => Promise<{ models: Array<{ source?: string }>; diagnostics: Array<{ message: string }> }>;
  fetchImpl?: typeof fetch;
}

/**
 * The one cheap authenticated call used both to validate a key before it is saved and to check an
 * existing connection later. `env` carries the credential being tested.
 */
export async function probeProviderKey(providerId: string, secret: string | undefined, baseUrl: string | undefined, env: Record<string, string>, timeoutMs: number, deps: ProbeDeps): Promise<HealthState> {
  if (providerId === "azure" || providerId === "chatgpt-plan") return "unknown"; // No list endpoint / not a key.
  const url = secret ? authProbeUrl(providerId, baseUrl) : undefined;
  if (url) {
    try {
      const response = await (deps.fetchImpl ?? fetch)(url, { method: "GET", headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      return classifyStatus(response.status);
    } catch { return "unreachable"; }
  }
  const result = await deps.discover(env, [providerId], AbortSignal.timeout(timeoutMs));
  const verdict = classifyDiscoveryMessage(providerId, result.diagnostics[0]?.message);
  // A public-catalog snapshot answers without ever using the key.
  if (verdict === "ok" && result.models.length > 0 && result.models.every(model => model.source === "catalog")) return "unknown";
  return verdict;
}

/** Fingerprint of the credential and endpoint, so a changed key never inherits a stale verdict. */
export function connectionFingerprint(parts: ReadonlyArray<string | undefined>): string {
  return createHash("sha256").update(parts.map(part => part ?? "").join("\u0000")).digest("hex").slice(0, 16);
}

/** Lazy, cached, non-blocking health per provider. */
export class ConnectionHealthMonitor {
  readonly #entries = new Map<string, { fingerprint: string; state: HealthState; at: number }>();
  readonly #running = new Map<string, { fingerprint: string; task: Promise<void> }>();
  #generation = 0;
  constructor(private readonly probe: (providerId: string) => Promise<HealthState>, private readonly now: () => number = Date.now) {}

  /** What is known right now. Starts a background probe when the verdict is missing or stale; never waits for it. */
  read(providerId: string, fingerprint: string): ConnectionHealth {
    const entry = this.#entries.get(providerId);
    const current = entry?.fingerprint === fingerprint ? entry : undefined;
    const fresh = current !== undefined && this.now() - current.at < (current.state === "unreachable" ? HEALTH_UNREACHABLE_TTL_MS : HEALTH_TTL_MS);
    if (!fresh) this.#start(providerId, fingerprint);
    const running = this.#running.get(providerId)?.fingerprint === fingerprint;
    return { state: current?.state ?? "unknown", checking: running, checkedAt: current?.at ?? null };
  }

  /** The last verdict without starting a probe (used where a model list must not trigger network work). */
  peek(providerId: string, fingerprint: string): HealthState {
    const entry = this.#entries.get(providerId);
    return entry?.fingerprint === fingerprint ? entry.state : "unknown";
  }

  /** Resolves when any in-flight probes for these providers have finished (each is bounded by the probe timeout). */
  async settle(providerIds: readonly string[]): Promise<void> {
    await Promise.all(providerIds.map(id => this.#running.get(id)?.task));
  }

  invalidate(): void { this.#generation += 1; this.#entries.clear(); this.#running.clear(); }

  #start(providerId: string, fingerprint: string): void {
    const running = this.#running.get(providerId);
    if (running?.fingerprint === fingerprint) return;
    const generation = this.#generation;
    const task: Promise<void> = this.probe(providerId).catch((): HealthState => "unknown").then(state => {
      if (generation === this.#generation) this.#entries.set(providerId, { fingerprint, state, at: this.now() });
    }).finally(() => { if (this.#running.get(providerId)?.task === task) this.#running.delete(providerId); });
    this.#running.set(providerId, { fingerprint, task });
  }
}
