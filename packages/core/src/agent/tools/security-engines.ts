/**
 * Offline / read-only security-engine tool definitions (dev-live-engine-recovery).
 *
 * Deterministic source/identity analysis, advisory assembly and read-only
 * intelligence queries. Source investigation itself uses ordinary agents.
 * Network-capable helpers stay outside the scoped source-review tool set.
 */
import type { ToolDefinition, ToolContext, ToolResult } from "../types.js";
import { resolveScopedPath } from "./scope-path.js";

// ── Tool definitions ──

export const securityEngineToolDefinitions: Record<string, ToolDefinition> = {
  ad_attack_paths: {
    name: "ad_attack_paths",
    description:
      "Offline Active Directory attack-path analysis over BloodHound CE / SharpHound JSON already on disk — paths to Domain Admin, kerberoastable principals, unconstrained delegation, DCSync rights, ACL-abuse chains, and ADCS escalation. Reads files only: never collects, never authenticates, never touches the network. Point `dir` at an unzipped collection (a directory of *.json) or `file` at a single export.",
    parameters: {
      dir: { type: "string", description: "Directory of BloodHound CE / SharpHound *.json collector files (non-recursive)." },
      file: { type: "string", description: "A single BloodHound CE JSON file (alternative to `dir`)." },
      domain: { type: "string", description: "Optional: restrict analysis to objects in this AD domain FQDN, e.g. corp.example.com." },
    },
  },
  entra_attack_paths: {
    name: "entra_attack_paths",
    description:
      "Offline Microsoft Entra ID (Azure AD) attack-path analysis over an AzureHound export already on disk — paths to Global Administrator, service-principal escalation, consent-grant abuse, owner chains, and guest escalation. Reads files only: never collects, never authenticates, never touches the network. Point `dir` at a directory of AzureHound *.json, or `file` at a single export.",
    parameters: {
      dir: { type: "string", description: "Directory of AzureHound *.json files (non-recursive)." },
      file: { type: "string", description: "A single AzureHound JSON export (alternative to `dir`)." },
      owned: { type: "string", description: "Optional comma-separated object ids already under operator control; these become the path sources." },
      max_depth: { type: "number", description: "Optional hop ceiling for path traversal." },
    },
  },
  entra_posture: {
    name: "entra_posture",
    description:
      "Read-only posture assessment of a Microsoft Entra ID (Azure AD) tenant — privileged role assignments, conditional-access coverage, app registrations, service principals, and federated-domain trust. Read-only Microsoft Graph API. The Graph access token is read from the ZERO_GRAPH_ACCESS_TOKEN environment variable ONLY; it is never accepted as an argument. Returns a graceful error when the token is absent.",
    parameters: {
      tenant: { type: "string", description: "Optional Entra tenant id (GUID) the token is expected to belong to; a mismatch is reported rather than silently assessed." },
      scope: { type: "string", description: "Optional path to a JSON scope file ({in_scope,out_of_scope}); when supplied, graph.microsoft.com must be explicitly in scope or no request goes out." },
    },
  },
  
  assemble_advisory: {
    name: "assemble_advisory",
    description:
      "Assemble a GHSA-ready advisory draft from a persisted finding (offline DB read). Renders the advisory markdown (CWE + CVSS + repro + remediation), decides the filing state (keep / needs-review / drop), and — when the finding is reproduced — a DRAFT vendor-notification. NEVER sends or publishes anything. Pass `finding_id` (id or prefix); omit to draft the most recent qualifying finding.",
    parameters: {
      finding_id: { type: "string", description: "Finding id (or unique prefix). Omit to pick the most recent finding that is not discovered/false-positive." },
      scan_id: { type: "string", description: "Optional: restrict the lookup to findings from this scan." },
      db_path: { type: "string", description: "Optional path to the findings SQLite database (defaults to the standard 0 DB)." },
      allow_unreproduced: { type: "boolean", description: "Also stage the vendor-notification draft for an unreproduced finding (default false)." },
    },
  },
  cve_lookup: {
    name: "cve_lookup",
    description:
      "Read-only CVE artifact lookup: query curated public catalogues (NVD, GHSA, OSV, distro trackers, GitHub) for a CVE id and return the description, affected ranges, write-ups/advisories, and ranked public PoC candidates. Read-only — it fetches artifacts, it does NOT adapt or run any PoC. Use it to ground CVE reasoning instead of citing from memory.",
    parameters: {
      cve: { type: "string", description: "CVE identifier, e.g. CVE-2024-1086." },
      skip_github_poc_search: { type: "boolean", description: "Skip the GitHub repository/code PoC search step (faster, lower quota)." },
      timeout_ms: { type: "number", description: "Per-source timeout in milliseconds (default 10000)." },
    },
    required: ["cve"],
  },
};

