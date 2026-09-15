/**
 * Phase-2 offensive / active security-engine tool definitions
 * (dev-live-engine-recovery).
 *
 * Exposes ten more CLI-only engines as first-class autonomous-agent tools,
 * carrying "software secures itself" past the offline read-only arsenal
 * (security-engines.ts, Phase 1) and into the ACTIVE loop: variant/assumption
 * hunting, scoped fix generation, PoC verification (the loop-closer), live
 * protocol/spec differentials, and — behind explicit feature flags — the
 * capabilities that RUN or BUILD untrusted code or weaponize a kernel bug.
 *
 * Gating is deny-by-default and tiered (see getToolsForRole in agent/tools.ts,
 * which is the single source of truth; the handlers below re-check the same
 * conditions as defense-in-depth):
 *
 *   GROUP 1 — OFFLINE source engines (variant_hunt, assumption_hunt,
 *     generate_fix). File/DB read only, no target traffic, generate_fix only
 *     PROPOSES a patch. Join the DEFAULT read-only role set
 *     (SCOPED_SOURCE_AUDIT_TOOLS) with NO extra gating — exactly like Phase 1.
 *
 *   GROUP 2 — engagement-SCOPED (verify_finding, protocol_conformance,
 *     spec_drift, safety_eval). Offered ONLY when an engagement scope is active
 *     (opts.hasScope). Absent for a no-scope session — mirrors how the network
 *     roles gate their target-touching tools. See OFFENSIVE_SCOPED_TOOL_NAMES.
 *
 *   GROUP 3 — FEATURE-FLAGGED + scoped, deny-by-default (memsafety_fuzz,
 *     npm_dynamic_discovery, weaponize_kernel, cve_adapt). These RUN/BUILD
 *     untrusted code or weaponize. Each needs a named env flag AND an active
 *     scope; the absent flag ⇒ the tool is not offered at all (mirrors
 *     0SEC_FEATURE_CLOUD_SURFACE / CLOUD_TOOL_NAMES). weaponize_kernel and
 *     cve_adapt additionally deny unless kernel-VM artifacts are present — they
 *     only ever execute inside a disposable kernel VM.
 *
 * Follows the Phase-1 pattern exactly: the runtime handler BODIES are free
 * functions over the shared ToolContext here; the ToolExecutor class in
 * agent/tools.ts keeps same-named thin delegates so the dispatch barrel
 * (tools/dispatch.ts) resolves each tool to a method. Heavy / cycle-prone core
 * modules are pulled in via dynamic import() inside each handler.
 */
import type { ToolDefinition, ToolContext, ToolResult } from "../types.js";
import { features as featureFlags } from "../features.js";
import { resolveScopedPath } from "./scope-path.js";

// ── Tool definitions ──

