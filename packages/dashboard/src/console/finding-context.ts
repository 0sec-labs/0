import type { RunRecord } from "@0/shared";
import type { FindingGroup, FindingRecord } from "../types";

/** Provenance is additive: later occurrences must not detach the original chat. */
export function findingSourceScanIds(group: FindingGroup): string[] {
  return [...new Set([...(group.sourceScanIds ?? []), group.latest.scanId])];
}

/** Only explicit run provenance links child scans; matching targets never implies ownership. */
export function conversationSourceScanIds(runs: readonly RunRecord[], sessionId: string, savedId?: string): Set<string> {
  const ids = new Set([sessionId, ...(savedId === undefined ? [] : [savedId])]);
  for (const run of runs) {
    if (run.conversation && (run.conversation.sessionId === sessionId || run.conversation.sessionId === savedId)) {
      for (const scanId of run.native.scanIds) ids.add(scanId);
    }
  }
  return ids;
}

export function findingBelongsToChat(group: FindingGroup, sessionId: string, savedId?: string, runs: readonly RunRecord[] = []): boolean {
  const ids = conversationSourceScanIds(runs, sessionId, savedId);
  return findingSourceScanIds(group).some(id => ids.has(id));
}

export function findingsForChat(groups: FindingGroup[], sessionId: string, savedId?: string, runs: readonly RunRecord[] = []): FindingGroup[] {
  const ids = conversationSourceScanIds(runs, sessionId, savedId);
  return groups.filter(group => group.latest.triageStatus !== "suppressed" && findingSourceScanIds(group).some(id => ids.has(id))).sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

/** Other conversations are offered for explicit attachment, never included automatically. */
export function existingFindingsForChat(groups: FindingGroup[], sessionId: string, savedId?: string, query = "", runs: readonly RunRecord[] = []): FindingGroup[] {
  const ids = conversationSourceScanIds(runs, sessionId, savedId);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return groups.filter(group => {
    const { latest, fingerprint } = group;
    if (latest.triageStatus === "suppressed" || findingSourceScanIds(group).some(id => ids.has(id))) return false;
    const searchable = [latest.title, latest.category, latest.severity, latest.status, latest.id, ...findingSourceScanIds(group), fingerprint].join(" ").toLowerCase();
    return terms.every(term => searchable.includes(term));
  }).sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

/** A saved finding is evidence to inspect, not an instruction or proof of impact. */
export function addFindingToDraft(draft: string, finding: FindingRecord): string {
  const marker = `Saved finding: ${finding.id} (scan: ${finding.scanId})`;
  if (draft.includes(marker)) return draft;
  const context = `${marker}\n${JSON.stringify({ title: finding.title, severity: finding.severity, status: finding.status })}\nInspect the stored finding and its evidence before drawing conclusions or proposing next steps.`;
  return draft.trim() ? `${draft}\n\n${context}` : context;
}
