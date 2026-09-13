export type IntelSeverity = "critical" | "high" | "medium" | "low" | "info";

export type IntelSource = "osv" | "nvd" | "cisa-kev" | "github";

export interface IntelReference {
  url: string;
  kind?: string;
  source?: IntelSource;
}

export interface IntelPackage {
  ecosystem: string;
  name: string;
}

export interface IntelCvss {
  score?: number;
  vector?: string;
  version?: string;
}

export interface IntelKev {
  knownExploited: boolean;
  dateAdded?: string;
  dueDate?: string;
  requiredAction?: string;
  ransomwareUse?: string;
  vulnerabilityName?: string;
}

export interface VulnerabilityIntel {
  id: string;
  aliases: string[];
  source: IntelSource;
  sources: IntelSource[];
  summary?: string;
  details?: string;
  package?: IntelPackage;
  affectedRanges: string[];
  fixedVersions: string[];
  severity: IntelSeverity;
  cvss?: IntelCvss;
  cwes: string[];
  references: IntelReference[];
  kev?: IntelKev;
  publishedAt?: string;
  modifiedAt?: string;
  fetchedAt: string;
  /**
   * Target-history relevance (0sec#intel-advisories). Set only by
   * search_target_history when annotating how strongly an advisory matches the
   * target: "high" = exact repo/package match, "medium" = a target token appears
   * as a whole word, "low" = loose keyword-only match. Absent elsewhere.
   */
  matchConfidence?: TargetMatchConfidence;
}

export type TargetMatchConfidence = "high" | "medium" | "low";