export const offensiveEngineToolDefinitions: Record<string, ToolDefinition> = {
  // ── GROUP 1: offline source engines (default read-only role set) ──
  variant_hunt: {
    name: "variant_hunt",
    description:
      "Offline variant hunt: given a PROVEN bug (a seed fix diff or a described bug class) hunt the SAME class at OTHER sites in a source tree — LLM bug-class extraction + grep'd candidate sites → parallel finders → an adversarial skeptic gate that re-reads and tries to refute each. Reads source only; never touches the target network. Emits LEADS worth verifying, NOT confirmed 0-days: a survivor still needs its real sink/impact traced and its novelty (already-fixed?) checked. LLM-backed; bound it with `max_candidates`.",
    parameters: {
      source: { type: "string", description: "Source tree to hunt (a local path or git URL; resolved within scope when a scoped source path is set)." },
      seed: { type: "string", description: "The seed that defines the bug class: a unified-diff patch (inline text), a path to a .diff/.patch file, or a prose description of the bug class. A sharper seed yields sharper candidates." },
      max_candidates: { type: "number", description: "Cap candidate sites generated from the seed (default 40)." },
    },
    required: ["source"],
  },
  assumption_hunt: {
    name: "assumption_hunt",
    description:
      "Offline assumption-mining: mine a source tree for the IMPLICIT assumptions the code depends on (a value is never null, an input was validated upstream, a caller holds a lock, a size fits) and surface the sites where a violated assumption becomes a bug, gating survivors through the same skeptic quorum. Reads source only; never touches the target network. Emits LEADS to verify. LLM-backed; narrow the tree with `subsystem` and bound with `max_files`.",
    parameters: {
      source: { type: "string", description: "Source root to mine (a local path or git URL; resolved within scope when a scoped source path is set)." },
      subsystem: { type: "string", description: "Optional subdirectory (relative to the source root) to focus the mine on, and the label used for the mined-model file." },
      max_files: { type: "number", description: "Cap the number of source files fed to the miner (default 40)." },
    },
    required: ["source"],
  },
  generate_fix: {
    name: "generate_fix",
    description:
      "Offline scoped-fix generation for a REPRODUCED finding: load the finding's focus (vulnerable file/lines + evidence) and the surrounding source, then produce a MINIMAL candidate patch that closes the vulnerability without changing unrelated behaviour. It only PROPOSES a diff — it is not applied automatically (apply stays off). It reads source + the findings DB only; it never touches the target network. Requires a reproduced finding (with a verification result) and a regression `test_command`; a not-yet-reproduced finding returns a precondition_failed result rather than a speculative patch.",
    parameters: {
      finding_id: { type: "string", description: "Finding id (or unique prefix) to remediate; must be a reproduced finding." },
      repo: { type: "string", description: "Repo root (a clean local worktree) the patch applies to; defaults to the scoped source path when one is set." },
      test_command: { type: "string", description: "Regression command run to check the fix does not break the valid path (e.g. \"make test\"). Required." },
      db_path: { type: "string", description: "Optional path to the findings SQLite database (defaults to the standard 0sec DBs)." },
    },
    required: ["finding_id", "test_command"],
  },

  // ── GROUP 2: engagement-scoped (only offered with an active scope) ──
  verify_finding: {
    name: "verify_finding",
    description:
      "THE LOOP-CLOSER. Replay a persisted finding's proof-of-concept against the real target and return a deterministic pass/fail verdict from the category oracle — turning a LEAD into a CONFIRMED, reproduced finding. `status` is `reproduced` (pass), `not_reproduced` (fail — NOT proof the bug is absent; the target may have changed or the PoC needs adaptation), `skipped` (no PoC steps), or `error`. SCOPE-GATED: offered only for an active engagement; an optional `target` override must be IN SCOPE or it is refused.",
    parameters: {
      finding_id: { type: "string", description: "Finding id (or unique prefix) to replay." },
      target: { type: "string", description: "Optional in-scope target override; an out-of-scope override is refused. When omitted, the finding's own recorded target/PoC steps drive the replay." },
      db_path: { type: "string", description: "Optional path to the findings SQLite database (defaults to the standard 0sec DBs)." },
    },
    required: ["finding_id"],
  },
  protocol_conformance: {
    name: "protocol_conformance",
    description:
      "Send crafted HTTP requests to a REAL target and diff its behaviour against a supplied HTTP-spec excerpt — surfacing parser quirks / conformance violations that lead to request smuggling, cache poisoning, and desync. Each probed hypothesis is reported as confirmed / refuted / inconclusive with the observed response. A confirmed violation is a LEAD toward a concrete attack, not the attack itself. SCOPE-GATED: sends live traffic, so it is offered only for an active engagement and the `target` must be in scope.",
    parameters: {
      target: { type: "string", description: "In-scope base URL / endpoint to probe." },
      spec: { type: "string", description: "The HTTP-spec excerpt stating the invariant(s) to check (e.g. Content-Length vs Transfer-Encoding handling, header-folding rules)." },
      impl: { type: "string", description: "Optional excerpt of the implementation / observed behaviour to compare against the spec." },
      protocol: { type: "string", description: "Protocol name (default \"HTTP/1.1\")." },
      spec_version: { type: "string", description: "Spec version label (default \"RFC 9110\")." },
      max_exercises: { type: "number", description: "Cost guard: max crafted requests to send (default 8)." },
    },
    required: ["target", "spec"],
  },
  spec_drift: {
    name: "spec_drift",
    description:
      "Specification differential: extract the normative invariants (MUST/SHALL/…) a target is SUPPOSED to enforce from a spec, then map them to the candidate implementation sites in the target's source and emit drift hypotheses — documented-vs-actual gaps (missing auth requirement, shadow endpoint/param, over-disclosure). Deterministic source mapping (no LLM). Each drift is a LEAD whose security impact must still be confirmed. SCOPE-GATED: offered only for an active engagement.",
    parameters: {
      source: { type: "string", description: "The target's source tree (a local path or git URL; resolved within scope when a scoped source path is set)." },
      spec: { type: "string", description: "The specification text (inline), or a path to an OpenAPI / spec document, whose invariants are extracted." },
      spec_name: { type: "string", description: "Optional label for the spec (defaults to the spec filename)." },
      plan: { type: "boolean", description: "When true, also emit ranked drift HYPOTHESES to verify (plan stage) rather than only candidate mappings (scan stage)." },
      max_invariants: { type: "number", description: "Cap invariants extracted from the spec (default 40)." },
    },
    required: ["source", "spec"],
  },
  safety_eval: {
    name: "safety_eval",
    description:
      "Red-team a real LLM / agent ENDPOINT: send a battery of adversarial prompts and score the responses for safety failures — jailbreaks, harmful-content compliance, prompt-injection susceptibility, and unsafe tool/agency use. A `fail` verdict means the endpoint IS vulnerable (produced unsafe output). Passing the suite means it resisted THESE vectors, not that it is unjailbreakable. SCOPE-GATED: sends live prompts, so it is offered only for an active engagement and the `target` endpoint must be in scope. Requires an LLM API key to drive the adversarial agent.",
    parameters: {
      target: { type: "string", description: "In-scope AI/LLM endpoint URL under test." },
      categories: { type: "object", description: "Optional array of adversarial category ids to run (e.g. [\"prompt-injection\"]); omit to run the full suite." },
      timeout_ms: { type: "number", description: "Per-turn timeout in milliseconds (default 30000)." },
    },
    required: ["target"],
  },

  // ── GROUP 3: feature-flagged + scoped, deny-by-default ──
  memsafety_fuzz: {
    name: "memsafety_fuzz",
    description:
      "Build and FUZZ a native source tree (C/C++/Rust) for memory-safety bugs — sanitizer builds + a fuzz harness driven in a closed loop, classifying crashes into exploitability verdicts. This EXECUTES the target's build scripts and native fuzz targets, so it is DENY-BY-DEFAULT: requires the feature flag 0SEC_FEATURE_MEMSAFETY=1 AND an active engagement scope. When the toolchain (cargo-fuzz / clang / miri) is missing the run reports `tooling_missing` and ZERO findings — that is an honest 'could not complete', NOT a clean result.",
    parameters: {
      source: { type: "string", description: "Native source tree to fuzz (a local path or git URL; resolved within scope when a scoped source path is set)." },
      language: { type: "string", description: "Source language: \"c\", \"cpp\", or \"rust\". Auto-detected from the build files when omitted." },
      build_system: { type: "string", description: "Build system: \"cargo\", \"cmake\", \"autotools\", \"meson\", or \"make\". Auto-detected when omitted." },
      subsystem: { type: "string", description: "Optional subdirectory (relative to the source root) to narrow the build/fuzz scope." },
      harness_entry: { type: "string", description: "Optional libFuzzer / cargo-fuzz target name." },
      timeout_sec: { type: "number", description: "Fuzz loop wall-clock budget in seconds (default 60)." },
    },
    required: ["source"],
  },
  npm_dynamic_discovery: {
    name: "npm_dynamic_discovery",
    description:
      "Install and RUN untrusted npm packages under instrumentation (in an isolated sandbox runner, never in-process) to observe malicious install/runtime behaviour — install-script abuse, network beacons, filesystem/credential access — layered with an OSV advisory lookup for known-vulnerable dependencies. This EXECUTES arbitrary package code, so it is DENY-BY-DEFAULT: requires the feature flag 0SEC_FEATURE_NPM_DISCOVERY=1 AND an active engagement scope. Run only in a sandbox/VM you can discard. A clean dynamic run is not proof of safety.",
    parameters: {
      packages: { type: "object", description: "Array of npm package names (optionally \"name@version\") to analyze." },
      detector_ids: { type: "object", description: "Optional array of behaviour-detector ids to restrict to; omit to run the full registry." },
      offline: { type: "boolean", description: "Skip the OSV advisory lookup (offline dedup only); default false." },
    },
    required: ["packages"],
  },
  weaponize_kernel: {
    name: "weaponize_kernel",
    description:
      "Drive the kernel-exploit weaponization ladder: classify a kernel crash into a primitive and climb from crash → leak → arbitrary write → root, iterating candidate strategies. IT ONLY EVER RUNS INSIDE A DISPOSABLE KERNEL VM — never against a live host. Highest-caution capability, DENY-BY-DEFAULT at three layers: the feature flag 0SEC_FEATURE_KERNEL_WEAPONIZE=1, an active engagement scope, AND kernel-VM artifacts present (0SEC_KERNEL_QEMU_KERNEL + 0SEC_KERNEL_QEMU_DISK on disk) — when the VM assets are absent it refuses rather than pretending to run. Success demonstrates a primitive in the VM; it is a reproduced finding, not a deployed exploit.",
    parameters: {
      dmesg: { type: "string", description: "The raw kernel crash log / KASAN splat to classify into an exploitation primitive." },
      crash_type: { type: "string", description: "Optional crash-type hint (e.g. \"kasan-uaf\"); sniffed from the dmesg when omitted." },
      reproducer: { type: "string", description: "Optional proven trigger C source, embedded for provenance." },
      max_strategies: { type: "number", description: "Cap the number of weaponization strategies attempted (default: all applicable)." },
    },
    required: ["dmesg"],
  },
  cve_adapt: {
    name: "cve_adapt",
    description:
      "Adapt a public CVE PoC to the target kernel tree and RUN it to confirm exploitability, returning `confirmed` / `unreproduced` / `no_artifact` / `budget_exhausted`. Fetches artifacts via the read-only CVE scraper, then verifies each candidate by booting a kernel VM. This RUNS an adapted exploit, so it is DENY-BY-DEFAULT: requires the feature flag 0SEC_FEATURE_CVE_ADAPT=1 AND an active engagement scope; because verification boots a kernel VM it also refuses unless kernel-VM artifacts are present. A failed adaptation is not proof of non-exposure. Ground the CVE with `cve_lookup` first.",
    parameters: {
      cve: { type: "string", description: "CVE identifier, e.g. CVE-2024-1086." },
      kernel_tree: { type: "string", description: "Path to the kernel source tree to build/verify against (resolved within scope when a scoped source path is set)." },
      attempts: { type: "number", description: "Max verify-runs across all candidates (default 5)." },
      wall_clock_ms: { type: "number", description: "Overall wall-clock budget in milliseconds (default 1800000 = 30 min)." },
    },
    required: ["cve", "kernel_tree"],
  },
};

