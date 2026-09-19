/**
 * Offline / read-only security-engine tool definitions (dev-live-engine-recovery).
 *
 * Exposes seven engines that previously shipped as CLI-only commands as
 * first-class autonomous-agent tools, so "software secures itself" can reach the
 * whole arsenal instead of only the live-traffic subset. Every engine here is
 * OFFLINE (file/DB read) or read-only + env-scoped — none touches the target's
 * network, none exploits, none writes — so they join the DEFAULT read-only role
 * set (SCOPED_SOURCE_AUDIT_TOOLS, alongside `intel`) with NO new gating. See the
 * companion routing skills under agent/skills/.
 *
 * Follows the 0sec#1284 pattern: the runtime handler BODIES are free functions
 * over the shared `ToolContext` here; the `ToolExecutor` class in agent/tools.ts
 * keeps same-named thin delegates so the dispatch barrel (tools/dispatch.ts)
 * still resolves each tool to a method. Heavy / cycle-prone core modules are
 * pulled in via dynamic `import()` inside each handler (mirroring how the
 * deep-review and disclose CLI commands lazy-load their deps).
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
      "Read-only posture assessment of a Microsoft Entra ID (Azure AD) tenant — privileged role assignments, conditional-access coverage, app registrations, service principals, and federated-domain trust. Read-only Microsoft Graph API. The Graph access token is read from the 0SEC_GRAPH_ACCESS_TOKEN environment variable ONLY; it is never accepted as an argument. Returns a graceful error when the token is absent.",
    parameters: {
      tenant: { type: "string", description: "Optional Entra tenant id (GUID) the token is expected to belong to; a mismatch is reported rather than silently assessed." },
      scope: { type: "string", description: "Optional path to a JSON scope file ({in_scope,out_of_scope}); when supplied, graph.microsoft.com must be explicitly in scope or no request goes out." },
    },
  },
  deep_source_review: {
    name: "deep_source_review",
    description:
      "Seedless DEPTH review of a source tree: enumerate candidate files and re-hunt each through specialized finder lenses (memory-safety, input-validation, authz/logic, secrets/crypto + the appsec pack), gating survivors through a multi-lens refute quorum. Offline source read (no target network). Emits LEADS to verify, not confirmed bugs. LLM-backed and can be slow/costly — pass `max_candidates` / `cost_ceiling_usd` to bound it.",
    parameters: {
      target: { type: "string", description: "Source tree to review (a local path; resolved within scope when a scoped source path is set)." },
      subsystem: { type: "string", description: "Optional: narrow the review to a subdirectory (respects the 5000-file review cap)." },
      max_candidates: { type: "number", description: "Cap candidate files hunted, largest-first (default 8)." },
      concurrency: { type: "number", description: "Max finders in flight (default 8)." },
      cost_ceiling_usd: { type: "number", description: "Optional hard USD ceiling for the sweep." },
    },
    required: ["target"],
  },
  file_security_review: {
    name: "file_security_review",
    description:
      "Whole-repo file-level security review: free regex scan → coverage gate → batched AI investigation (refusal audit + field repair) → optional static revalidation. Offline (no target network) and resumable — a cost/duration limit stops at a checkpoint (exit code 3); re-run to continue. LLM-backed; bound it with `max_cost_usd` / `max_duration_ms`.",
    parameters: {
      target: { type: "string", description: "Repo root to review (a local path; resolved within scope when a scoped source path is set)." },
      max_cost_usd: { type: "number", description: "Optional hard USD cap for the whole run (resumable stop)." },
      max_duration_ms: { type: "number", description: "Optional wall-clock cap in milliseconds (resumable stop)." },
      batch_size: { type: "number", description: "Files per investigation batch (default 5)." },
      concurrency: { type: "number", description: "Batches in flight (default 2)." },
      revalidate: { type: "boolean", description: "Run static adversarial revalidation on HIGH+ findings (default false)." },
    },
    required: ["target"],
  },
  assemble_advisory: {
    name: "assemble_advisory",
    description:
      "Assemble a GHSA-ready advisory draft from a persisted finding (offline DB read). Renders the advisory markdown (CWE + CVSS + repro + remediation), decides the filing state (keep / needs-review / drop), and — when the finding is reproduced — a DRAFT vendor-notification. NEVER sends or publishes anything. Pass `finding_id` (id or prefix); omit to draft the most recent qualifying finding.",
    parameters: {
      finding_id: { type: "string", description: "Finding id (or unique prefix). Omit to pick the most recent finding that is not discovered/false-positive." },
      scan_id: { type: "string", description: "Optional: restrict the lookup to findings from this scan." },
      db_path: { type: "string", description: "Optional path to the findings SQLite database (defaults to the standard 0sec DB)." },
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

// Tool-name → ToolExecutor handler-method name (0sec#614). Assembled by
// ./dispatch.ts; the executor's same-named methods delegate to the free
// functions below.
export const securityEngineDispatch: Record<string, string> = {
  ad_attack_paths: "adAttackPathsTool",
  entra_attack_paths: "entraAttackPathsTool",
  entra_posture: "entraPostureTool",
  deep_source_review: "deepSourceReviewTool",
  file_security_review: "fileSecurityReviewTool",
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
const GRAPH_TOKEN_ENV = "0SEC_GRAPH_ACCESS_TOKEN";

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
        "0sec never accepts it as an argument.",
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

// ── 4. deep_source_review ──

// Generic, language- and domain-agnostic finder lenses — the deliberately-coarse
// depth-method fallback buckets (mirrors the seedless deep-review command). The
// appsec pack (loadAppsecFinderLenses) is layered on top at runtime.
const GENERIC_FINDER_LENSES = [
  {
    id: "memory-safety",
    challengeHint:
      "Hunt MEMORY-SAFETY bugs only: out-of-bounds read/write, use-after-free, double-free, uninitialized read, integer overflow feeding an allocation or index, and unchecked length/size arithmetic before a copy. Cite the exact unguarded sink (file:line) and the attacker-controlled path that reaches it.",
  },
  {
    id: "input-validation",
    challengeHint:
      "Hunt INPUT-VALIDATION and injection bugs only: untrusted input reaching a dangerous sink without validation — command/SQL/path/template injection, unsafe deserialization, SSRF, unchecked redirects, or a parser that trusts attacker-supplied structure. Trace the taint from the entry point to the sink.",
  },
  {
    id: "auth-logic",
    challengeHint:
      "Hunt AUTHZ / LOGIC bugs only: a missing or wrong permission/ownership check, a broken state machine, a TOCTOU race, an off-by-one or boundary error in a security-relevant decision, or a check that can be bypassed. Prove the guard is absent or mis-scoped, not merely that the keywords appear.",
  },
  {
    id: "secrets-crypto",
    challengeHint:
      "Hunt SECRETS / CRYPTO misuse only: hardcoded credentials, a weak/predictable RNG used for security, a broken or misused cryptographic primitive (ECB, static IV/nonce, missing MAC verification, non-constant-time compare), or a signature/token check that can be forged or replayed. Cite the exact misuse.",
  },
] as const;

const GENERIC_VERIFY_LENSES = [
  {
    id: "reachability",
    challengeHint:
      "REACHABILITY: is the vulnerable code actually reachable by an attacker from a real entry point (exported/public API, request handler, CLI, parser) with no gate it cannot pass? Trace the concrete path from the entry to the sink. If the path is dead code, disabled, or privileged-only, refute it.",
  },
  {
    id: "completeness",
    challengeHint:
      "COMPLETENESS: is the 'missing' check actually enforced elsewhere on the path — a validation earlier in the flow, a guard in the only caller, a wrapper that sanitizes first? Read the whole call path and the full file. If the guard is present AND correctly scoped, refute it; keep it only if genuinely absent or mis-scoped.",
  },
  {
    id: "novelty-known-issue",
    challengeHint:
      "NOVELTY / KNOWN-GUARD: is the standard guard for this class present and correct (a framework escaper, a safe API, a bounds check, a working auth middleware)? Is this a well-known already-mitigated pattern? If a correct standard guard covers it, refute it.",
  },
  {
    id: "scope",
    challengeHint:
      "SCOPE / IMPACT: does exploiting this actually corrupt memory, leak secrets, escalate privilege, execute code, or break a security invariant? A cosmetic missing check with no real impact is info/low, not high — refute it as such.",
  },
] as const;

const DEEP_REVIEW_FILE_CAP = 5000;

export async function executeDeepSourceReview(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const target = String(args.target ?? "").trim();
  if (!target) return errResult("`target` is required (a source tree path)");

  const { resolve, join, sep, relative } = await import("node:path");
  const { statSync } = await import("node:fs");
  const { prepare } = await import("../../prepare.js");
  const { collectScopeFiles, countScopeFilesUpTo } = await import("../../source-files.js");
  const { runHuntScan, makeMultiLensVerifier } = await import("../../stages/hunt-scan.js");
  const { loadAppsecFinderLenses } = await import("../../stages/appsec-catalog.js");
  const { ScanCostLedger } = await import("../cost-ledger.js");

  let resolvedTarget: string;
  try {
    resolvedTarget = scopedPath(ctx, target);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const prepared = await prepare(resolvedTarget, "source-code", {}, () => {});
  const sourceRoot = resolve(prepared.resolvedTarget);
  try {
    let scopeRoot = sourceRoot;
    const subsystem = typeof args.subsystem === "string" && args.subsystem.trim() ? args.subsystem.trim() : undefined;
    if (subsystem) {
      const scoped = resolve(join(sourceRoot, subsystem));
      if (scoped !== sourceRoot && !scoped.startsWith(sourceRoot + sep)) {
        return errResult(`subsystem '${subsystem}' escapes the source tree`);
      }
      scopeRoot = scoped;
    }

    const totalFiles = countScopeFilesUpTo(scopeRoot, DEEP_REVIEW_FILE_CAP);
    if (totalFiles > DEEP_REVIEW_FILE_CAP) {
      return {
        success: true,
        output: {
          mode: "deep_review",
          source: sourceRoot,
          scope_files: totalFiles,
          note: `scope exceeds the ${DEEP_REVIEW_FILE_CAP}-file review cap — narrow it with \`subsystem\`.`,
        },
      };
    }

    const maxCandidates = typeof args.max_candidates === "number" && args.max_candidates > 0
      ? Math.trunc(args.max_candidates)
      : 8;
    const files = collectScopeFiles(scopeRoot, { maxFiles: DEEP_REVIEW_FILE_CAP });
    const candidatePaths = files
      .map((p) => {
        try { return { p, size: statSync(p).size }; } catch { return { p, size: 0 }; }
      })
      .sort((a, b) => b.size - a.size || a.p.localeCompare(b.p))
      .slice(0, maxCandidates)
      .map((e) => e.p);

    if (candidatePaths.length === 0) {
      return {
        success: true,
        output: { mode: "deep_review", source: sourceRoot, scope_files: totalFiles, candidates: 0, note: "no reviewable source files under the scope." },
      };
    }

    const finderLenses = [...GENERIC_FINDER_LENSES, ...loadAppsecFinderLenses()];
    const costLedger = new ScanCostLedger();
    const costCeilingUsd = typeof args.cost_ceiling_usd === "number" && args.cost_ceiling_usd > 0 ? args.cost_ceiling_usd : undefined;
    const concurrency = typeof args.concurrency === "number" && args.concurrency > 0 ? Math.trunc(args.concurrency) : 8;

    const verify = makeMultiLensVerifier([...GENERIC_VERIFY_LENSES], {
      sourceRoot,
      runtime: "api",
      costLedger,
      ...(costCeilingUsd !== undefined ? { costCeilingUsd } : {}),
    });

    const res = await runHuntScan({
      sourceRoot,
      candidates: candidatePaths.map((path) => ({ path })),
      lenses: finderLenses,
      runtime: "api",
      concurrency,
      costLedger,
      ...(costCeilingUsd !== undefined ? { costCeilingUsd } : {}),
      verify,
    });

    return {
      success: true,
      output: {
        mode: "deep_review",
        source: sourceRoot,
        subsystem: subsystem ?? null,
        scope_files: totalFiles,
        candidates: candidatePaths.length,
        finder_lenses: finderLenses.map((l) => l.id),
        verify_lenses: GENERIC_VERIFY_LENSES.map((l) => l.id),
        scanned: res.scanned,
        finder_completed: res.finderCompleted,
        findings: res.findings.length,
        confirmed: res.confirmed.length,
        leads: res.confirmed.slice(0, 25).map((f) => ({
          title: f.title,
          severity: f.severity,
          analysis: f.evidence?.analysis ?? "",
        })),
        dropped: res.dropped.slice(0, 25).map((d) => ({
          title: d.finding.title,
          severity: d.finding.severity,
          candidatePath: d.candidatePath,
          lensId: d.lensId,
          dropReason: d.dropReason,
        })),
        warnings: res.warnings.slice(0, 10),
        note: "LEADS, not confirmed bugs. Each survived the multi-lens refute quorum; verify the real sink + impact before disclosure.",
      },
    };
  } finally {
    prepared.cleanup();
  }
}

// ── 5. file_security_review ──

export async function executeFileSecurityReview(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const target = String(args.target ?? "").trim();
  if (!target) return errResult("`target` is required (a repo root path)");

  const { resolve } = await import("node:path");
  const { createRuntime } = await import("../../runtime/index.js");
  const { runFileReviewPipeline } = await import("../../file-review/pipeline.js");

  let rootPath: string;
  try {
    rootPath = resolve(scopedPath(ctx, target));
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const runtime = createRuntime({ type: "api", timeout: 600_000, cwd: rootPath });
  const invoker = async (prompt: string) => {
    const r = await runtime.execute(prompt);
    return { output: r.output, usage: r.usage, durationMs: r.durationMs };
  };

  const result = await runFileReviewPipeline({
    rootPath,
    invoker,
    withRevalidate: args.revalidate === true,
    ...(typeof args.max_cost_usd === "number" && args.max_cost_usd > 0 ? { maxCostUsd: args.max_cost_usd } : {}),
    ...(typeof args.max_duration_ms === "number" && args.max_duration_ms > 0 ? { maxDurationMs: args.max_duration_ms } : {}),
    ...(typeof args.batch_size === "number" && args.batch_size > 0 ? { batchSize: Math.trunc(args.batch_size) } : {}),
    ...(typeof args.concurrency === "number" && args.concurrency > 0 ? { concurrency: Math.trunc(args.concurrency) } : {}),
  });

  return {
    success: true,
    output: {
      mode: "file_review",
      runId: result.runId,
      projectId: result.projectId,
      exitCode: result.exitCode,
      resumable: result.exitCode === 3,
      stats: result.stats,
      note: result.exitCode === 3
        ? "Stopped at a cost/duration limit — re-run file_security_review on the same target to resume from the checkpoint."
        : result.exitCode === 1
          ? "Review complete: net-new finding(s) recorded."
          : "Review complete: no net-new findings.",
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
  const { osecDB } = await import("@0sec/db");
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
function rowToAdvisoryFinding(row: AdvisoryFindingRow): import("@0sec/shared").Finding {
  const finding: import("@0sec/shared").Finding = {
    id: row.id,
    templateId: row.templateId,
    title: row.title,
    description: row.description,
    severity: row.severity as import("@0sec/shared").Severity,
    category: row.category as import("@0sec/shared").AttackCategory,
    status: row.status as import("@0sec/shared").FindingStatus,
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
      const parsed = JSON.parse(row.pocSteps) as import("@0sec/shared").PocStep[];
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
