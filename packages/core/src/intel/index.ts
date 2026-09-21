import { lookupKev } from "./cisa-kev.js";
import { lookupGitHubAdvisory, queryGitHubAdvisories } from "./github.js";
import { searchGitHubIssues } from "./github-issues.js";
import { mergeIntel, normalizeCveId, toGraphSnapshot, uniqueStrings } from "./normalize.js";
import { lookupNvdCve, searchNvdSimilar, searchNvdTargetHistory } from "./nvd.js";
import { queryOsvAdvisories } from "./osv.js";
import { buildIntelDossierFromSearch } from "./dossier.js";
import { buildTargetHistoryResult, resolveTargetHistoryInput } from "./target-history.js";
import type {
  AdvisoryLead,
  AdvisorySearchInput,
  AdvisorySweepInput,
  AdvisorySweepResult,
  CveLookupInput,
  FetchOptions,
  GhsaLookupInput,
  IntelDossier,
  IntelDossierInput,
  IntelGraphSnapshot,
  IntelSeverity,
  IntelTargetHistory,
  PublicReportSearchInput,
  PublicReportSearchResult,
  SimilarSearchInput,
  TargetHistorySearchInput,
  VulnerabilityIntel,
} from "./types.js";

export type {
  AdvisoryLead,
  AdvisorySearchInput,
  AdvisorySweepInput,
  AdvisorySweepResult,
  CveLookupInput,
  FetchOptions,
  GhsaLookupInput,
  IntelCvss,
  IntelDossier,
  IntelDossierInput,
  IntelDossierSummary,
  IntelGraphEdge,
  IntelGraphNode,
  IntelGraphSnapshot,
  IntelInvestigationStep,
  IntelKev,
  IntelPackage,
  IntelPriorVulnerabilityAuditEdge,
  IntelPriorVulnerabilityAuditGraph,
  IntelPriorVulnerabilityAuditNode,
  IntelPriorVulnerabilityPlaybook,
  IntelReference,
  IntelSeverity,
  IntelSource,
  IntelTargetHistory,
  IntelTargetHistorySummary,
  IntelVariantLead,
  PublicReport,
  PublicReportSearchInput,
  PublicReportSearchResult,
  SimilarSearchInput,
  TargetHistorySearchInput,
  TargetMatchConfidence,
  VulnerabilityIntel,
} from "./types.js";

export { IntelCache, defaultIntelCacheDir } from "./cache.js";
export { queryOsvAdvisories, parseOsvResponse, toOsvEcosystem } from "./osv.js";
export { lookupNvdCve, parseNvdResponse, searchNvdSimilar, searchNvdTargetHistory } from "./nvd.js";
export { lookupKev } from "./cisa-kev.js";
export { queryGitHubAdvisories, parseGitHubAdvisories, lookupGitHubAdvisory, normalizeGhsaId } from "./github.js";
export { searchGitHubIssues, buildPublicReportQuery } from "./github-issues.js";
export { mergeIntel, toGraphSnapshot } from "./normalize.js";
export { buildPriorVulnerabilityAuditGraph } from "./audit-graph.js";
export { formatTargetHistoryForPrompt } from "./prompt.js";
export { buildTargetHistoryResult, inferTargetHistoryInputFromRepo, normalizeRepositoryHint, resolveTargetHistoryInput, targetHistoryHints } from "./target-history.js";

export async function buildIntelDossier(
  input: IntelDossierInput,
  opts: FetchOptions = {},
): Promise<IntelDossier> {
  return await buildIntelDossierFromSearch(input, searchAdvisories, searchSimilar, opts);
}

export async function searchAdvisories(
  input: AdvisorySearchInput,
  opts: FetchOptions = {},
): Promise<{ advisories: VulnerabilityIntel[]; graph: IntelGraphSnapshot }> {
  const sources = ["queryOsvAdvisories", "queryGitHubAdvisories"] as const;
  const results = await Promise.allSettled([
    queryOsvAdvisories(input, opts),
    queryGitHubAdvisories(input, opts),
  ]);
  warnRejectedSources(sources, results, { ecosystem: input.ecosystem, packageName: input.packageName });
  const packageAdvisories = mergeIntel(
    results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  );
  const advisoryLeads = packageAdvisories.length === 0
    ? await goStdlibNvdFallback(input, opts)
    : [];
  const advisories = mergeIntel([...packageAdvisories, ...advisoryLeads]);

  if (input.enrich !== false) {
    const enriched = await enrichCveAliases(advisories, input, opts);
    const merged = mergeIntel([...advisories, ...enriched]);
    return { advisories: merged, graph: toGraphSnapshot(merged) };
  }

  return { advisories, graph: toGraphSnapshot(advisories) };
}