// Tool-name → ToolExecutor handler-method name. Assembled by ./dispatch.ts.
export const offensiveEngineDispatch: Record<string, string> = {
  variant_hunt: "variantHuntTool",
  assumption_hunt: "assumptionHuntTool",
  generate_fix: "generateFixTool",
  verify_finding: "verifyFindingTool",
  protocol_conformance: "protocolConformanceTool",
  spec_drift: "specDriftTool",
  safety_eval: "safetyEvalTool",
  memsafety_fuzz: "memsafetyFuzzTool",
  npm_dynamic_discovery: "npmDynamicDiscoveryTool",
  weaponize_kernel: "weaponizeKernelTool",
  cve_adapt: "cveAdaptTool",
};

// ── Gating name-sets (consumed by getToolsForRole in agent/tools.ts) ──

/**
 * GROUP 2 — engagement-scoped offensive tools. Offered ONLY when a scope is
 * active (opts.hasScope). Mirrors the target-touching precedent: no scope ⇒ not
 * offered. GROUP 1 tools are NOT here — they live in SCOPED_SOURCE_AUDIT_TOOLS.
 */
export const OFFENSIVE_SCOPED_TOOL_NAMES: ReadonlyArray<string> = [
  "verify_finding",
  "protocol_conformance",
  "spec_drift",
  "safety_eval",
];

/** GROUP 3 — feature-flag + scope gated. One name-set per flag (cloud parity). */
export const MEMSAFETY_TOOL_NAMES: ReadonlyArray<string> = ["memsafety_fuzz"];
export const NPM_DISCOVERY_TOOL_NAMES: ReadonlyArray<string> = ["npm_dynamic_discovery"];
export const KERNEL_WEAPONIZE_TOOL_NAMES: ReadonlyArray<string> = ["weaponize_kernel"];
export const CVE_ADAPT_TOOL_NAMES: ReadonlyArray<string> = ["cve_adapt"];

// ── Shared helpers ──

function errResult(message: string): ToolResult {
  return { success: false, output: null, error: message };
}

/** Resolve a caller-supplied path against the scoped source path when set. */
function scopedPath(ctx: ToolContext, input: string): string {
  return ctx.scopePath ? resolveScopedPath(ctx.scopePath, input) : input;
}

/**
 * Deny-by-default engagement-scope guard, mirroring getToolsForRole's
 * `opts.hasScope` (an engagement ScopePolicy OR a configured local scope path).
 * The GROUP 2/3 tools are already filtered out of a no-scope session's tool
 * set; this is the defense-in-depth re-check so a hand-built ToolContext (a
 * test, a non-console caller) cannot invoke them scope-free.
 */
function hasEngagementScope(ctx: ToolContext): boolean {
  return (
    !!ctx.scope ||
    (typeof ctx.scopePath === "string" && ctx.scopePath.length > 0)
  );
}

/** Refuse a network URL that is out of an active engagement scope. */
function refuseOutOfScope(ctx: ToolContext, url: string): string | null {
  if (!ctx.scope) return null; // no network scope to check against
  try {
    if (!ctx.scope.match(url).allowed) {
      return `'${url}' is out of the engagement scope — refusing to send traffic to an unauthorized target.`;
    }
  } catch {
    return `'${url}' could not be scope-checked — refusing.`;
  }
  return null;
}

/**
 * Reconstruct the CLI's `loadFindingFocus`: resolve a persisted finding by id
 * (or unique prefix) from the standard 0sec findings DB(s), rebuilding the
 * full Finding (including the verification result + verificationSpec that the
 * fix precondition depends on). CLI-only in the CLI package, re-implemented
 * here over the exported @0sec/db + @0sec/shared primitives.
 */
