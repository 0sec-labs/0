import { useSyncExternalStore } from "react";

/** Shown instead of the browser's raw "Failed to fetch" when the engine is briefly unreachable. */
export const TRANSIENT_MESSAGE = "Connection interrupted. Reconnecting…";

/** An HTML, empty or otherwise non-JSON answer from an API path: a restarting proxy/host, never a real API result. */
export class NonJsonResponseError extends Error {
  constructor(message: string) { super(message); this.name = "NonJsonResponseError"; }
}

export class TransientNetworkError extends Error {
  constructor(readonly cause?: unknown) { super(TRANSIENT_MESSAGE); this.name = "TransientNetworkError"; }
}

const TRANSIENT_TEXT = /failed to fetch|networkerror|network request failed|load failed|fetch failed|network connection was lost|connection interrupted|socket hang up|econnrefused|econnreset/i;
const TRANSIENT_STATUS = new Set([0, 502, 503, 504]);

/** True for a dropped connection, restart gateway answers (502/503/504) and fetch timeouts; false for cancellation and real API errors. */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TransientNetworkError) return true;
  if (!error || typeof error !== "object") return false;
  const { name, message, status } = error as { name?: string; message?: unknown; status?: unknown };
  if (name === "AbortError") return false;
  if (name === "TimeoutError" || name === "NonJsonResponseError") return true;
  if (typeof status === "number" && name === "ApiError") return TRANSIENT_STATUS.has(status);
  if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true;
  return error instanceof TypeError && TRANSIENT_TEXT.test(typeof message === "string" ? message : "");
}

/** Text-only detection for errors that already reached the UI as strings. */
export const isTransientMessage = (message: string | undefined): boolean => Boolean(message && TRANSIENT_TEXT.test(message));

/** Three retries over about six seconds. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 3000];

export interface RetryOptions {
  signal?: AbortSignal;
  delays?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onFailure?: () => void;
  onSuccess?: () => void;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason ?? new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry an idempotent request across a transient drop. Anything else rethrows immediately; the final transient failure becomes a TransientNetworkError. */
export async function withTransientRetry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await run();
      options.onSuccess?.();
      return result;
    } catch (cause) {
      if (options.signal?.aborted || !isTransientNetworkError(cause)) throw cause;
      options.onFailure?.();
      if (attempt >= delays.length) throw cause instanceof TransientNetworkError ? cause : new TransientNetworkError(cause);
      await sleep(delays[attempt]!, options.signal);
    }
  }
}

/** Tracks a continuous outage so the UI only says "Reconnecting…" when it lasts. */
export const OUTAGE_NOTICE_AFTER_MS = 8000;
export function createOutageTracker(options: { thresholdMs?: number; now?: () => number } = {}) {
  const threshold = options.thresholdMs ?? OUTAGE_NOTICE_AFTER_MS;
  const now = options.now ?? Date.now;
  let since: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const reconnecting = () => since !== null && now() - since >= threshold;
  let snapshot = false;
  const refresh = () => { const next = reconnecting(); if (next !== snapshot) { snapshot = next; emit(); } };
  return {
    failure() {
      if (since === null) { since = now(); timer = setTimeout(refresh, threshold); }
      refresh();
    },
    /** Returns true when this success ended an outage. */
    success(): boolean {
      const was = since !== null;
      since = null;
      clearTimeout(timer);
      refresh();
      return was;
    },
    outage: () => since !== null,
    reconnecting,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const outage = createOutageTracker();
export const useReconnecting = () => useSyncExternalStore(outage.subscribe, outage.getSnapshot, () => false);