// Tool-name → ToolExecutor handler-method name (0#614). Assembled by
// ./dispatch.ts; the executor's same-named methods delegate to the free
// functions below.
export const securityEngineDispatch: Record<string, string> = {
  ad_attack_paths: "adAttackPathsTool",
  entra_attack_paths: "entraAttackPathsTool",
  entra_posture: "entraPostureTool",
  assemble_advisory: "assembleAdvisoryTool",
  cve_lookup: "cveLookupTool",
};

// ── Shared helpers ──

function errResult(message: string): ToolResult {
  return { success: false, output: null, error: message };
}

/** Resolve a caller-supplied path against the scoped source path when set. */
function scopedPath(ctx: ToolContext, input: string): string {
  return ctx.scopePath ? resolveScopedPath(ctx.scopePath, input) : input;
}

/**
 * Read + JSON-parse every collector file addressed by a `dir` / `file` /
 * `input` argument. A directory yields its flat *.json listing (sorted); a file
 * yields itself. Unreadable / invalid files become warnings, not failures — a
 * single truncated file inside a collection must not abort the whole analysis.
 */
async function readCollectorJson(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ documents: unknown[]; warnings: string[]; resolved: string } | { error: string }> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const raw = String(args.dir ?? args.file ?? args.input ?? "").trim();
  if (!raw) return { error: "provide `dir` (a directory of *.json) or `file` (a single JSON export)" };

  let resolved: string;
  try {
    resolved = scopedPath(ctx, raw);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: `'${raw}' does not exist.` };
    if (code === "EACCES") return { error: `'${raw}' is not readable (permission denied).` };
    return { error: `'${raw}' could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }

  let files: string[];
  if (info.isDirectory()) {
    const entries = await readdir(resolved);
    files = entries.filter((n) => n.toLowerCase().endsWith(".json")).sort().map((n) => join(resolved, n));
    if (files.length === 0) return { error: `directory '${raw}' contains no *.json files.` };
  } else {
    files = [resolved];
  }

  const documents: unknown[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      warnings.push(`${file}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    try {
      documents.push(JSON.parse(text));
    } catch (error) {
      warnings.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (documents.length === 0) {
    return { error: `no usable JSON in '${raw}': ${warnings.join("; ")}` };
  }
  return { documents, warnings, resolved };
}

// ── 1. ad_attack_paths ──

export async function executeAdAttackPaths(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const read = await readCollectorJson(ctx, args);
  if ("error" in read) return errResult(read.error);

  const { ingestBloodHoundFiles, buildAdGraph, runAdGraphAnalysis } = await import("../../adgraph/index.js");
  let graph = ingestBloodHoundFiles(read.documents);
  if (graph.nodes.size === 0) {
    return errResult(
      "parsed JSON contained no AD objects — expected BloodHound CE collector output ({meta:{type},data:[...]}) or a graph export ({data:{nodes,edges}}).",
    );
  }

  const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim() : undefined;
  if (domain) {
    const want = domain.toUpperCase();
    const kept = [...graph.nodes.values()].filter((n) => {
      const d = typeof n.properties.domain === "string" ? n.properties.domain.trim().toUpperCase() : undefined;
      return d === undefined || d === want;
    });
    const matched = kept.filter((n) => {
      const d = typeof n.properties.domain === "string" ? n.properties.domain.trim().toUpperCase() : undefined;
      return d === want;
    }).length;
    if (matched === 0) return errResult(`no objects belong to domain '${domain}'.`);
    const keptIds = new Set(kept.map((n) => n.objectId));
    const edges = graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
    graph = buildAdGraph(kept, edges, {
      sourceTypes: graph.meta.sourceTypes,
      collectorVersion: graph.meta.collectorVersion,
      warnings: [...graph.meta.warnings, `filtered to domain ${want}: ${matched} object(s)`],
      ingestedAt: graph.meta.ingestedAt,
    });
  }

  const analysis = runAdGraphAnalysis(graph);
  return {
    success: true,
    output: {
      graph: { nodes: analysis.graph.nodeCount, edges: analysis.graph.edgeCount, sources: analysis.graph.sourceTypes },
      summary: analysis.summary,
      findings: analysis.findings.slice(0, 40).map((f) => ({
        id: f.id,
        analyzer: f.analyzer,
        title: f.title,
        severity: f.severity,
        description: f.description,
        shortestPath: f.paths[0] ? { hops: f.paths[0].length, technique: f.paths[0].technique } : null,
        pathCount: f.paths.length,
        affectedPrincipals: f.affectedPrincipals.length,
        remediation: f.remediation,
      })),
      warnings: read.warnings.slice(0, 20),
      note: "Offline BloodHound/SharpHound analysis — an empty result on an export that never collected relationships is a collection gap, not a clean domain.",
    },
  };
}

// ── 2. entra_attack_paths ──

export async function executeEntraAttackPaths(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const read = await readCollectorJson(ctx, args);
  if ("error" in read) return errResult(read.error);

  const { buildEntraGraphFromAzureHound, runEntraPathAnalysis } = await import("../../identity/index.js");
  const { graph, ingest } = buildEntraGraphFromAzureHound(read.documents);
  if (graph.nodes.size === 0) {
    return errResult(
      "parsed JSON contained no Entra objects — expected AzureHound output ({data:[{kind,data}],meta:{type}}).",
    );
  }

  const owned = typeof args.owned === "string"
    ? args.owned.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : undefined;
  const maxDepth = typeof args.max_depth === "number" && Number.isInteger(args.max_depth) && args.max_depth > 0
    ? args.max_depth
    : undefined;

  const analysis = runEntraPathAnalysis(graph, {
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(owned && owned.length > 0 ? { ownedPrincipalIds: owned } : {}),
  });

  return {
    success: true,
    output: {
      tenant: analysis.graph.tenantDisplayName ?? analysis.graph.tenantId,
      graph: {
        nodes: analysis.graph.nodeCount,
        edges: analysis.graph.edgeCount,
        origin: analysis.graph.origin,
        relationshipsCollected: analysis.graph.relationshipsCollected,
      },
      summary: analysis.summary,
      findings: analysis.findings.slice(0, 40).map((f) => ({
        id: f.id,
        analyzer: f.analyzer,
        title: f.title,
        severity: f.severity,
        description: f.description,
        shortestPath: f.paths[0] ? { hops: f.paths[0].length, technique: f.paths[0].technique } : null,
        pathCount: f.paths.length,
        affectedPrincipals: f.affectedPrincipals.length,
        remediation: f.remediation,
      })),
      warnings: [...read.warnings, ...ingest.warnings].slice(0, 20),
      note: analysis.graph.relationshipsCollected
        ? "Offline AzureHound analysis."
        : "No membership/ownership data in this export — paths that depend on it cannot be computed, and their absence is NOT evidence that none exist.",
    },
  };
}

// ── 3. entra_posture ──

// Environment variable name, not the directory access token it indexes.
// foxguard: ignore[js/no-hardcoded-secret]
const GRAPH_TOKEN_ENV = "ZERO_GRAPH_ACCESS_TOKEN";

export async function executeEntraPosture(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Env-only, never an argument: a Graph directory-read token is a whole-tenant
  // credential and a CLI/arg value lands in process listings + logs.
  const accessToken = process.env[GRAPH_TOKEN_ENV]?.trim();
  if (!accessToken) {
    return errResult(
      `Missing ${GRAPH_TOKEN_ENV}. Export a Microsoft Graph access token with directory read scopes; ` +
        "0 never accepts it as an argument.",
    );
  }

  const { runIdentityAssessment } = await import("../../identity/index.js");

  let scope: import("../../scope/scope.js").ScopePolicy | undefined;
  if (typeof args.scope === "string" && args.scope.trim()) {
    const { ScopePolicy } = await import("../../scope/scope.js");
    try {
      scope = ScopePolicy.fromJsonFile(scopedPath(ctx, args.scope.trim()));
    } catch (error) {
      return errResult(`failed to load scope '${args.scope}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const tenant = typeof args.tenant === "string" && args.tenant.trim() ? args.tenant.trim() : undefined;

  let result;
  try {
    result = await runIdentityAssessment({ accessToken, ...(scope ? { scope } : {}) });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const collected = Object.values(result.snapshot.counts).reduce((a, b) => a + b, 0);
  if (collected === 0) {
    return errResult(
      `Graph collection returned no data. The token is likely expired, scoped to the wrong audience, or missing directory read permissions. ${result.snapshot.warnings.join("; ")}`,
    );
  }
  if (tenant && result.tenantId !== "unknown" && result.tenantId.toLowerCase() !== tenant.toLowerCase()) {
    return errResult(
      `Tenant mismatch: requested ${tenant} but the ${GRAPH_TOKEN_ENV} token belongs to ${result.tenantId}. Refusing to report an assessment of a tenant that was not requested.`,
    );
  }

  return {
    success: true,
    output: {
      tenantId: result.tenantId,
      tenantDisplayName: result.tenantDisplayName,
      summary: result.summary,
      collected: result.snapshot.counts,
      partial: result.snapshot.partial,
      durationMs: result.durationMs,
      findings: result.findings.slice(0, 50).map((f) => ({
        id: f.id,
        check: f.check,
        title: f.title,
        severity: f.severity,
        category: f.category,
        description: f.description,
        affectedPrincipals: f.affectedPrincipals.length,
        remediation: f.remediation,
      })),
      warnings: result.snapshot.warnings.slice(0, 20),
      note: result.snapshot.partial
        ? "PARTIAL SNAPSHOT — one or more collection steps failed; a short finding list is NOT evidence of a healthy tenant."
        : "Read-only Entra ID posture assessment.",
    },
  };
}

// ── 6. assemble_advisory ──

interface AdvisoryFindingRow {
  id: string;
  scanId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  templateId: string;
  description: string;
  fingerprint?: string | null;
  triageStatus?: string | null;
  timestamp: number;
  evidenceRequest: string;
  evidenceResponse: string;
  evidenceAnalysis?: string | null;
  cvssVector?: string | null;
  cvssScore?: number | null;
  pocSteps?: string | null;
}

export async function executeAssembleAdvisory(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { osecDB } = await import("@0/db");
  const {
    renderAdvisoryMarkdown,
    assembleEvidencePack,
    decideFilingState,
    renderVendorNotificationMarkdown,
    EmptyPocError,
    UnreproducedFindingError,
  } = await import("../../disclose/index.js");

  const dbPath = typeof args.db_path === "string" && args.db_path.trim() ? args.db_path.trim() : undefined;
  const scanId = typeof args.scan_id === "string" && args.scan_id.trim() ? args.scan_id.trim() : undefined;
  const findingId = typeof args.finding_id === "string" && args.finding_id.trim() ? args.finding_id.trim() : undefined;

  let db: InstanceType<typeof osecDB>;
  try {
    db = new osecDB(dbPath, { readOnly: true });
  } catch (error) {
    return errResult(`could not open findings database: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const rows = db.listFindings({ ...(scanId ? { scanId } : {}), limit: 5000 }) as AdvisoryFindingRow[];
    if (rows.length === 0) return errResult("no findings in the database matching the filters.");

    let row: AdvisoryFindingRow | undefined;
    if (findingId) {
      row = rows.find((r) => r.id === findingId);
      if (!row) {
        const prefix = rows.filter((r) => r.id.startsWith(findingId));
        if (prefix.length > 1) return errResult(`finding prefix '${findingId}' is ambiguous across ${prefix.length} rows.`);
        row = prefix[0];
      }
      if (!row) return errResult(`finding '${findingId}' not found.`);
    } else {
      // Never auto-draft from unconfirmed ("discovered") or rejected findings.
      row = rows.find((r) => r.status !== "discovered" && r.status !== "false-positive" && r.triageStatus !== "suppressed");
      if (!row) return errResult("no confirmed (non-discovered/false-positive) finding to draft. Pass an explicit finding_id.");
    }

    const finding = rowToAdvisoryFinding(row);
    const { filingState, dropReason } = decideFilingState({ dropFixed: false });

    let advisory: { filename: string; markdown: string; cvssVector: string; cvssScore: number; primaryCwe: string; severity: string } | null = null;
    let advisoryError: string | undefined;
    try {
      advisory = renderAdvisoryMarkdown(finding, { scanId: row.scanId });
    } catch (error) {
      advisoryError = error instanceof EmptyPocError
        ? "empty PoC — the finding has no reproducible evidence to render into an advisory."
        : error instanceof Error ? error.message : String(error);
    }

    let vendorNotification: string | undefined;
    let vendorNote: string | undefined;
    try {
      const draft = assembleEvidencePack(finding, { allowUnreproduced: args.allow_unreproduced === true });
      vendorNotification = renderVendorNotificationMarkdown(draft);
    } catch (error) {
      vendorNote = error instanceof UnreproducedFindingError
        ? "vendor-notification skipped: the finding's PoC did not reproduce (pass allow_unreproduced to stage an internal draft)."
        : error instanceof Error ? error.message : String(error);
    }

    return {
      success: true,
      output: {
        findingId: row.id,
        scanId: row.scanId,
        title: row.title,
        severity: row.severity,
        status: row.status,
        filingState,
        ...(dropReason ? { dropReason } : {}),
        advisory: advisory
          ? {
              filename: advisory.filename,
              primaryCwe: advisory.primaryCwe,
              cvssVector: advisory.cvssVector,
              cvssScore: advisory.cvssScore,
              markdown: advisory.markdown,
            }
          : null,
        ...(advisoryError ? { advisoryError } : {}),
        ...(vendorNotification ? { vendorNotification } : {}),
        ...(vendorNote ? { vendorNote } : {}),
        note: "Offline DB read. This is a DRAFT — nothing is sent or published. Review before filing to a disclosure venue.",
      },
    };
  } finally {
    db.close();
  }
}

/** Compact DB-row → Finding conversion for the disclose renderers. */
function rowToAdvisoryFinding(row: AdvisoryFindingRow): import("@0/shared").Finding {
  const finding: import("@0/shared").Finding = {
    id: row.id,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    severity: row.severity as import("@0/shared").Severity,
    category: row.category as import("@0/shared").AttackCategory,
    status: row.status as import("@0/shared").FindingStatus,
    evidence: {
      request: row.evidenceRequest,
      response: row.evidenceResponse,
      analysis: row.evidenceAnalysis ?? undefined,
    },
    fingerprint: row.fingerprint ?? undefined,
    timestamp: row.timestamp,
  };
  if (row.cvssVector) finding.cvssVector = row.cvssVector;
  if (row.cvssScore !== null && row.cvssScore !== undefined) finding.cvssScore = row.cvssScore;
  if (row.pocSteps) {
    try {
      const parsed = JSON.parse(row.pocSteps) as import("@0/shared").PocStep[];
      if (Array.isArray(parsed) && parsed.length > 0) finding.pocSteps = parsed;
    } catch {
      // Fall back to evidence prose — malformed pocSteps must not abort drafting.
    }
  }
  return finding;
}

// ── 7. cve_lookup (READ-ONLY artifact lookup only) ──

export async function executeCveLookup(
  _ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { findCveArtifacts, normaliseCveId } = await import("../../cve/artifact-scraper.js");

  const rawCve = String(args.cve ?? args.cve_id ?? "").trim();
  if (!rawCve) return errResult("`cve` is required, e.g. CVE-2024-1086");
  let cveId: string;
  try {
    cveId = normaliseCveId(rawCve);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? Math.trunc(args.timeout_ms) : undefined;

  let result;
  try {
    result = await findCveArtifacts(cveId, {
      skipGithubPocSearch: args.skip_github_poc_search === true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      cve_id: result.cve_id,
      published: result.published,
      description: result.description,
      affected: result.affected.slice(0, 20),
      poc_urls: result.poc_urls.slice(0, 15),
      writeup_urls: result.writeup_urls.slice(0, 15),
      sources: result.sources.map((s) => ({ source: s.source, status: s.status, durationMs: s.durationMs, ...(s.error ? { error: s.error } : {}) })),
      note: "READ-ONLY artifact lookup — these PoC URLs are UNVERIFIED public artifacts, not confirmed-working exploits. This tool does not adapt or run any PoC.",
    },
  };
}