export async function lookupCve(
  input: CveLookupInput,
  opts: FetchOptions = {},
): Promise<VulnerabilityIntel | null> {
  const cveId = normalizeCveId(input.cveId);
  const [nvdResult, kevResult] = await Promise.allSettled([
    lookupNvdCve({ ...input, cveId }, opts),
    lookupKev({ ...input, cveId }, opts),
  ]);
  warnRejectedSources(["lookupNvdCve", "lookupKev"], [nvdResult, kevResult], { cveId });
  const nvd = nvdResult.status === "fulfilled" ? nvdResult.value : null;
  const kev = kevResult.status === "fulfilled" ? kevResult.value : null;
  if (!nvd && !kev) return null;
  if (!nvd) {
    const now = new Date().toISOString();
    return {
      id: cveId,
      aliases: [cveId],
      source: "cisa-kev",
      sources: ["cisa-kev"],
      affectedRanges: [],
      fixedVersions: [],
      severity: "info",
      cwes: [],
      references: [],
      kev: kev ?? undefined,
      fetchedAt: now,
    };
  }
  return {
    ...nvd,
    sources: kev ? mergeSources(nvd.sources, ["cisa-kev"]) : nvd.sources,
    kev: kev ?? nvd.kev,
  };
}

export async function searchSimilar(
  input: SimilarSearchInput,
  opts: FetchOptions = {},
): Promise<{ advisories: VulnerabilityIntel[]; graph: IntelGraphSnapshot }> {
  const advisories = mergeIntel(await searchNvdSimilar(input, opts));
  return { advisories, graph: toGraphSnapshot(advisories) };
}

export async function searchTargetHistory(
  input: TargetHistorySearchInput,
  opts: FetchOptions = {},
): Promise<IntelTargetHistory> {
  const resolvedInput = resolveTargetHistoryInput(input);
  const packageLookup = resolvedInput.ecosystem && resolvedInput.packageName
    ? searchAdvisories({
      ecosystem: resolvedInput.ecosystem,
      packageName: resolvedInput.packageName,
      enrich: false,
      cacheDir: resolvedInput.cacheDir,
      offline: resolvedInput.offline,
      ttlMs: resolvedInput.ttlMs,
    }, opts)
    : Promise.resolve({ advisories: [], graph: { nodes: [], edges: [] } });
  const results = await Promise.allSettled([
    packageLookup,
    searchNvdTargetHistory(resolvedInput, opts),
  ]);
  warnRejectedSources(["searchAdvisories", "searchNvdTargetHistory"], results, {
    target: resolvedInput.target,
    repository: resolvedInput.repository,
    packageName: resolvedInput.packageName,
    product: resolvedInput.product,
  });
  const packageResult = results[0]?.status === "fulfilled" ? results[0].value.advisories : [];
  const nvdAdvisories = results[1]?.status === "fulfilled" ? results[1].value : [];
  return buildTargetHistoryResult(resolvedInput, [...packageResult, ...nvdAdvisories]);
}

/**
 * Direct GHSA lookup (0#intel-advisories). Resolves a specific advisory id
 * via GET /advisories/{ghsa_id} — the reliable endpoint. We never fall back to
 * free-text advisories?query= (unreliable).
 */
export async function lookupAdvisory(
  input: GhsaLookupInput,
  opts: FetchOptions = {},
): Promise<VulnerabilityIntel | null> {
  return await lookupGitHubAdvisory(input, opts);
}

/**
 * Layer-3 public-report search (0#intel-advisories): GitHub issues/PRs that
 * mention a candidate finding's code terms. LEADS ONLY — unverified.
 */
export async function searchPublicReports(
  input: PublicReportSearchInput,
  opts: FetchOptions = {},
): Promise<PublicReportSearchResult> {
  return await searchGitHubIssues(input, opts);
}

/** Broad repo-level qualifiers run before the caller's bug-specific keywords. */
const BROAD_REPORT_TERMS =
  "security OR vulnerability OR CVE OR GHSA OR SSRF OR auth OR traversal OR injection OR memory OR DoS";

const SWEEP_CAVEAT =
  "LEADS ONLY — 'no public duplicate found' is NOT 'definitely unique'. Private/draft GitHub " +
  "advisories, embargoed advisories, HackerOne (and other bug-bounty) reports, and internal " +
  "tickets are invisible to this sweep. Verify local reachability before reporting a new bug.";

/**
 * One-call advisory sweep (0#intel-advisories). Orchestrates every coverage
 * layer, de-dupes across sources, and ranks leads by confidence:
 *   1. exact GHSA-id lookups (high)
 *   2. structured package advisories via ecosystem+affects (high)
 *   3. broad repo issue/PR search, then bug-specific keyword search (low)
 *   4. optional target history (carries its own per-advisory confidence)
 */