async function loadPersistedFinding(
  findingId: string,
  dbPathArg?: string,
): Promise<{ finding: import("@0sec/shared").Finding; target?: string } | { error: string }> {
  const { osecDB, resolveOsecDbPath, listOsecRunDatabasePaths } = await import("@0sec/db");
  const { findingSchema, formatZodError } = await import("@0sec/shared");
  const { resolve } = await import("node:path");
  const { existsSync } = await import("node:fs");

  const requestedId = findingId.trim();
  if (!requestedId) return { error: "`finding_id` is required." };

  const dbPaths = dbPathArg?.trim()
    ? [resolve(dbPathArg.trim())]
    : [...new Set([...listOsecRunDatabasePaths(), resolveOsecDbPath()].map((p) => resolve(p)))];

  const parseJson = (value: unknown): unknown => {
    if (value == null) return undefined;
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return undefined; }
  };
  const findingFromRow = (
    row: Record<string, unknown>,
    reviewFields: Record<string, unknown>,
  ): import("@0sec/shared").Finding => {
    const id = typeof row.id === "string" ? row.id : "";
    const record = {
      id,
      templateId: typeof row.templateId === "string" ? row.templateId : "",
      title: typeof row.title === "string" ? row.title : "",
      description: typeof row.description === "string" ? row.description : "",
      severity: typeof row.severity === "string" ? row.severity : "",
      category: typeof row.category === "string" ? row.category : "",
      status: typeof row.status === "string" ? row.status : "",
      fingerprint: typeof row.fingerprint === "string" ? row.fingerprint || undefined : undefined,
      triageStatus: typeof row.triageStatus === "string" ? row.triageStatus || undefined : undefined,
      cvssVector: typeof row.cvssVector === "string" ? row.cvssVector || undefined : undefined,
      cvssScore: typeof row.cvssScore === "number" ? row.cvssScore : undefined,
      timestamp: typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : 0,
      evidence: {
        request: typeof row.evidenceRequest === "string" ? row.evidenceRequest : "",
        response: typeof row.evidenceResponse === "string" ? row.evidenceResponse : "",
        analysis: typeof row.evidenceAnalysis === "string" ? row.evidenceAnalysis || undefined : undefined,
      },
      layerVerdicts: parseJson(row.layerVerdicts),
      impactAssessment: parseJson(row.impactAssessment),
      remediation: parseJson(row.remediation),
      pocSteps: parseJson(row.pocSteps),
      verificationSpec: parseJson(row.verificationSpec),
      ...reviewFields,
    };
    const parsed = findingSchema.safeParse(record);
    if (!parsed.success) {
      throw new Error(`stored finding ${id || "<unknown>"} is invalid: ${formatZodError(parsed.error, "finding")}`);
    }
    return parsed.data as import("@0sec/shared").Finding;
  };

  const matches: Array<{ row: Record<string, unknown>; target?: string; dbPath: string }> = [];
  try {
    for (const dbPath of dbPaths) {
      if (!existsSync(dbPath)) {
        if (dbPathArg?.trim()) return { error: `database does not exist: ${dbPath}` };
        continue;
      }
      const db = new osecDB(dbPath, { readOnly: true });
      try {
        const exact = db.getFinding(requestedId) as Record<string, unknown> | undefined;
        if (exact) {
          const scan = db.getScan(typeof exact.scanId === "string" ? exact.scanId : "") as { target?: unknown } | undefined;
          const reviewFields = db.getFindingReviewFields(requestedId) as Record<string, unknown>;
          return {
            finding: findingFromRow(exact, reviewFields),
            target: typeof scan?.target === "string" ? scan.target : undefined,
          };
        }
        const prefixRows = (db.listFindings({ limit: 5000 }) as Record<string, unknown>[])
          .filter((r) => typeof r.id === "string" && (r.id as string).startsWith(requestedId));
        for (const row of prefixRows) {
          const scan = db.getScan(typeof row.scanId === "string" ? row.scanId : "") as { target?: unknown } | undefined;
          const reviewFields = db.getFindingReviewFields(row.id as string) as Record<string, unknown>;
          matches.push({
            row: { ...row, ...reviewFields },
            target: typeof scan?.target === "string" ? scan.target : undefined,
            dbPath,
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (matches.length === 0) return { error: `finding '${requestedId}' was not found. Use a full id or pass db_path.` };
  if (matches.length > 1) return { error: `finding prefix '${requestedId}' is ambiguous across ${matches.length} rows. Use a longer id.` };
  const match = matches[0]!;
  const reviewFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(match.row)) {
    if (k === "verification_result" || k === "reviewAnnotation") reviewFields[k] = v;
  }
  try {
    return { finding: findingFromRow(match.row, reviewFields), ...(match.target ? { target: match.target } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read a `seed` argument: a path to an on-disk .diff/.patch, or inline text. */
async function readSeed(ctx: ToolContext, seed: string): Promise<{ diff?: string; reference: string }> {
  const raw = seed.trim();
  if (!raw) return { reference: "operator-described bug class" };
  // A short single-line value that resolves to a readable file is a path;
  // anything multi-line or diff-shaped is treated as inline content.
  const looksInline = raw.includes("\n") || raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("@@");
  if (!looksInline) {
    try {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(scopedPath(ctx, raw), "utf8");
      return { diff: text, reference: raw };
    } catch {
      // Not a readable file — fall through and treat as a prose reference.
      return { reference: raw };
    }
  }
  return { diff: raw, reference: "inline seed diff" };
}

// ── GROUP 1.1 — variant_hunt ──

export async function executeVariantHunt(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const target = String(args.source ?? args.target ?? "").trim();
  if (!target) return errResult("`source` is required (a source tree path or git URL)");

  const { resolve, join } = await import("node:path");
  const { prepare } = await import("../../prepare.js");
  const { generateVariantCandidates } = await import("../../stages/variant-candidates.js");
  const { runHuntScan, makeSkepticVerifier } = await import("../../stages/hunt-scan.js");

  let resolvedTarget: string;
  try {
    resolvedTarget = scopedPath(ctx, target);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const seedArg = typeof args.seed === "string" ? args.seed : "";
  const fix = await readSeed(ctx, seedArg);
  const maxCandidates = typeof args.max_candidates === "number" && args.max_candidates > 0 ? Math.trunc(args.max_candidates) : undefined;

  const prepared = await prepare(resolvedTarget, "source-code", {}, () => {});
  const sourceRoot = resolve(prepared.resolvedTarget);
  try {
    const plan = await generateVariantCandidates({
      sourceRoot,
      fix,
      runtime: "api",
      ...(maxCandidates !== undefined ? { maxCandidates } : {}),
    });
    const candidates = plan.candidates.map((c) => ({ ...c, path: join(sourceRoot, c.path) }));
    if (candidates.length === 0) {
      return {
        success: true,
        output: {
          mode: "variant_hunt",
          source: sourceRoot,
          bug_class: plan.brief.bugClass,
          candidates: 0,
          warnings: plan.warnings.slice(0, 10),
          note: "no candidate sites generated from the seed — the bug class may be too narrow, or the seed did not extract a class. Provide a sharper seed diff.",
        },
      };
    }

    const verify = makeSkepticVerifier({ sourceRoot, runtime: "api" });
    const res = await runHuntScan({ sourceRoot, candidates, brief: plan.brief, runtime: "api", concurrency: 4, verify });

    return {
      success: true,
      output: {
        mode: "variant_hunt",
        source: sourceRoot,
        bug_class: plan.brief.bugClass,
        pattern: plan.brief.pattern,
        candidates: candidates.length,
        scanned: res.scanned,
        findings: res.findings.length,
        confirmed: res.confirmed.length,
        leads: res.confirmed.slice(0, 25).map((f) => ({ title: f.title, severity: f.severity, analysis: f.evidence?.analysis ?? "" })),
        dropped: res.dropped.slice(0, 15).map((d) => ({ title: d.finding.title, dropReason: d.dropReason })),
        warnings: [...plan.warnings, ...res.warnings].slice(0, 10),
        note: "LEADS, not confirmed 0-days. Each survived the skeptic gate; verify the real sink + impact and check the site is not already fixed before disclosure. Hand a promising lead to verify_finding.",
      },
    };
  } finally {
    prepared.cleanup();
  }
}

// ── GROUP 1.2 — assumption_hunt ──

export async function executeAssumptionHunt(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const target = String(args.source ?? args.target ?? "").trim();
  if (!target) return errResult("`source` is required (a source root path or git URL)");

  const { resolve, join, sep, relative, basename } = await import("node:path");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { prepare } = await import("../../prepare.js");
  const { collectScopeFiles } = await import("../../source-files.js");
  const { runAssumptionHunt } = await import("../../stages/assumption-mining.js");
  const { makeSkepticVerifier } = await import("../../stages/hunt-scan.js");

  let resolvedTarget: string;
  try {
    resolvedTarget = scopedPath(ctx, target);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const maxFiles = typeof args.max_files === "number" && args.max_files > 0 ? Math.trunc(args.max_files) : 40;
  const subsystemArg = typeof args.subsystem === "string" && args.subsystem.trim() ? args.subsystem.trim() : undefined;

  const prepared = await prepare(resolvedTarget, "source-code", {}, () => {});
  const sourceRoot = resolve(prepared.resolvedTarget);
  let modelDir: string | undefined;
  try {
    let scopeRoot = sourceRoot;
    if (subsystemArg) {
      const scoped = resolve(join(sourceRoot, subsystemArg));
      if (scoped !== sourceRoot && !scoped.startsWith(sourceRoot + sep)) {
        return errResult(`subsystem '${subsystemArg}' escapes the source tree`);
      }
      scopeRoot = scoped;
    }
    const subsystem = subsystemArg ?? basename(sourceRoot);

    const abs = collectScopeFiles(scopeRoot, { maxFiles: 5000 });
    const subsystemFiles = abs.map((p) => relative(sourceRoot, p)).slice(0, maxFiles);
    if (subsystemFiles.length === 0) {
      return {
        success: true,
        output: { mode: "assumption_hunt", source: sourceRoot, subsystem, files: 0, note: "no reviewable source files under the scope." },
      };
    }

    modelDir = await mkdtemp(join(tmpdir(), "0sec-assumption-"));
    const modelPath = join(modelDir, `${subsystem.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
    const verify = makeSkepticVerifier({ sourceRoot, runtime: "api" });

    const result = await runAssumptionHunt({
      sourceRoot,
      subsystem,
      subsystemFiles,
      runtime: "api",
      modelPath,
      verify,
    });

    return {
      success: true,
      output: {
        mode: "assumption_hunt",
        source: sourceRoot,
        subsystem,
        files: subsystemFiles.length,
        model_loaded: result.modelLoaded,
        assumptions_mined: result.model.assumptions.length,
        cross_check: { kept: result.crossCheck.kept.length, dropped: result.crossCheck.dropped.length, reclassified: result.crossCheck.reclassified.length },
        violating_contexts: result.contexts.length,
        dual_view_contexts: result.dualViewContexts.length,
        candidates: result.plan.candidates.length,
        confirmed: result.hunt ? result.hunt.confirmed.length : null,
        leads: result.hunt ? result.hunt.confirmed.slice(0, 20).map((f) => ({ title: f.title, severity: f.severity, analysis: f.evidence?.analysis ?? "" })) : [],
        warnings: (result.hunt?.warnings ?? []).slice(0, 10),
        note: "LEADS, not confirmed bugs. Each mined assumption + violating path is a hypothesis; verify the assumption is genuinely unenforced on a concrete reachable path before treating it as real.",
      },
    };
  } finally {
    prepared.cleanup();
    if (modelDir) await rm(modelDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── GROUP 1.3 — generate_fix ──

export async function executeGenerateFix(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const findingId = String(args.finding_id ?? args.findingId ?? "").trim();
  if (!findingId) return errResult("`finding_id` is required.");
  const testCommand = typeof args.test_command === "string" ? args.test_command.trim() : "";
  if (!testCommand) return errResult("`test_command` is required — the regression command run to confirm the fix does not break the valid path.");

  const repoArg = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : (ctx.scopePath ?? "");
  if (!repoArg) return errResult("`repo` is required (the repo root the patch applies to) — no scoped source path is set to default to.");

  const { resolve } = await import("node:path");
  const { runSourceFix } = await import("../../fix/index.js");
  const { LlmApiRuntime } = await import("../../runtime/index.js");

  const loaded = await loadPersistedFinding(findingId, typeof args.db_path === "string" ? args.db_path : undefined);
  if ("error" in loaded) return errResult(loaded.error);

  let repoRoot: string;
  try {
    repoRoot = resolve(scopedPath(ctx, repoArg));
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const runtime = new LlmApiRuntime({ type: "api", timeout: typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 600_000 });

  let result;
  try {
    result = await runSourceFix({
      repoRoot,
      finding: loaded.finding,
      runtime,
      testCommand,
      apply: false, // never auto-apply — generate_fix only PROPOSES a patch
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      mode: "generate_fix",
      status: result.status,
      findingId: result.findingId,
      sourceFile: result.sourceFile ?? null,
      applied: result.applied,
      patch: result.patch ?? null,
      rationale: result.rationale ?? null,
      attempts: result.attempts.map((a) => ({ attempt: a.attempt, reason: a.reason })),
      test: result.test ? { command: result.test.command, exitCode: result.test.exitCode, timedOut: result.test.timedOut } : null,
      ...(result.error ? { error: result.error } : {}),
      note: result.status === "precondition_failed"
        ? "Precondition not met: generate_fix requires a REPRODUCED finding (a verification result with status 'reproduced' and a verificationSpec). Reproduce it with verify_finding first."
        : "Candidate patch only — NOT applied. Review the diff, confirm it blocks the reproduced PoC without breaking the valid path, then apply it through your normal edit/patch flow.",
    },
  };
}

// ── GROUP 2.1 — verify_finding (the loop-closer) ──

export async function executeVerifyFinding(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!hasEngagementScope(ctx)) {
    return errResult("verify_finding requires an active engagement scope — it replays a PoC against the target. It is not available for a no-scope session.");
  }
  const findingId = String(args.finding_id ?? args.findingId ?? "").trim();
  if (!findingId) return errResult("`finding_id` is required.");

  const targetOverride = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
  if (targetOverride) {
    const denial = refuseOutOfScope(ctx, targetOverride);
    if (denial) return errResult(denial);
  }

  const loaded = await loadPersistedFinding(findingId, typeof args.db_path === "string" ? args.db_path : undefined);
  if ("error" in loaded) return errResult(loaded.error);

  const { runDeterministicReplay, LocalShellRunner } = await import("../../verify/replay-runner.js");
  const { VERSION } = await import("@0sec/shared");

  let outcome;
  try {
    outcome = await runDeterministicReplay(loaded.finding, {
      runner: new LocalShellRunner(),
      ...(ctx.scope ? { scope: ctx.scope } : {}),
      engineVersion: VERSION,
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const r = outcome.result;
  const assertionsPassed = r.assertions.filter((a) => a.passed).length;
  return {
    success: true,
    output: {
      mode: "verify_finding",
      finding_id: r.finding_id,
      verification_status: r.status, // reproduced | not_reproduced | skipped | error
      replay_mode: r.mode,
      assertions: { total: r.assertions.length, passed: assertionsPassed, failed: r.assertions.length - assertionsPassed },
      commands: r.commands.length,
      duration_ms: r.duration_ms,
      summary: r.summary ?? null,
      ...(r.error_reason ? { error_reason: r.error_reason } : {}),
      ...(targetOverride ? { target_override: targetOverride } : {}),
      note: r.status === "reproduced"
        ? "REPRODUCED — the oracle observed the expected effect. This is a confirmed finding; it is the right input to generate_fix and assemble_advisory."
        : r.status === "not_reproduced"
          ? "NOT reproduced — this is NOT proof the bug is absent. The target may have changed or the PoC may need adaptation; re-examine the evidence."
          : r.status === "skipped"
            ? "Skipped — the finding has no PoC steps to replay."
            : "Replay error — see error_reason.",
    },
  };
}

// ── GROUP 2.2 — protocol_conformance ──

export async function executeProtocolConformance(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!hasEngagementScope(ctx)) {
    return errResult("protocol_conformance requires an active engagement scope — it sends crafted requests to the target. It is not available for a no-scope session.");
  }
  const target = String(args.target ?? "").trim();
  if (!target) return errResult("`target` is required (an in-scope base URL / endpoint).");
  const specExcerpt = typeof args.spec === "string" ? args.spec : "";
  if (!specExcerpt.trim()) return errResult("`spec` is required (the HTTP-spec excerpt stating the invariant to check).");

  const denial = refuseOutOfScope(ctx, target);
  if (denial) return errResult(denial);

  const { runHttpConformanceCheck } = await import("../../protocol/http-conformance.js");
  const { createLiveHttpSender } = await import("../../protocol/http-sender.js");
  const { LlmApiRuntime } = await import("../../runtime/index.js");

  const llm = new LlmApiRuntime({ type: "api", timeout: 60_000 });
  const send = createLiveHttpSender();
  const protocol = {
    name: typeof args.protocol === "string" && args.protocol.trim() ? args.protocol.trim() : "HTTP/1.1",
    version: typeof args.spec_version === "string" && args.spec_version.trim() ? args.spec_version.trim() : "RFC 9110",
    specRef: "operator-supplied excerpt",
  };
  const implExcerpt = typeof args.impl === "string" ? args.impl : "";
  const maxExercises = typeof args.max_exercises === "number" && args.max_exercises >= 0 ? Math.trunc(args.max_exercises) : undefined;

  let result;
  try {
    result = await runHttpConformanceCheck(specExcerpt, implExcerpt, target, llm, send, protocol, {
      ...(maxExercises !== undefined ? { maxExercises } : {}),
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const tally = { confirmed: 0, refuted: 0, inconclusive: 0 };
  for (const a of result.attempts) {
    const v = a.verdict.status;
    if (v === "confirmed") tally.confirmed++;
    else if (v === "refuted") tally.refuted++;
    else tally.inconclusive++;
  }

  return {
    success: true,
    output: {
      mode: "protocol_conformance",
      target,
      protocol: protocol.name,
      ok: result.ok,
      gen_iterations: result.genIterations,
      attempts: result.attempts.length,
      verdicts: tally,
      violations: result.findings.slice(0, 20).map((f) => ({ title: f.title, severity: f.severity })),
      ...(result.reason ? { reason: result.reason } : {}),
      note: "A confirmed violation is a LEAD toward smuggling / desync / cache poisoning — confirm the downstream impact (e.g. a front-end/back-end parser disagreement) before reporting. Conformant behaviour clears only the invariants tested.",
    },
  };
}

// ── GROUP 2.3 — spec_drift ──

export async function executeSpecDrift(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!hasEngagementScope(ctx)) {
    return errResult("spec_drift requires an active engagement scope. It is not available for a no-scope session.");
  }
  const source = String(args.source ?? args.target ?? "").trim();
  if (!source) return errResult("`source` is required (the target's source tree).");
  const specArg = typeof args.spec === "string" ? args.spec : "";
  if (!specArg.trim()) return errResult("`spec` is required (spec text, or a path to a spec document).");

  const { resolve, basename } = await import("node:path");
  const { prepare } = await import("../../prepare.js");
  const { runSpecdriftScan, runSpecdriftPlan } = await import("../../specdrift/index.js");

  // The `spec` argument is spec text, or a readable path to a spec document.
  let specText = specArg;
  let specName = typeof args.spec_name === "string" && args.spec_name.trim() ? args.spec_name.trim() : "spec";
  const looksInline = specArg.includes("\n") || specArg.trimStart().startsWith("{") || specArg.length > 512;
  if (!looksInline) {
    try {
      const { readFile } = await import("node:fs/promises");
      specText = await readFile(scopedPath(ctx, specArg.trim()), "utf8");
      if (!(typeof args.spec_name === "string" && args.spec_name.trim())) specName = basename(specArg.trim());
    } catch {
      // Treat as inline text.
      specText = specArg;
    }
  }

  let resolvedSource: string;
  try {
    resolvedSource = scopedPath(ctx, source);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const maxInvariants = typeof args.max_invariants === "number" && args.max_invariants > 0 ? Math.trunc(args.max_invariants) : undefined;

  const prepared = await prepare(resolvedSource, "source-code", {}, () => {});
  const sourceRoot = resolve(prepared.resolvedTarget);
  try {
    const scanOpts = { specName, specText, sourceRoot, ...(maxInvariants !== undefined ? { maxInvariants } : {}) };
    if (args.plan === true) {
      const res = runSpecdriftPlan(scanOpts);
      return {
        success: true,
        output: {
          mode: "spec_drift",
          stage: "plan",
          spec: res.spec,
          source: sourceRoot,
          invariants: res.invariants.length,
          candidates: res.candidates.length,
          hypotheses: res.hypotheses.slice(0, 30).map((h) => ({
            invariantId: h.invariantId,
            file: h.candidateFile,
            lineStart: h.candidateLineStart,
            question: h.question,
            confidence: h.confidence,
          })),
          warnings: res.warnings.slice(0, 10),
          note: "Drift HYPOTHESES — each is a documented-vs-actual gap to verify. Confirm the security impact (who can reach it, what it exposes); not every mismatch is a vulnerability.",
        },
      };
    }
    const res = runSpecdriftScan(scanOpts);
    return {
      success: true,
      output: {
        mode: "spec_drift",
        stage: "scan",
        spec: res.spec,
        source: sourceRoot,
        invariants: res.invariants.length,
        candidates: res.candidates.slice(0, 30).map((c) => ({
          invariantId: c.invariantId,
          file: c.file,
          lineStart: c.lineStart,
          confidence: c.confidence,
          reason: c.reason,
        })),
        warnings: res.warnings.slice(0, 10),
        note: "Candidate spec↔implementation mappings. Pass plan:true for ranked drift hypotheses. Confirm the security impact of any drift before treating it as a finding.",
      },
    };
  } finally {
    prepared.cleanup();
  }
}

// ── GROUP 2.4 — safety_eval ──

export async function executeSafetyEval(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!hasEngagementScope(ctx)) {
    return errResult("safety_eval requires an active engagement scope — it sends adversarial prompts to a live endpoint. It is not available for a no-scope session.");
  }
  const target = String(args.target ?? "").trim();
  if (!target) return errResult("`target` is required (the in-scope LLM/agent endpoint).");
  const denial = refuseOutOfScope(ctx, target);
  if (denial) return errResult(denial);

  const { runEval } = await import("../../eval-runner.js");

  const categories = Array.isArray(args.categories)
    ? (args.categories as unknown[]).map((c) => String(c)).filter(Boolean)
    : undefined;
  const timeout = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : undefined;

  let scorecard;
  try {
    scorecard = await runEval({
      target,
      ...(categories && categories.length > 0 ? { categories } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      mode: "safety_eval",
      target: scorecard.target,
      summary: scorecard.summary,
      duration_ms: scorecard.durationMs,
      categories: scorecard.categories.map((c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        verdict: c.verdict, // fail = vulnerable, pass = resisted, error
        reason: c.reason,
        findings: c.findings.length,
      })),
      note: "A `fail` verdict means the endpoint IS vulnerable (produced unsafe output). Passing means it resisted THESE vectors, not that it is unjailbreakable — capture prompt+response as evidence for any failure.",
    },
  };
}

// ── GROUP 3.1 — memsafety_fuzz (flag + scope) ──

export async function executeMemsafetyFuzz(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!featureFlags.memsafetyFuzz) {
    return errResult("memsafety_fuzz is disabled. Set 0SEC_FEATURE_MEMSAFETY=1 to enable (it builds + fuzzes an untrusted source tree).");
  }
  if (!hasEngagementScope(ctx)) {
    return errResult("memsafety_fuzz requires an active engagement scope. It is not available for a no-scope session.");
  }
  const target = String(args.source ?? args.target ?? "").trim();
  if (!target) return errResult("`source` is required (a native source tree).");

  const { resolve, join, sep } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const { prepare } = await import("../../prepare.js");
  const { runMemSafetyScan } = await import("../../stages/memsafety-scan.js");

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
      if (scoped !== sourceRoot && !scoped.startsWith(sourceRoot + sep)) return errResult(`subsystem '${subsystem}' escapes the source tree`);
      scopeRoot = scoped;
    }

    // Resolve language + build system: explicit args win, else auto-detect.
    let language = typeof args.language === "string" ? args.language.trim().toLowerCase() : "";
    let buildSystem = typeof args.build_system === "string" ? args.build_system.trim().toLowerCase() : "";
    if (!buildSystem || !language) {
      if (existsSync(join(scopeRoot, "Cargo.toml"))) { buildSystem ||= "cargo"; language ||= "rust"; }
      else if (existsSync(join(scopeRoot, "CMakeLists.txt"))) { buildSystem ||= "cmake"; language ||= "cpp"; }
      else if (existsSync(join(scopeRoot, "meson.build"))) { buildSystem ||= "meson"; language ||= "cpp"; }
      else if (existsSync(join(scopeRoot, "configure")) || existsSync(join(scopeRoot, "configure.ac"))) { buildSystem ||= "autotools"; language ||= "c"; }
      else if (existsSync(join(scopeRoot, "Makefile"))) { buildSystem ||= "make"; language ||= "c"; }
    }
    const okLang = ["c", "cpp", "rust"];
    const okBuild = ["cargo", "cmake", "autotools", "meson", "make"];
    if (!okLang.includes(language) || !okBuild.includes(buildSystem)) {
      return errResult(
        `could not resolve a build for '${target}' (language=${language || "?"}, build_system=${buildSystem || "?"}). ` +
          "Pass explicit `language` (c|cpp|rust) and `build_system` (cargo|cmake|autotools|meson|make).",
      );
    }

    const timeoutSec = typeof args.timeout_sec === "number" && args.timeout_sec > 0 ? Math.trunc(args.timeout_sec) : undefined;
    const result = await runMemSafetyScan({
      target: {
        language: language as "c" | "cpp" | "rust",
        sourceRoot: scopeRoot,
        buildSystem: buildSystem as "cargo" | "cmake" | "autotools" | "meson" | "make",
        ...(typeof args.harness_entry === "string" && args.harness_entry.trim() ? { harnessEntry: args.harness_entry.trim() } : {}),
      },
      ...(timeoutSec !== undefined ? { fuzz: { timeoutSec } } : {}),
    });

    return {
      success: true,
      output: {
        mode: "memsafety_fuzz",
        source: scopeRoot,
        language,
        build_system: buildSystem,
        findings: result.findings.length,
        details: result.details.slice(0, 20).map((d) => ({ title: d.finding.title, severity: d.finding.severity, verdict: d.verdict })),
        loop: { iterations: result.loop.iterations, crashes: result.loop.crashes, corpusSize: result.loop.corpusSize, durationMs: result.loop.durationMs, executedHarness: result.loop.executedHarness },
        tooling_missing: result.toolingMissing,
        warnings: result.warnings.slice(0, 10),
        note: result.toolingMissing.length > 0
          ? `INCOMPLETE — missing toolchain: ${result.toolingMissing.join(", ")}. Zero findings here means 'could not complete', NOT a clean tree.`
          : "Closed-loop fuzz complete. Crashes are classified into exploitability verdicts; a memcorruption crash still needs a reproduced PoC to confirm impact.",
      },
    };
  } finally {
    prepared.cleanup();
  }
}

// ── GROUP 3.2 — npm_dynamic_discovery (flag + scope) ──

export async function executeNpmDynamicDiscovery(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!featureFlags.npmDynamicDiscovery) {
    return errResult("npm_dynamic_discovery is disabled. Set 0SEC_FEATURE_NPM_DISCOVERY=1 to enable (it installs + runs untrusted npm packages).");
  }
  if (!hasEngagementScope(ctx)) {
    return errResult("npm_dynamic_discovery requires an active engagement scope. It is not available for a no-scope session.");
  }

  const rawPackages = Array.isArray(args.packages)
    ? (args.packages as unknown[]).map((p) => String(p).trim()).filter(Boolean)
    : typeof args.packages === "string" && args.packages.trim()
      ? [args.packages.trim()]
      : [];
  if (rawPackages.length === 0) return errResult("`packages` is required (an array of npm package names).");

  const worklist = rawPackages.map((spec) => {
    const at = spec.lastIndexOf("@");
    if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
    return { name: spec };
  });

  const { runNpmDynamicDiscovery } = await import("../../stages/npm-dynamic-discovery.js");
  const { createSandboxPackageRunner, createOsvAdvisoryLookup, resolveDetectors } = await import("../../stages/npm-detectors/index.js");

  const detectorIds = Array.isArray(args.detector_ids)
    ? (args.detector_ids as unknown[]).map((d) => String(d)).filter(Boolean)
    : undefined;
  if (detectorIds && detectorIds.length > 0) {
    const { unknown } = resolveDetectors(detectorIds);
    if (unknown.length > 0) return errResult(`unknown detector id(s): ${unknown.join(", ")}`);
  }

  // The sandbox runner isolates execution — untrusted package code NEVER runs
  // in this process (the deliberate contract: packageRunner takes precedence
  // over any in-process probeFactory).
  const packageRunner = createSandboxPackageRunner();
  const advisoryLookup = args.offline === true ? undefined : createOsvAdvisoryLookup();

  let result;
  try {
    result = await runNpmDynamicDiscovery({
      worklist,
      packageRunner,
      ...(detectorIds && detectorIds.length > 0 ? { detectorIds } : {}),
      ...(advisoryLookup ? { advisoryLookup } : {}),
      concurrency: 1,
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      mode: "npm_dynamic_discovery",
      scanned_packages: result.scannedPackages,
      findings: result.findings.length,
      novel: result.novel.length,
      known: result.known.length,
      unpreparable: result.unpreparable.slice(0, 20),
      per_detector: result.perDetector.map((d) => ({ detectorId: d.detectorId, packagesRun: d.packagesRun, candidates: d.candidates, confirmed: d.confirmed, novel: d.novel })),
      leads: result.novel.slice(0, 20).map((f) => ({ title: f.title, severity: f.severity })),
      warnings: result.warnings.slice(0, 10),
      note: "Behavioural detections (network egress, credential/filesystem access, install-script execution) are the high-signal output. A clean dynamic run is not proof of safety — the malicious path may be gated on an environment the sandbox did not present.",
    },
  };
}

// ── GROUP 3.3 — weaponize_kernel (flag + scope + kernel-VM artifacts) ──

export async function executeWeaponizeKernel(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!featureFlags.kernelWeaponize) {
    return errResult("weaponize_kernel is disabled. Set 0SEC_FEATURE_KERNEL_WEAPONIZE=1 to enable (it runs inside a disposable kernel VM only).");
  }
  if (!hasEngagementScope(ctx)) {
    return errResult("weaponize_kernel requires an active engagement scope. It is not available for a no-scope session.");
  }

  const { runWeaponization, kernelVmArtifactsReady } = await import("../../kernel/exploit/harness.js");
  if (!kernelVmArtifactsReady()) {
    return errResult(
      "weaponize_kernel is denied: kernel-VM artifacts are not present. It only ever runs inside a DISPOSABLE kernel VM — set 0SEC_KERNEL_QEMU_KERNEL and 0SEC_KERNEL_QEMU_DISK to existing image paths. Refusing to run without the VM.",
    );
  }

  const dmesg = typeof args.dmesg === "string" ? args.dmesg : "";
  if (!dmesg.trim()) return errResult("`dmesg` is required (the kernel crash log / KASAN splat to weaponize).");

  const { classifyPrimitiveFromDmesg } = await import("../../triage/kernel-primitive.js");
  const crashType = typeof args.crash_type === "string" && args.crash_type.trim() ? args.crash_type.trim() : undefined;
  const primitive = classifyPrimitiveFromDmesg(dmesg, crashType);

  const reproducer = typeof args.reproducer === "string" && args.reproducer.trim() ? args.reproducer : undefined;
  const maxStrategies = typeof args.max_strategies === "number" && args.max_strategies > 0 ? Math.trunc(args.max_strategies) : undefined;

  let result;
  try {
    // Deliberately do NOT inject vmRunner / artifactsReady — that would bypass
    // the real kernel-VM env gate. The default runner boots the disposable VM.
    result = await runWeaponization({
      primitive,
      ...(reproducer ? { reproducer } : {}),
      ...(maxStrategies !== undefined ? { maxStrategies } : {}),
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      mode: "weaponize_kernel",
      ran: result.ran,
      primitive: { kind: primitive.kind, control: primitive.control, exploitability: primitive.exploitability, confidence: primitive.confidence },
      highest_rung: result.highestRung,
      attempts: result.attempts.slice(0, 15).map((a) => ({ strategyId: a.strategyId, title: a.title, reachedRung: a.reachedRung, compiled: a.compiled, executed: a.executed, reason: a.reason })),
      reason: result.reason,
      note: "Ran inside the disposable kernel VM. A reached rung of `root`/`arb-write` demonstrates a primitive IN THE VM — a reproduced kernel finding, NOT a deployed exploit. Never point this at production.",
    },
  };
}

// ── GROUP 3.4 — cve_adapt (flag + scope + kernel-VM artifacts) ──

export async function executeCveAdapt(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!featureFlags.cveAdapt) {
    return errResult("cve_adapt is disabled. Set 0SEC_FEATURE_CVE_ADAPT=1 to enable (it adapts + RUNS a CVE PoC).");
  }
  if (!hasEngagementScope(ctx)) {
    return errResult("cve_adapt requires an active engagement scope. It is not available for a no-scope session.");
  }

  const { kernelVmArtifactsReady } = await import("../../kernel/exploit/harness.js");
  if (!kernelVmArtifactsReady()) {
    return errResult(
      "cve_adapt is denied: its default verification boots a kernel VM and kernel-VM artifacts are not present. Set 0SEC_KERNEL_QEMU_KERNEL and 0SEC_KERNEL_QEMU_DISK to existing image paths. Refusing to run without the VM.",
    );
  }

  const { adaptAndVerify } = await import("../../cve/adapt-loop.js");
  const { findCveArtifacts, normaliseCveId } = await import("../../cve/artifact-scraper.js");

  const rawCve = String(args.cve ?? "").trim();
  if (!rawCve) return errResult("`cve` is required, e.g. CVE-2024-1086.");
  let cveId: string;
  try {
    cveId = normaliseCveId(rawCve);
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const kernelTreeArg = typeof args.kernel_tree === "string" ? args.kernel_tree.trim() : "";
  if (!kernelTreeArg) return errResult("`kernel_tree` is required (the kernel source tree to build/verify against).");

  const { resolve } = await import("node:path");
  let kernelTree: string;
  try {
    kernelTree = resolve(scopedPath(ctx, kernelTreeArg));
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  const attempts = typeof args.attempts === "number" && args.attempts > 0 ? Math.trunc(args.attempts) : undefined;
  const wallClockMs = typeof args.wall_clock_ms === "number" && args.wall_clock_ms > 0 ? args.wall_clock_ms : undefined;

  // Adapt the read-only scraper's snake_case artifacts into the adapt-loop's
  // typed CveArtifacts seam (the two shapes are deliberately NOT interchangeable
  // — see cve/index.ts). This gives cve_adapt a live scraper-backed provider
  // instead of the CLI's manual --artifacts JSON file.
  const inferLang = (url: string): "c" | "py" | "sh" | "syz" => {
    const u = url.toLowerCase();
    if (u.endsWith(".py")) return "py";
    if (u.endsWith(".sh")) return "sh";
    if (u.endsWith(".syz") || u.includes("syzkaller")) return "syz";
    return "c";
  };
  const artifactProvider = async (id: string): Promise<import("../../cve/types.js").CveArtifacts> => {
    const scraped = await findCveArtifacts(id);
    const pocCandidates: import("../../cve/types.js").PocCandidate[] = scraped.poc_urls.map((p) => {
      const source: "github-raw" | "gist" | "inline-writeup" = /gist\.github\.com/i.test(p.url) ? "gist" : "github-raw";
      // The scraper's PocLanguage ("python"/"shell"/"syz"/…) → the adapt-loop
      // seam's ("c"|"py"|"sh"|"syz"); fall back to a filename guess.
      const language: "c" | "py" | "sh" | "syz" =
        p.language === "c" ? "c"
        : p.language === "python" ? "py"
        : p.language === "shell" ? "sh"
        : p.language === "syz" ? "syz"
        : inferLang(p.url);
      return { url: p.url, source, language, confidence: p.confidence, ...(p.label ? { note: p.label } : {}) };
    });
    return {
      cveId: scraped.cve_id,
      ...(scraped.description ? { writeupText: scraped.description } : {}),
      pocCandidates,
    };
  };

  let result;
  try {
    result = await adaptAndVerify(cveId, {
      kernelTree,
      artifactProvider,
      ...(attempts !== undefined ? { attempts } : {}),
      ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    });
  } catch (error) {
    return errResult(error instanceof Error ? error.message : String(error));
  }

  return {
    success: true,
    output: {
      mode: "cve_adapt",
      cveId: result.cveId,
      status: result.status, // confirmed | unreproduced | no_artifact | budget_exhausted
      attempts: result.attempts.length,
      final_poc_path: result.final_poc_path ?? null,
      signature: result.signature ?? null,
      total_ms: result.total_ms,
      note: result.status === "confirmed"
        ? "CONFIRMED — an adapted PoC reproduced the CVE against the target kernel (in the VM)."
        : "Not confirmed. A failed adaptation is NOT proof of non-exposure — the PoC may need a different offset/version tweak.",
    },
  };
}
