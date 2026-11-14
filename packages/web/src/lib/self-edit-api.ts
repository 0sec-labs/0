import { useCallback, useEffect, useRef, useState } from "react";
import { localControlFetch } from "@/api";

/** Client for /api/console/self-edit/*. All authority (owner-only, opt-in, gates, apply) is enforced server-side. */
export type GateStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export interface GateStep { id: string; label: string; status: GateStatus; durationMs?: number; detail?: string }
export interface GateResult {
  status: "running" | "passed" | "failed";
  steps: GateStep[];
  protected: { ok: boolean; hits: Array<{ path: string; rule: string; reason: string }>; error?: string };
}
export interface PreviewStatus {
  phase: "idle" | "preparing" | "starting" | "running" | "stopping" | "failed";
  branch?: string; worktree?: string; url?: string; error?: string; logTail: string[]; gates?: GateResult;
}
export interface SelfEditStatus {
  enabled: boolean;
  applyAvailable: boolean;
  preview: PreviewStatus;
  protectedAreas: Array<{ id: string; reason: string }>;
}
export interface SelfEditDiff {
  base: string; branch: string; stat: string; patch: string; truncated: boolean;
  files: Array<{ path: string; status: string }>; untracked: string[];
  protected: { ok: boolean; hits: Array<{ path: string; rule: string; reason: string }> };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await localControlFetch(`/api/console/self-edit/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export const selfEditApi = {
  status: () => call<SelfEditStatus>("status"),
  start: (title?: string) => call<{ preview: PreviewStatus }>("start", "POST", title ? { title } : {}),
  stop: (discard = false) => call<{ preview: PreviewStatus }>("stop", "POST", { discard }),
  diff: () => call<{ diff: SelfEditDiff }>("diff"),
  runGates: () => call<{ preview: PreviewStatus }>("gates", "POST", {}),
};

/** Polling interval: fast while something is changing, slow when idle. */
export function pollDelay(status: SelfEditStatus | undefined): number {
  const phase = status?.preview.phase;
  if (phase === "preparing" || phase === "starting" || phase === "stopping" || status?.preview.gates?.status === "running") return 1500;
  return phase === "running" ? 5000 : 10_000;
}

export function useSelfEdit() {
  const [status, setStatus] = useState<SelfEditStatus>();
  const [diff, setDiff] = useState<SelfEditDiff>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const statusRef = useRef<SelfEditStatus | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const next = await selfEditApi.status();
      if (!alive.current) return;
      statusRef.current = next; setStatus(next); setError(undefined);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  const refreshDiff = useCallback(async () => {
    try { const result = await selfEditApi.diff(); if (alive.current) setDiff(result.diff); }
    catch { if (alive.current) setDiff(undefined); }
  }, []);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (statusRef.current?.preview.branch) void refreshDiff();
      if (alive.current && !document.hidden) timer = setTimeout(tick, pollDelay(statusRef.current));
      else if (alive.current) timer = setTimeout(tick, 10_000);
    };
    void tick();
    return () => { alive.current = false; if (timer) clearTimeout(timer); };
  }, [refresh, refreshDiff]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setError(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); await refresh(); }
  }, [refresh]);

  return {
    status, diff, error, busy,
    start: (title?: string) => act(() => selfEditApi.start(title)),
    stop: (discard = false) => act(() => selfEditApi.stop(discard)),
    runGates: () => act(() => selfEditApi.runGates()),
  };
}
