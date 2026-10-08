import type { Finding } from "@0/shared";

export interface EngagementRecord {
  id: string; name: string; description: string; notes?: string;
  scanIds: string[]; createdAt: string; updatedAt: string; revision: number;
  createdBy?: { userId: string; displayName: string };
  updatedBy?: { userId: string; displayName: string };
}
export interface EngagementReport {
  schemaVersion: 1; engagement: EngagementRecord;
  coverage: { scanIds: string[]; kind: "selected-retained-scans" };
  scans: Array<{ id: string; target: string; status: string; startedAt: string; completedAt: string | null; durationMs: number | null; warnings?: Array<{ message: string }>; executionSuccessful?: boolean; exitReason?: string; error?: string }>;
  findingGroups: Array<{ key: string; fingerprint?: string; reviewStatus: "verified" | "rejected" | "unreviewed"; occurrences: Array<{ scanId: string; findingId: string; finding: Finding }> }>;
  summary: { scanCount: number; findingCount: number; uniqueFindingCount: number; verified: number; rejected: number; unreviewed: number };
}
