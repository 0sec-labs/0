import type { FindingGroup } from "../../../types";
import { normalizeSeverity, SEVERITY_ORDER, type SeverityLevel } from "./findings-model";

export type EvidenceArtifactKind = "request" | "response" | "analysis";
export type EvidenceArtifact = { kind: EvidenceArtifactKind; label: string; text: string; lineCount: number };
export type EvidenceItem = {
  fingerprint: string;
  findingId: string;
  title: string;
  severity: SeverityLevel;
  signal: "weak" | "medium" | "strong" | undefined;
  timestamp: number;
  artifacts: EvidenceArtifact[];
};
export type EvidenceFilter = "all" | "traffic" | "analysis";

const LABELS: Record<EvidenceArtifactKind, string> = { request: "Request", response: "Response", analysis: "Analysis" };
const MAX_CHARS = 20_000;

/** Trims, drops blanks and caps pathological payloads so a single card cannot freeze the panel. */
export function clipEvidence(text: string | null | undefined, limit = MAX_CHARS): string {
  const value = (text ?? "").trim();
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated (${value.length - limit} more characters)` : value;
}

function artifact(kind: EvidenceArtifactKind, raw: string | null | undefined): EvidenceArtifact[] {
  const text = clipEvidence(raw);
  return text ? [{ kind, label: LABELS[kind], text, lineCount: text.split("\n").length }] : [];
}

/** Evidence artifacts per finding from the inline record fields. Findings without any evidence are omitted. */
export function buildEvidence(groups: readonly FindingGroup[], filter: EvidenceFilter = "all"): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const group of groups) {
    const { latest } = group;
    const all = [...artifact("request", latest.evidenceRequest), ...artifact("response", latest.evidenceResponse), ...artifact("analysis", latest.evidenceAnalysis)];
    const artifacts = all.filter(item => filter === "all" || (filter === "analysis" ? item.kind === "analysis" : item.kind !== "analysis"));
    if (!artifacts.length) continue;
    items.push({ fingerprint: group.fingerprint, findingId: latest.id, title: latest.title, severity: normalizeSeverity(latest.severity), signal: group.workflow?.evidenceSignal, timestamp: latest.timestamp, artifacts });
  }
  return items.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.timestamp - a.timestamp);
}

export const evidenceArtifactCount = (items: readonly EvidenceItem[]) => items.reduce((sum, item) => sum + item.artifacts.length, 0);
