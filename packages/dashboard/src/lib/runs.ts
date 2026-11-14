import type { RunRecord } from "@0/shared";

export function filterRuns(runs: RunRecord[], query: string): RunRecord[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter(run => {
    const text = [run.id, run.kind, run.title, run.target, run.status].join(" ").toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

/** Resolve canonical links and old scan links without guessing conversation identities. */
export function selectRun(runs: RunRecord[], routeId?: string, fallbackId?: string): RunRecord | undefined {
  const id = routeId ?? fallbackId;
  return runs.find(run => run.id === id) ?? runs.find(run => run.native.scanIds.includes(id ?? ""));
}
