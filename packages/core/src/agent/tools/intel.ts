/**
 * Vulnerability intelligence tool definitions (0#611 — split out of the monolithic
 * agent/tools.ts registry).
 *
 * Live vulnerability-intelligence lookups (advisories, CVEs, similar bugs,
 * dossiers, target history).
 *
 * The ./tools/index.ts barrel merges every per-domain definition map into the
 * canonical `TOOL_DEFINITIONS` registry. The runtime handler BODIES live here
 * too (0#1284) as free functions over the shared `ToolContext`; the
 * `ToolExecutor` class in agent/tools.ts keeps same-named thin delegates so the
 * dispatch table (tools/dispatch.ts) still resolves each tool to a method.
 */
import type { ToolDefinition, ToolContext, ToolResult } from "../types.js";
import {
  advisorySweep,
  buildIntelDossier,
  lookupAdvisory,
  lookupCve,
  searchAdvisories,
  searchPublicReports,
  searchSimilar,
  searchTargetHistory,
} from "../../intel/index.js";
import { resolveScopedPath } from "./scope-path.js";

export const intelToolDefinitions: Record<string, ToolDefinition> = {
  // One consolidated vuln-intelligence VERB (0#tool-curation): five uniform
  // lookups behind `action`, instead of five near-identical top-level tools —
  // trims the advertised surface (Anthropic's "one verb, not many thin tools"
  // guidance) while keeping each lookup's args documented below.
  intel: {
    name: "intel",
    description:
      "Live vulnerability-intelligence lookups. Set `action`: 'lookup_cve' (a CVE from NVD + CISA KEV — use instead of citing from memory; also accepts `ghsa_id` to fetch a specific GitHub advisory directly), 'search_advisories' (advisories affecting a package/version), 'search_similar' (related CVEs by CWE/keywords, for variant hunting), 'build_dossier' (a package-level intel dossier: prioritized advisories + prior-vuln playbooks + variant leads), 'search_target_history' (CVEs/GHSAs already reported against this exact target/repo/product), 'search_public_reports' (LEADS: GitHub issues/PRs matching code `terms` in a `repository` — catches public reports that never became advisories; results are UNVERIFIED), 'advisory_sweep' (LEADS: one call that fans out over direct GHSA-id lookups + package advisories + repo issue/PR search + optional target history, then returns a merged, de-duped, confidence-ranked lead list). Results are sourced leads; verify local reachability before reporting a new vulnerability. Note: 'no public duplicate found' is NOT proof of uniqueness — private/embargoed advisories, bug-bounty (HackerOne) reports, and internal tickets are invisible here.",
    parameters: {
      action: {
        type: "string",
        description: "Which lookup to run.",
        enum: ["lookup_cve", "search_advisories", "search_similar", "build_dossier", "search_target_history", "search_public_reports", "advisory_sweep"],
      },
      cve_id: { type: "string", description: "lookup_cve: CVE identifier, e.g. CVE-2024-1086." },
      ghsa_id: { type: "string", description: "lookup_cve: fetch a specific GitHub advisory directly, e.g. GHSA-xxxx-xxxx-xxxx (reliable — unlike free-text advisory search)." },
      terms: { type: "string", description: "search_public_reports: free-text code terms, e.g. 'ReplicateToRemote remote blob replicate'." },
      report_type: { type: "string", description: "search_public_reports: restrict to 'issue', 'pr', or 'any' (default any).", enum: ["issue", "pr", "any"] },
      ghsa_ids: { type: "array", items: { type: "string" }, description: "advisory_sweep: specific GHSA ids to resolve directly." },
      include_target_history: { type: "boolean", description: "advisory_sweep: also fold in target-history results (default false)." },
      ecosystem: { type: "string", description: "Package ecosystem: npm, PyPI, crates.io, Go, Maven (search_advisories/build_dossier; optional hint elsewhere)." },
      package_name: { type: "string", description: "Package name, e.g. formidable or requests." },
      version: { type: "string", description: "Optional resolved package version." },
      enrich: { type: "boolean", description: "search_advisories: enrich CVE aliases from NVD/CISA KEV (default true)." },
      cwe: { type: "string", description: "search_similar: CWE id, e.g. CWE-22." },
      keywords: { type: "string", description: "Comma-separated keywords, e.g. 'zip slip,path traversal'." },
      limit: { type: "number", description: "Maximum results." },
      similar_limit: { type: "number", description: "build_dossier: maximum similar-advisory leads (default 10, max 50)." },
      include_similar: { type: "boolean", description: "build_dossier: include similar historical advisories (default true)." },
      target: { type: "string", description: "search_target_history: target name, URL, or repository URL." },
      repo_path: { type: "string", description: "search_target_history: local repo/package path (defaults to the agent scope path)." },
      repository: { type: "string", description: "GitHub repository, e.g. expressjs/express (search_target_history / search_public_reports / advisory_sweep; accepts owner/repo or a repo URL)." },
      product: { type: "string", description: "search_target_history: optional product/project name." },
      vendor: { type: "string", description: "search_target_history: optional vendor/organization name." },
    },
    required: ["action"],
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Co-located with
// this domain's definitions so a new tool adds its route here, not in a
// shared dispatch switch. Assembled by ./dispatch.ts; resolved off the
// executor instance in agent/tools.ts (the methods now delegate to the
// free-function handlers below — 0#1284).
export const intelDispatch: Record<string, string> = {
  intel: "intelTool",
};

/**
 * Route one `intel` call to the right lookup by `action`. Keeps the five
 * per-lookup handlers below intact (each still validates + shapes its own args);
 * this is the thin verb-dispatcher the single tool resolves to.
 */
export async function executeIntel(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const action = String(args.action ?? "").trim();
  switch (action) {
    case "lookup_cve":
      return executeIntelLookupCve(args);
    case "search_advisories":
      return executeIntelSearchAdvisories(args);
    case "search_similar":
      return executeIntelSearchSimilar(args);
    case "build_dossier":
      return executeIntelBuildDossier(args);
    case "search_target_history":
      return executeIntelSearchTargetHistory(ctx, args);
    case "search_public_reports":
      return executeIntelSearchPublicReports(args);
    case "advisory_sweep":
      return executeIntelAdvisorySweep(args);
    default:
      return {
        success: false,
        output: null,
        error:
          `intel: unknown action "${action}" — use one of ` +
          "lookup_cve, search_advisories, search_similar, build_dossier, search_target_history, search_public_reports, advisory_sweep",
      };
  }
}

// ── Runtime handlers (0#1284) ──
// Extracted verbatim from the ToolExecutor private methods of the same name.
// Only `intel_search_target_history` needs executor state (the scope path), so
// it takes the `ToolContext`; the rest are pure over their args.

export async function executeIntelSearchAdvisories(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const ecosystem = String(args.ecosystem ?? "").trim();
  const packageName = String(args.package_name ?? args.packageName ?? "").trim();
  if (!ecosystem) return { success: false, output: null, error: "ecosystem is required" };
  if (!packageName) return { success: false, output: null, error: "package_name is required" };
  const version = typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;
  const enrich = typeof args.enrich === "boolean" ? args.enrich : true;
  const result = await searchAdvisories({
    ecosystem,
    packageName,
    version,
    enrich,
  });
  return {
    success: true,
    output: {
      count: result.advisories.length,
      advisories: result.advisories.slice(0, 20),
      graph: {
        nodes: result.graph.nodes.slice(0, 80),
        edges: result.graph.edges.slice(0, 120),
      },
    },
  };
}

export async function executeIntelLookupCve(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Direct GHSA lookup (0#intel-advisories): GET /advisories/{ghsa_id} is
  // reliable, so prefer it when a GHSA id is supplied.
  const ghsaId = String(args.ghsa_id ?? args.ghsaId ?? "").trim();
  if (ghsaId) {
    let advisory;
    try {
      advisory = await lookupAdvisory({ ghsaId });
    } catch (error) {
      return { success: false, output: null, error: error instanceof Error ? error.message : String(error) };
    }
    if (!advisory) return { success: true, output: { ghsa_id: ghsaId.toUpperCase(), found: false } };
    return { success: true, output: { found: true, advisory } };
  }
  const cveId = String(args.cve_id ?? args.cveId ?? "").trim();
  if (!cveId) return { success: false, output: null, error: "cve_id or ghsa_id is required" };
  const intel = await lookupCve({ cveId });
  if (!intel) return { success: true, output: { cve_id: cveId.toUpperCase(), found: false } };
  return { success: true, output: { found: true, advisory: intel } };
}

export async function executeIntelSearchPublicReports(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const repository = typeof args.repository === "string" && args.repository.trim() ? args.repository.trim() : undefined;
  const terms = typeof args.terms === "string" && args.terms.trim() ? args.terms.trim() : undefined;
  if (!repository && !terms) {
    return { success: false, output: null, error: "provide repository and/or terms" };
  }
  const type = args.report_type === "issue" || args.report_type === "pr" ? args.report_type : "any";
  const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 30) : undefined;
  let result;
  try {
    result = await searchPublicReports({ repository, terms, type, limit });
  } catch (error) {
    return { success: false, output: null, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    success: true,
    output: {
      query: result.query,
      totalCount: result.totalCount,
      count: result.reports.length,
      reports: result.reports,
      // LEADS tool: every hit is an unverified public report, not an advisory.
      note: "UNVERIFIED public reports (GitHub issues/PRs), not confirmed vulnerabilities — verify before acting.",
    },
  };
}

export async function executeIntelAdvisorySweep(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const repository = typeof args.repository === "string" && args.repository.trim() ? args.repository.trim() : undefined;
  const ecosystem = typeof args.ecosystem === "string" && args.ecosystem.trim() ? args.ecosystem.trim() : undefined;
  const packageName = String(args.package_name ?? args.packageName ?? "").trim() || undefined;
  const keywords = parseStringList(args.keywords);
  const ghsaIds = parseStringList(args.ghsa_ids ?? args.ghsaIds);
  const includeTargetHistory = typeof args.include_target_history === "boolean" ? args.include_target_history : undefined;
  const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : undefined;
  if (!repository && !(ecosystem && packageName) && ghsaIds.length === 0) {
    return { success: false, output: null, error: "provide repository, ecosystem+package_name, and/or ghsa_ids" };
  }
  const result = await advisorySweep({
    repository,
    ecosystem,
    packageName,
    keywords,
    ghsaIds,
    includeTargetHistory,
    limit,
  });
  return {
    success: true,
    output: {
      ...result,
      leads: result.leads.slice(0, 40),
    },
  };
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export async function executeIntelSearchSimilar(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const cwe = typeof args.cwe === "string" && args.cwe.trim() ? args.cwe.trim() : undefined;
  const ecosystem = typeof args.ecosystem === "string" && args.ecosystem.trim() ? args.ecosystem.trim() : undefined;
  const keywords = typeof args.keywords === "string"
    ? args.keywords.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
  const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 10;
  if (!cwe && (!keywords || keywords.length === 0)) {
    return { success: false, output: null, error: "provide cwe or keywords" };
  }
  const result = await searchSimilar({ cwe, ecosystem, keywords, limit });
  return {
    success: true,
    output: {
      count: result.advisories.length,
      advisories: result.advisories.slice(0, limit),
      graph: {
        nodes: result.graph.nodes.slice(0, 80),
        edges: result.graph.edges.slice(0, 120),
      },
    },
  };
}

export async function executeIntelBuildDossier(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const ecosystem = String(args.ecosystem ?? "").trim();
  const packageName = String(args.package_name ?? args.packageName ?? "").trim();
  if (!ecosystem) return { success: false, output: null, error: "ecosystem is required" };
  if (!packageName) return { success: false, output: null, error: "package_name is required" };
  const version = typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;
  const keywords = typeof args.keywords === "string"
    ? args.keywords.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
  const similarLimit = typeof args.similar_limit === "number"
    ? Math.min(Math.max(Math.trunc(args.similar_limit), 1), 50)
    : undefined;
  const includeSimilar = typeof args.include_similar === "boolean" ? args.include_similar : undefined;
  const dossier = await buildIntelDossier({
    ecosystem,
    packageName,
    version,
    keywords,
    similarLimit,
    includeSimilar,
  });
  return {
    success: true,
    output: {
      ...dossier,
      advisories: dossier.advisories.slice(0, 20),
      variantLeads: dossier.variantLeads.slice(0, 10),
      playbooks: dossier.playbooks.slice(0, 6).map((playbook) => ({
        ...playbook,
        steps: playbook.steps.slice(0, 5),
      })),
      graph: {
        nodes: dossier.graph.nodes.slice(0, 100),
        edges: dossier.graph.edges.slice(0, 160),
      },
    },
  };
}

export async function executeIntelSearchTargetHistory(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
  const requestedRepoPath = typeof args.repo_path === "string" && args.repo_path.trim() ? args.repo_path.trim() : undefined;
  const repoPath = requestedRepoPath
    ? (ctx.scopePath ? resolveScopedPath(ctx.scopePath, requestedRepoPath) : requestedRepoPath)
    : ctx.scopePath;
  const repository = typeof args.repository === "string" && args.repository.trim() ? args.repository.trim() : undefined;
  const ecosystem = typeof args.ecosystem === "string" && args.ecosystem.trim() ? args.ecosystem.trim() : undefined;
  const packageName = String(args.package_name ?? args.packageName ?? "").trim() || undefined;
  const product = typeof args.product === "string" && args.product.trim() ? args.product.trim() : undefined;
  const vendor = typeof args.vendor === "string" && args.vendor.trim() ? args.vendor.trim() : undefined;
  const keywords = typeof args.keywords === "string"
    ? args.keywords.split(",").map((item) => item.trim()).filter(Boolean)
    : undefined;
  const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.trunc(args.limit), 1), 50) : 20;
  if (!target && !repoPath && !repository && !packageName && !product && !vendor && (!keywords || keywords.length === 0)) {
    return { success: false, output: null, error: "provide target, repo_path, repository, package_name, product, vendor, keywords, or run with a scoped source path" };
  }
  const history = await searchTargetHistory({
    target,
    repoPath,
    repository,
    ecosystem,
    packageName,
    product,
    vendor,
    keywords,
    limit,
  });
  return {
    success: true,
    output: {
      ...history,
      advisories: history.advisories.slice(0, 20),
      playbooks: history.playbooks.slice(0, 6).map((playbook) => ({
        ...playbook,
        steps: playbook.steps.slice(0, 5),
      })),
      graph: {
        nodes: history.graph.nodes.slice(0, 100),
        edges: history.graph.edges.slice(0, 160),
      },
    },
  };
}
