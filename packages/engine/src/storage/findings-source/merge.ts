// Pure merge of per-database family snapshots into one Findings view. No I/O, no database handles.
import { compareFindingsByBusinessPriority, getFindingPriority } from "../../shared/index.js";
import type { FindingFamilyPrioritySummary } from "../finding-priority.js";
import type { FamilyOwner, FindingProvenance, FindingRow, MergedFamily, ScanRow, SourceRef, SourceSnapshot } from "./types.js";

export interface MergeInput<S extends SourceRef = SourceRef> { source: S; snapshot: SourceSnapshot }

function assessment(row: FindingRow): unknown {
  try { return row.impactAssessment ? JSON.parse(row.impactAssessment) : undefined; } catch { return undefined; }
}

/** Same order as a single database ranks its families: business priority, then recency. */
export function compareFamilies(a: FindingFamilyPrioritySummary, b: FindingFamilyPrioritySummary): number {
  const rank = (row: FindingRow) => getFindingPriority({ impactAssessment: assessment(row) as never }).rank;
  const left = { severity: a.latest.severity, cvssScore: a.latest.cvssScore, impactAssessment: assessment(a.latest) as never };
  const right = { severity: b.latest.severity, cvssScore: b.latest.cvssScore, impactAssessment: assessment(b.latest) as never };
  return rank(b.latest) - rank(a.latest) || compareFindingsByBusinessPriority(left, right)
    || b.latest.timestamp - a.latest.timestamp || b.latest.id.localeCompare(a.latest.id);
}

function isNewer(a: FindingRow, b: FindingRow): boolean {
  return a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id > b.id);
}

function parseSummary(scan: ScanRow | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(scan?.summary ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Where a finding came from, derived from the run that saved it. Plain facts only. */
export function classifyProvenance(scanId: string, scan: ScanRow | undefined, source: SourceRef): FindingProvenance {
  if (!scan) return { kind: "unknown", scanId };
  const summary = parseSummary(scan);
  const base = { target: scan.target, startedAt: scan.startedAt, scanId };
  if (summary["ciImport"] || /^ci-[a-f0-9]{64}$/.test(scanId)) return { kind: "ci-import", ...base };
  const agent = typeof summary["agent"] === "string" ? summary["agent"] : typeof summary["agentName"] === "string" ? summary["agentName"] : undefined;
  if (agent) return { kind: "agent", agent, ...base };
  if (scanId.startsWith("console-") || summary["source"] === "console") return { kind: "thread", ...base };
  return source.kind === "run" || scan.target ? { kind: "scan", ...base } : { kind: "unknown", scanId };
}

/**
 * One family per fingerprint across every database. The newest occurrence is the representative;
 * counts, runs, verdicts and active sessions add up; `owners` lists the databases that hold rows.
 */
export function mergeSnapshots(inputs: MergeInput[], limit = 5000): { families: MergedFamily[]; scans: ScanRow[] } {
  const merged = new Map<string, { family: FindingFamilyPrioritySummary; owners: FamilyOwner[]; latestSource: SourceRef }>();
  const scansById = new Map<string, { scan: ScanRow; source: SourceRef }>();
  for (const { source, snapshot } of inputs) {
    for (const scan of snapshot.scans) if (!scansById.has(scan.id)) scansById.set(scan.id, { scan, source });
    for (const family of snapshot.families) {
      const owner: FamilyOwner = { id: source.id, kind: source.kind, scanIds: [...family.sourceScanIds] };
      const current = merged.get(family.key);
      if (!current) { merged.set(family.key, { family: { ...family }, owners: [owner], latestSource: source }); continue; }
      const winner = isNewer(family.latest, current.family.latest);
      const sessions = new Map(current.family.activeSessions.map(session => [session.id, session]));
      for (const session of family.activeSessions) sessions.set(session.id, session);
      const scanIds = [...new Set([...current.family.sourceScanIds, ...family.sourceScanIds])].sort();
      current.family = {
        key: family.key, latest: winner ? family.latest : current.family.latest,
        count: current.family.count + family.count, scanCount: scanIds.length, sourceScanIds: scanIds,
        verdictCounts: {
          truePositive: current.family.verdictCounts.truePositive + family.verdictCounts.truePositive,
          falsePositive: current.family.verdictCounts.falsePositive + family.verdictCounts.falsePositive,
          unsure: current.family.verdictCounts.unsure + family.verdictCounts.unsure,
          total: current.family.verdictCounts.total + family.verdictCounts.total,
        },
        activeSessions: [...sessions.values()],
      };
      current.owners.push(owner);
      if (winner) current.latestSource = source;
    }
  }
  const families = [...merged.values()].map(({ family, owners, latestSource }): MergedFamily => ({
    ...family, owners,
    provenance: classifyProvenance(family.latest.scanId, scansById.get(family.latest.scanId)?.scan, latestSource),
  })).sort(compareFamilies).slice(0, limit);
  const scans = [...scansById.values()].map(item => item.scan).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { families, scans };
}