export async function advisorySweep(
  input: AdvisorySweepInput,
  opts: FetchOptions = {},
): Promise<AdvisorySweepResult> {
  const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.trunc(input.limit), 1), 50) : 15;
  const ghsaIds = uniqueStrings(input.ghsaIds ?? []);
  const keywords = uniqueStrings(input.keywords ?? []);
  const shared = { cacheDir: input.cacheDir, offline: input.offline, ttlMs: input.ttlMs };

  const advisoryTasks: Array<{ label: string; run: () => Promise<VulnerabilityIntel[]> }> = [];
  for (const ghsaId of ghsaIds) {
    advisoryTasks.push({
      label: `lookupAdvisory(${ghsaId})`,
      run: async () => {
        const advisory = await lookupAdvisory({ ghsaId, ...shared }, opts);
        return advisory ? [advisory] : [];
      },
    });
  }
  if (input.ecosystem && input.packageName) {
    advisoryTasks.push({
      label: "searchAdvisories",
      run: async () => (await searchAdvisories({
        ecosystem: input.ecosystem!,
        packageName: input.packageName!,
        enrich: false,
        ...shared,
      }, opts)).advisories,
    });
  }

  const reportTasks: Array<{ label: string; run: () => Promise<PublicReportSearchResult> }> = [];
  if (input.repository) {
    reportTasks.push({
      label: "searchPublicReports(broad)",
      run: () => searchPublicReports({ repository: input.repository, terms: BROAD_REPORT_TERMS, limit, ...shared }, opts),
    });
    if (keywords.length > 0) {
      reportTasks.push({
        label: "searchPublicReports(keywords)",
        run: () => searchPublicReports({ repository: input.repository, terms: keywords.join(" "), limit, ...shared }, opts),
      });
    }
  }

  const historyTask = input.includeTargetHistory && (input.repository || input.packageName)
    ? searchTargetHistory({ repository: input.repository, ecosystem: input.ecosystem, packageName: input.packageName, keywords, limit, ...shared }, opts)
    : Promise.resolve(null);

  const [advisoryResults, reportResults, historyResult] = await Promise.all([
    Promise.allSettled(advisoryTasks.map((task) => task.run())),
    Promise.allSettled(reportTasks.map((task) => task.run())),
    historyTask.catch((reason) => {
      console.warn("[intel] advisorySweep target-history failed", { reason: reason instanceof Error ? reason.message : String(reason) });
      return null;
    }),
  ]);
  warnRejectedSources(advisoryTasks.map((task) => task.label), advisoryResults, { sweep: "advisories" });
  warnRejectedSources(reportTasks.map((task) => task.label), reportResults, { sweep: "reports" });

  const advisorySourceById = new Map<string, "github-advisory" | "package-advisory">();
  const flatAdvisories: VulnerabilityIntel[] = [];
  advisoryResults.forEach((result, idx) => {
    if (result.status !== "fulfilled") return;
    const source = idx < ghsaIds.length ? "github-advisory" : "package-advisory";
    for (const advisory of result.value) {
      flatAdvisories.push(advisory);
      advisorySourceById.set(advisory.id.toUpperCase(), source);
    }
  });

  const leads: AdvisoryLead[] = [];
  const seen = new Map<string, AdvisoryLead>();

  const addAdvisoryLead = (advisory: VulnerabilityIntel, source: "github-advisory" | "package-advisory" | "target-history", confidence: AdvisoryLead["confidence"]) => {
    const key = `advisory:${advisory.id.toUpperCase()}`;
    const existing = seen.get(key);
    const html = advisory.references.find((ref) => ref.kind === "advisory")?.url ?? advisory.references[0]?.url;
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (rankConfidence(confidence) > rankConfidence(existing.confidence)) existing.confidence = confidence;
      return;
    }
    const lead: AdvisoryLead = {
      id: advisory.id,
      kind: "advisory",
      confidence,
      sources: [source],
      title: advisory.summary ?? advisory.id,
      url: html,
      severity: advisory.severity,
      aliases: advisory.aliases,
    };
    seen.set(key, lead);
    leads.push(lead);
  };

  for (const advisory of mergeIntel(flatAdvisories)) {
    addAdvisoryLead(advisory, advisorySourceById.get(advisory.id.toUpperCase()) ?? "package-advisory", "high");
  }

  reportResults.forEach((result) => {
    if (result.status !== "fulfilled") return;
    for (const report of result.value.reports) {
      const key = `report:${report.url}`;
      if (seen.has(key)) continue;
      const lead: AdvisoryLead = {
        id: report.url,
        kind: "public_report",
        confidence: "low",
        sources: ["github-issue"],
        title: report.title,
        url: report.url,
        state: report.state,
        isPullRequest: report.isPullRequest,
        createdAt: report.createdAt,
        snippet: report.bodySnippet,
      };
      seen.set(key, lead);
      leads.push(lead);
    }
  });

  if (historyResult) {
    for (const advisory of historyResult.advisories) {
      addAdvisoryLead(advisory, "target-history", advisory.matchConfidence ?? "medium");
    }
  }

  leads.sort((a, b) => rankConfidence(b.confidence) - rankConfidence(a.confidence) || severityRank(b.severity) - severityRank(a.severity));

  const publicReports = leads.filter((lead) => lead.kind === "public_report").length;
  const advisories = leads.length - publicReports;
  const sources = uniqueStrings(leads.flatMap((lead) => lead.sources));
  return {
    query: { repository: input.repository, ecosystem: input.ecosystem, packageName: input.packageName, keywords, ghsaIds },
    generatedAt: new Date().toISOString(),
    counts: {
      total: leads.length,
      advisories,
      publicReports,
      high: leads.filter((lead) => lead.confidence === "high").length,
      medium: leads.filter((lead) => lead.confidence === "medium").length,
      low: leads.filter((lead) => lead.confidence === "low").length,
    },
    leads,
    caveat: SWEEP_CAVEAT,
    provenance: { sources, offline: input.offline || undefined, unverified: true },
  };
}