export interface AdvisorySearchInput {
  ecosystem: string;
  packageName: string;
  version?: string;
  enrich?: boolean;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export interface IntelDossierInput extends AdvisorySearchInput {
  keywords?: string[];
  similarLimit?: number;
  includeSimilar?: boolean;
}

export interface CveLookupInput {
  cveId: string;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export interface GhsaLookupInput {
  ghsaId: string;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

/**
 * Layer-3 public-report search (0sec#intel-advisories): GitHub issues/PRs that
 * mention a candidate finding's code terms but are not formal advisories. LEADS
 * only — every result is unverified.
 */
export interface PublicReportSearchInput {
  /** GitHub repository as owner/repo, a URL, or a git remote — scopes to `repo:owner/repo`. */
  repository?: string;
  /** Free-text code terms, e.g. "ReplicateToRemote remote blob replicate". */
  terms?: string;
  /** Restrict to issues, pull requests, or both (default: both). */
  type?: "issue" | "pr" | "any";
  limit?: number;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export interface PublicReport {
  title: string;
  url: string;
  state: string;
  number: number;
  isPullRequest: boolean;
  createdAt?: string;
  bodySnippet?: string;
}

export interface PublicReportSearchResult {
  /** The exact `q` string sent to the GitHub search API. */
  query: string;
  /** Total server-side match count (may exceed the returned/bounded `reports`). */
  totalCount: number;
  reports: PublicReport[];
  provenance: {
    source: "github";
    offline?: boolean;
    /** Always true — these are unverified leads, not confirmed vulnerabilities. */
    unverified: true;
  };
}

export interface SimilarSearchInput {
  cwe?: string;
  ecosystem?: string;
  keywords?: string[];
  limit?: number;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export interface TargetHistorySearchInput {
  target?: string;
  repoPath?: string;
  repository?: string;
  ecosystem?: string;
  packageName?: string;
  product?: string;
  vendor?: string;
  keywords?: string[];
  limit?: number;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export interface IntelGraphNode {
  id: string;
  kind: "advisory" | "package" | "version" | "cwe" | "reference" | "kev";
  key: string;
  title?: string;
  data?: Record<string, unknown>;
}

export interface IntelGraphEdge {
  from: string;
  to: string;
  kind:
    | "HAS_ALIAS"
    | "AFFECTS_PACKAGE"
    | "FIXED_IN"
    | "MAPS_TO_CWE"
    | "REFERENCES"
    | "KNOWN_EXPLOITED";
  data?: Record<string, unknown>;
}

export interface IntelGraphSnapshot {
  nodes: IntelGraphNode[];
  edges: IntelGraphEdge[];
}

export interface IntelVariantLead {
  id: string;
  aliases: string[];
  severity: IntelSeverity;
  cwes: string[];
  summary?: string;
  reason: string;
  references: IntelReference[];
}

export interface IntelInvestigationStep {
  id: string;
  title: string;
  rationale: string;
  actions: string[];
  expectedEvidence: string[];
}

export interface IntelPriorVulnerabilityPlaybook {
  id: string;
  bugClass: string;
  cwes: string[];
  priorVulnerabilityIds: string[];
  relevance: string;
  steps: IntelInvestigationStep[];
}

export interface IntelPriorVulnerabilityAuditNode {
  id: string;
  kind: "prior_vulnerability" | "bug_class" | "investigation_step" | "evidence_query";
  key: string;
  title?: string;
  data?: Record<string, unknown>;
}

export interface IntelPriorVulnerabilityAuditEdge {
  from: string;
  to: string;
  kind: "INFORMS" | "HAS_STEP" | "NEXT_STEP" | "SEEKS_EVIDENCE";
  data?: Record<string, unknown>;
}

export interface IntelPriorVulnerabilityAuditGraph {
  entrypointNodeIds: string[];
  nodes: IntelPriorVulnerabilityAuditNode[];
  edges: IntelPriorVulnerabilityAuditEdge[];
}

export interface IntelDossierSummary {
  advisoryCount: number;
  variantLeadCount: number;
  playbookCount: number;
  criticalCount: number;
  highCount: number;
  kevCount: number;
  cweCount: number;
  topSeverity: IntelSeverity;
  riskScore: number;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  recommendedFocus: string[];
}

export interface IntelDossier {
  package: IntelPackage;
  version?: string;
  generatedAt: string;
  summary: IntelDossierSummary;
  advisories: VulnerabilityIntel[];
  variantLeads: IntelVariantLead[];
  playbooks: IntelPriorVulnerabilityPlaybook[];
  auditGraph: IntelPriorVulnerabilityAuditGraph;
  graph: IntelGraphSnapshot;
  provenance: {
    sources: IntelSource[];
    offline?: boolean;
  };
}

export interface IntelTargetHistorySummary {
  advisoryCount: number;
  playbookCount: number;
  criticalCount: number;
  highCount: number;
  kevCount: number;
  cweCount: number;
  topSeverity: IntelSeverity;
  matchedHints: string[];
  /** Count of matched advisories by match confidence (0sec#intel-advisories). */
  confidenceCounts: { high: number; medium: number; low: number };
}

export interface IntelTargetHistory {
  target: {
    target?: string;
    repoPath?: string;
    repository?: string;
    ecosystem?: string;
    packageName?: string;
    product?: string;
    vendor?: string;
    keywords: string[];
  };
  generatedAt: string;
  summary: IntelTargetHistorySummary;
  advisories: VulnerabilityIntel[];
  playbooks: IntelPriorVulnerabilityPlaybook[];
  auditGraph: IntelPriorVulnerabilityAuditGraph;
  graph: IntelGraphSnapshot;
  provenance: {
    sources: IntelSource[];
    offline?: boolean;
  };
}

/**
 * Combined advisory-sweep (0sec#intel-advisories) — "everything in one call".
 * Orchestrates exact GHSA lookups, structured package advisories, repo
 * issue/PR search, and (optionally) target history into one de-duped,
 * confidence-ranked lead list.
 */
export interface AdvisorySweepInput {
  repository?: string;
  ecosystem?: string;
  packageName?: string;
  /** Bug-specific code terms for the issue/PR search (AND-joined). */
  keywords?: string[];
  /** Specific GHSA ids to resolve directly via GET /advisories/{id}. */
  ghsaIds?: string[];
  /** Also run target-history (default false). */
  includeTargetHistory?: boolean;
  /** Per-source result cap (default 15, max 50). */
  limit?: number;
  cacheDir?: string;
  offline?: boolean;
  ttlMs?: number;
}

export type AdvisoryLeadKind = "advisory" | "public_report";

export type AdvisoryLeadSource =
  | "github-advisory"
  | "package-advisory"
  | "github-issue"
  | "target-history";

export interface AdvisoryLead {
  /** GHSA/CVE id for advisories, or the issue/PR URL for public reports. */
  id: string;
  kind: AdvisoryLeadKind;
  confidence: TargetMatchConfidence;
  sources: AdvisoryLeadSource[];
  title?: string;
  url?: string;
  severity?: IntelSeverity;
  aliases?: string[];
  /** Issue/PR fields (public_report leads only). */
  state?: string;
  isPullRequest?: boolean;
  createdAt?: string;
  snippet?: string;
}

export interface AdvisorySweepResult {
  query: {
    repository?: string;
    ecosystem?: string;
    packageName?: string;
    keywords: string[];
    ghsaIds: string[];
  };
  generatedAt: string;
  counts: {
    total: number;
    advisories: number;
    publicReports: number;
    high: number;
    medium: number;
    low: number;
  };
  leads: AdvisoryLead[];
  /** Honest limitation statement — MUST be surfaced to the operator. */
  caveat: string;
  provenance: {
    sources: string[];
    offline?: boolean;
    unverified: true;
  };
}

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}
