import type { FindingGroup, FindingRecord } from "../types";

export function findingsForChat(groups: FindingGroup[], sessionId: string, savedId?: string): FindingGroup[] {
  return groups.filter(group => group.latest.triageStatus !== "suppressed" && (group.latest.scanId === sessionId || (savedId !== undefined && group.latest.scanId === savedId))).sort((a, b) => b.latest.timestamp - a.latest.timestamp);
}

/** A saved finding is evidence to inspect, not an instruction or proof of impact. */
export function addFindingToDraft(draft: string, finding: FindingRecord): string {
  const marker = `Saved finding: ${finding.id} (scan: ${finding.scanId})`;
  if (draft.includes(marker)) return draft;
  const context = `${marker}\n${JSON.stringify({ title: finding.title, severity: finding.severity, status: finding.status })}\nInspect the stored finding and its evidence before drawing conclusions or proposing next steps.`;
  return draft.trim() ? `${draft}\n\n${context}` : context;
}
