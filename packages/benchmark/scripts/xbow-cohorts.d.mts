export interface ReportSource { runId?: number; url?: string; createdAt?: string; artifact?: string; reportFile?: string }
export interface XbowReport { results?: Array<{ id: string; flagFound?: boolean; [key: string]: unknown }>; [key: string]: unknown }
export interface Cohort { id: string; configuredModel: string | null; selectedModel: string | null; mode: string; retries: number | null; repeatN: number | null; attempted: number; solved: number; singleAttemptPolicy: boolean | null; singleRunClaimVerified: false; [key: string]: unknown }
export function aggregateXbowReports(inputs: Array<{report: XbowReport; source: ReportSource}>): {
  schemaVersion: number; aggregation: string; singleRunClaimVerified: false;
  counts: { blackBox: number; whiteBox: number; unknownMode: number; aggregate: number; whiteBoxOnly: number };
  solved: { blackBox: string[]; whiteBox: string[]; unknownMode: string[]; aggregate: string[]; whiteBoxOnly: string[] };
  sources: Record<string, Record<string, unknown[]>>; cohorts: Cohort[];
};