function rankConfidence(confidence: AdvisoryLead["confidence"]): number {
  return { high: 3, medium: 2, low: 1 }[confidence];
}

function severityRank(severity: IntelSeverity | undefined): number {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[severity ?? "info"];
}

async function goStdlibNvdFallback(
  input: AdvisorySearchInput,
  opts: FetchOptions,
): Promise<VulnerabilityIntel[]> {
  if (!isGoStdlibSearch(input)) return [];
  const keywords = goStdlibKeywords(input.packageName);
  if (keywords.length === 0) return [];
  const advisories = await searchNvdSimilar({
    keywords,
    limit: 20,
    cacheDir: input.cacheDir,
    offline: input.offline,
    ttlMs: input.ttlMs,
  }, opts);
  return advisories.filter(isGoStdlibIntel);
}

function isGoStdlibSearch(input: AdvisorySearchInput): boolean {
  const ecosystem = input.ecosystem.trim().toLowerCase();
  if (ecosystem !== "go" && ecosystem !== "golang") return false;
  const name = input.packageName.trim().toLowerCase();
  return name === "stdlib" || name === "std" || name === "go" || name === "golang" ||
    name === "github.com/golang/go" || name === "golang/go" || name.startsWith("std/") || name.startsWith("stdlib/");
}

function goStdlibKeywords(packageName: string): string[] {
  const normalized = packageName.trim().toLowerCase();
  const pkg = normalized.replace(/^stdlib\//, "").replace(/^std\//, "");
  if (pkg && pkg !== normalized) return ["golang", pkg];
  return ["golang", "standard library"];
}

function isGoStdlibIntel(advisory: VulnerabilityIntel): boolean {
  const haystack = [
    advisory.summary,
    ...advisory.references.map((reference) => reference.url),
  ].join("\n").toLowerCase();
  return /\b(go|golang)\b/.test(haystack) && (
    haystack.includes("standard library") ||
    haystack.includes("pkg.go.dev/std") ||
    haystack.includes("github.com/golang/go") ||
    haystack.includes("go.dev/issue") ||
    haystack.includes("groups.google.com/g/golang-announce")
  );
}

async function enrichCveAliases(
  advisories: VulnerabilityIntel[],
  input: Pick<AdvisorySearchInput, "cacheDir" | "offline" | "ttlMs">,
  opts: FetchOptions,
): Promise<VulnerabilityIntel[]> {
  const cves = uniqueStrings(
    advisories.flatMap((advisory) => [advisory.id, ...advisory.aliases])
      .filter((id) => /^CVE-\d{4}-\d{4,}$/i.test(id)),
  );
  const results = await Promise.allSettled(
    cves.slice(0, 10).map((cveId) =>
      lookupCve({ cveId, cacheDir: input.cacheDir, offline: input.offline, ttlMs: input.ttlMs }, opts),
    ),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}

function mergeSources(a: VulnerabilityIntel["sources"], b: VulnerabilityIntel["sources"]): VulnerabilityIntel["sources"] {
  return uniqueStrings([...a, ...b]) as VulnerabilityIntel["sources"];
}

function warnRejectedSources(
  sources: readonly string[],
  results: readonly PromiseSettledResult<unknown>[],
  context: Record<string, unknown>,
): void {
  for (const [idx, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.warn(`[intel] ${sources[idx] ?? "source"} failed`, { reason, context });
  }
}
