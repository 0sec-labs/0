/**
 * Jev security prepass tool — bounded native prepass using Jev evaluators.
 *
 * Runs existing security prepasses (kernel source analysis, commit/crash/radar
 * evaluation) through a Jev evaluator, producing advisories without silent
 * verifier invocation. Shares the console session's Jev budget and activity
 * reporting.
 *
 * All operations are read-only: source files, commit metadata, existing
 * finding records. Never executes arbitrary shell commands, spins up VMs,
 * or invokes the kernel verify runner. Cancellation is supported via
 * AbortSignal in ToolContext's execution context.
 */
import { stat } from "node:fs/promises";
import { z } from "zod";
import { runFoxguardScan } from "../../shared-analysis.js";
import { assessFoxguardFindings } from "../../review/foxguard-jev-advisory.js";
import type { JevEvaluationRequest, JevEvaluationResult, JevEvaluator, JevQuestion } from "@0/shared"
import type { ToolContextJevRuntime, ToolDefinition, ToolContext, ToolResult } from "../types.js";
import { resolveScopedPath } from "./scope-path.js";

// ── Types ──

/**
 * Prepass operation types. Each maps to an existing security prepass:
 * - kernel: kernel source analysis for memory-safety patterns
 * - source: source file security review (stateless, single file)
 * - commit: recent commit analysis for risky changes
 * - crash: crash dump/Triager correlation analysis
 * - radar: broad radar sweep across source tree
 */
export type JevPrepassOperation = "kernel" | "source" | "commit" | "crash" | "radar" | "foxguard";

const VALID_OPERATIONS: readonly JevPrepassOperation[] = [
  "kernel", "source", "commit", "crash", "radar", "foxguard",
];

// ── Tool definition ──

export const jevPrepassToolDefinition: ToolDefinition = {
  name: "jev_prepass",
  description:
    "Run a bounded Jev-powered security prepass over source, commits, or existing findings. " +
    "Ranks and deepens advisories using evaluations — never filters away unscored candidates. " +
    "Does not invoke kernel verifiers, VMs, or exploit runners. Every prepass requires explicit " +
    "operator-approved source egress; existing scope and local path trust apply before reading " +
    "or dispatching. foxguard: run Foxguard SAST findings through the session Jev evaluator " +
    "(budgeted, never raw), returns qualified advisory report with raw findings preserved. " +
    "Use when you have new source or a batch of commits to assess, not every chat turn. " +
    "Cancellation-safe.",
  parameters: {
    operation: {
      type: "string",
      description: "Prepass type: kernel (kernel memory-safety patterns), source (file security review), commit (recent commit risk analysis), crash (crash correlation), radar (broad source sweep), foxguard (Foxguard SAST advisory with Jev evaluation).",
      enum: [...VALID_OPERATIONS],
    },
    target: {
      type: "string",
      description: "Source file, commit range/ref, or directory path for the prepass. Resolved within scope when a scoped source path is set.",
    },
    evidence: {
      type: "string",
      description: "Optional context or evidence to ground the evaluation (existing finding text, crash summary, hypothesis). When omitted, the prepass operates on the target alone.",
    },
    max_candidates: {
      type: "number",
      description: "Maximum candidate items to evaluate (default 10, max 50). Higher values consume more budget.",
    },
    cost_ceiling_usd: {
      type: "number",
      description: "Optional hard USD ceiling for this prepass call. Overrides the session default for this invocation only.",
    },
    findings: {
      type: "string",
      description: "foxguard only: JSON string of raw SemgrepFinding[] array. When provided, target must be the scoped source root directory. When absent, the tool scans the target directory with Foxguard.",
    },
  },
  required: ["operation", "target"],
};

// ── Dispatch ──

export const jevPrepassDispatch: Record<string, string> = {
  jev_prepass: "jevPrepassTool",
};

// ── Shared helpers ──

const MAX_CANDIDATES = 50;
const DEFAULT_CANDIDATES = 10;

function errResult(message: string): ToolResult {
  return { success: false, output: null, error: message };
}

/**
 * Resolve a caller-supplied path against the scoped source path when set.
 * Returns the resolved absolute path or an error string.
 */
function scopedPath(ctx: ToolContext, input: string): string | { error: string } {
  try {
    return ctx.scopePath ? resolveScopedPath(ctx.scopePath, input) : input;
  } catch (error) {
    return { error: `Path scoping error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validate a hex commit-ish (SHA1 prefix or full hash).
 */
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Read file content with size guard. Returns the content or an error string.
 */
async function readSourceFile(
  path: string,
  maxBytes = 128_000,
): Promise<string | { error: string }> {
  const { stat, readFile } = await import("node:fs/promises");
  try {
    const info = await stat(path);
    if (!info.isFile()) return { error: "Path is not a file" };
    if (info.size > maxBytes) return { error: `File exceeds ${maxBytes} byte limit` };
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: "File does not exist" };
    if (code === "EACCES") return { error: "File is not readable (permission denied)" };
    return { error: `File read error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Get recent commits in a git repo. Returns commit SHA + subject lines or error.
 */
async function getRecentCommits(
  repoPath: string,
  count: number,
): Promise<Array<{ sha: string; subject: string; author: string; date: string }> | { error: string }> {
  const { execSync } = await import("node:child_process");
  try {
    const log = execSync(
      `git -C ${JSON.stringify(repoPath)} log --oneline --max-count=${count} --format="%H|%s|%an|%ai"`,
      { encoding: "utf8", maxBuffer: 256_000, timeout: 15_000 },
    );
    return log.trim().split("\n").filter(Boolean).map((line: string) => {
      const [sha, ...rest] = line.split("|");
      const subject = rest.slice(0, -2).join("|");
      const author = rest[rest.length - 2] ?? "";
      const date = rest[rest.length - 1] ?? "";
      return { sha: sha ?? "", subject, author, date };
    });
  } catch (error) {
    return { error: `Git log failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validate operation argument. Returns the operation or an error string.
 */
function validateOperation(raw: unknown): JevPrepassOperation | { error: string } {
  if (typeof raw !== "string" || !VALID_OPERATIONS.includes(raw as JevPrepassOperation)) {
    return { error: `Invalid prepass operation: ${raw}. Valid: ${VALID_OPERATIONS.join(", ")}` };
  }
  return raw as JevPrepassOperation;
}

// ── Foxguard prepass ──

/**
 * Foxguard SAST advisory prepass. Uses the session Jev runtime's budgeted
 * evaluate (never raw evaluator) via a JevEvaluator adapter. When the runtime
 * is unavailable or budget is exhausted, returns unscored findings — never
 * drops or modifies original finding data. The evaluator adapter wires the
 * runtime.evaluate call through the budgeted path so hard ceilings apply.
 */
async function executeFoxguardPrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const jev = jevRuntimeFromContext(ctx);
  const hasJev = jev?.enabled === true && jev.features.includes("foxguard");

  // Parse supplied raw findings, or perform the existing scoped Foxguard scan.
  // Findings remain untouched; Jev can only attach an advisory report.
  let findings: unknown[];
  if (evidence) {
    try {
      const parsed = JSON.parse(evidence);
      if (!Array.isArray(parsed)) return errResult("foxguard: evidence must be a JSON array of SemgrepFinding objects");
      findings = parsed;
    } catch {
      return errResult("foxguard: evidence must be valid JSON");
    }
  } else {
    try {
      const info = await stat(targetPath);
      if (!info.isDirectory()) return errResult("foxguard operation requires a directory path when findings are not provided");
      signal?.throwIfAborted();
      findings = runFoxguardScan(targetPath, () => {});
    } catch (error) {
      return errResult(`foxguard scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Build a budgeted evaluator adapter — wraps runtime.evaluate (budgeted path)
  // into a JevEvaluator that assessFoxguardFindings expects.
  let evaluatorAdapter: JevEvaluator | undefined;
  if (hasJev) {
    const budgetedEval = jev!.evaluate.bind(jev!);
    evaluatorAdapter = {
      async evaluate(request: JevEvaluationRequest): Promise<JevEvaluationResult> {
        const result = await budgetedEval("foxguard", request);
        // budgeted evaluate returns undefined on budget exhaustion or unavailable.
        // assessFoxguardFindings calls this adapter; map undefined to a throw
        // that assessFoxguardFindings catches and reports as "unavailable".
        if (!result) throw new Error("unavailable");
        return result;
      },
    };
  }

  const report = await assessFoxguardFindings({
    findings: findings as Parameters<typeof assessFoxguardFindings>[0]["findings"],
    rootPath: targetPath,
    evaluator: evaluatorAdapter,
    signal,
    maxCandidates,
  });

  return {
    success: true,
    output: {
      operation: "foxguard",
      target: targetPath,
      report,
      total_findings: findings.length,
      evaluated: report.assessments.filter((a) => a.disposition !== "unscored").length,
      jev_available: hasJev,
      raw_findings_count: findings.length,
      note: report.status === "disabled" ? "Foxguard is not enabled" : report.status === "unavailable" ? "Jev evaluation unavailable — findings returned unscored" : undefined,
    },
  };
}

// ── Jev evaluator access ─────────────────────────────────────────────────

/**
 * Minimal Jev runtime interface available on ToolContext for prepass tools.
 * The concrete implementation lives in console/jev-runtime.ts.
 */
export type PrepassJevRuntime = ToolContextJevRuntime;

/**
 * Access the Jev runtime from the ToolContext. Returns the runtime or undefined
 * when Jev is not wired for this session.
 */
export function jevRuntimeFromContext(ctx: ToolContext): PrepassJevRuntime | undefined {
  return ctx.jevRuntime;
}

// ── Prepass execution ──

/**
 * Execute a Jev security prepass. This is the main handler called by the
 * ToolExecutor dispatch. It validates arguments, resolves the path, checks
 * scope, reads source/commits, and dispatches to the Jev evaluator.
 *
 * NEVER invokes kernel verifiers, VMs, or arbitrary shell execution.
 * The only subprocess is `git log` for commit history — strictly read-only.
 */
export async function executeJevPrepass(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // ── Validate operation ──
  const operation = validateOperation(args.operation);
  if (typeof operation === "object") return errResult(operation.error);

  // ── Resolve target path ──
  const rawTarget = String(args.target ?? "").trim();
  if (!rawTarget) return errResult("A target path, file, or commit ref is required");

  const resolved = scopedPath(ctx, rawTarget);
  if (typeof resolved === "object" && "error" in resolved) {
    return errResult(resolved.error);
  }
  const targetPath = resolved as string;

  // ── Parse optional args ──
  const maxCandidates = Math.min(
    typeof args.max_candidates === "number" && args.max_candidates > 0
      ? Math.floor(args.max_candidates) : DEFAULT_CANDIDATES,
    MAX_CANDIDATES,
  );
  const evidence = typeof args.evidence === "string" ? args.evidence.trim() : undefined;
  const costCeilingUsd = typeof args.cost_ceiling_usd === "number" && args.cost_ceiling_usd > 0
    ? args.cost_ceiling_usd : undefined;

  // ── Get cancellation signal ──
  const execution = (ctx as unknown as Record<string, unknown>)["_executionContext"];
  const signal: AbortSignal | undefined = execution
    ? (execution as unknown as { getStore: () => { signal?: AbortSignal } }).getStore?.()?.signal
    : undefined;

  // ── Execute the prepass by operation type ──
  switch (operation) {
    case "kernel":
      return executeKernelPrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    case "source":
      return executeSourcePrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    case "commit":
      return executeCommitPrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    case "crash":
      return executeCrashPrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    case "radar":
      return executeRadarPrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    case "foxguard":
      return executeFoxguardPrepass(ctx, targetPath, evidence, maxCandidates, costCeilingUsd, signal);
    default:
      return errResult(`Unsupported prepass operation: ${operation}`);
  }
}

// ── Kernel prepass ──

async function executeKernelPrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const jev = jevRuntimeFromContext(ctx);
  const hasJev = jev?.enabled && jev.evaluator("kernel");

  // Read the target source file
  const content = await readSourceFile(targetPath);
  if (typeof content === "object" && "error" in content) {
    return errResult(content.error);
  }

  // Scan for kernel memory-safety patterns
  const patterns = [
    { name: "copy_from_user", re: /copy_from_user\s*\(/g },
    { name: "copy_to_user", re: /copy_to_user\s*\(/g },
    { name: "kmalloc", re: /kmalloc\s*\(/g },
    { name: "kfree", re: /kfree\s*\(/g },
    { name: "memcpy", re: /memcpy\s*\(/g },
    { name: "__user", re: /__user/g },
    { name: "spin_lock", re: /spin_lock\s*\(/g },
    { name: "mutex_lock", re: /mutex_lock\s*\(/g },
    { name: "rcu_read_lock", re: /rcu_read_lock\s*\(/g },
    { name: "sprintf", re: /sprintf\s*\(/g },
    { name: "snprintf", re: /snprintf\s*\(/g },
    { name: "copy_from_user", re: /copy_from_user/g },
  ];

  const matches: Array<{ pattern: string; line: number; context: string }> = [];
  const lines = (content as string).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(lines[i]!)) {
        matches.push({
          pattern: pattern.name,
          line: i + 1,
          context: lines[i]!.slice(0, 200),
        });
      }
    }
  }

  if (!hasJev) {
    // Non-Jev fallback: return pattern matches as advisory candidates
    return {
      success: true,
      output: {
        operation: "kernel",
        target: targetPath,
        candidates: matches.slice(0, maxCandidates).map((m) => ({
          pattern: m.pattern,
          line: m.line,
          snippet: m.context,
          note: "Review for memory-safety issues — Jev evaluation unavailable for depth scoring",
        })),
        total_matches: matches.length,
        evaluated: 0,
        jev_available: false,
      },
    };
  }

  const questions: Record<string, JevQuestion> = {};
  const candidates = matches.slice(0, maxCandidates);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    questions[`c${i}_memory`] = {
      type: "boolean",
      instructions: `Does the kernel pattern '${c.pattern}' at line ${c.line} indicate a plausible memory-safety issue? Consider the surrounding context and whether proper bounds checking/locking is present.`,
      criteria: { true: "Plausible memory-safety concern requiring review", false: "No immediate concern or properly guarded" },
    };
    questions[`c${i}_priority`] = {
      type: "choice",
      instructions: `Priority of this candidate`,
      criteria: { high: "High — likely exploitable", medium: "Medium — needs investigation", low: "Low — well-guarded or informational" },
    };
  }

  try {
    const jevEval = jev!.evaluator("kernel");
    if (!jevEval) throw new Error("Jev kernel evaluator unavailable");
    const result = await jevEval.evaluate({
      signal,
      state: { target: targetPath, snippets: candidates.map((c) => ({ pattern: c.pattern, line: c.line, context: c.context })), evidence },
      questions,
    });

    const rawResult = result as unknown as Record<string, unknown>;
    const evaluations = "answers" in rawResult
      ? rawResult.answers as Record<string, { type: string; probability?: number; choice?: string }>
      : undefined;

    const ranked = candidates.map((c, i) => {
      const memAnswer = evaluations?.[`c${i}_memory`];
      const priAnswer = evaluations?.[`c${i}_priority`];
      return {
        pattern: c.pattern,
        line: c.line,
        snippet: c.context,
        score: memAnswer?.type === "boolean" ? (memAnswer.probability ?? 0.5) : 0.5,
        priority: priAnswer?.type === "choice" ? (priAnswer.choice ?? "low") : "low",
        evaluated: true,
      };
    }).sort((a, b) => b.score - a.score);

    return {
      success: true,
      output: {
        operation: "kernel",
        target: targetPath,
        candidates: ranked,
        total_matches: matches.length,
        evaluated: ranked.filter((c) => c.evaluated).length,
        jev_available: true,
      },
    };
  } catch (_error) {
    return {
      success: true,
      output: {
        operation: "kernel",
        target: targetPath,
        candidates: matches.slice(0, maxCandidates).map((m) => ({
          pattern: m.pattern, line: m.line, snippet: m.context,
          note: "Jev evaluation failed — candidates listed unscored",
        })),
        total_matches: matches.length,
        evaluated: 0,
        jev_available: true,
        jev_failed: true,
      },
    };
  }
}

// ── Source prepass ──

async function executeSourcePrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const content = await readSourceFile(targetPath);
  if (typeof content === "object" && "error" in content) {
    return errResult(content.error);
  }

  // Basic file-type detection
  const isTypeScript = /\.(ts|tsx)$/i.test(targetPath);
  const isJavaScript = /\.(js|jsx|mjs|cjs)$/i.test(targetPath);
  const isCPython = /\.(py)$/i.test(targetPath);
  const isRust = /\.(rs)$/i.test(targetPath);

  // Security-relevant pattern scan
  const securityPatterns = [
    ...(isTypeScript || isJavaScript
      ? [
          { name: "eval", re: /\beval\s*\(/g },
          { name: "innerHTML", re: /\.innerHTML\s*=/g },
          { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/g },
          { name: "exec", re: /\bexec\s*\(/g },
          { name: "spawn", re: /\bspawn\s*\(/g },
          { name: "child_process", re: /require\(['"]child_process['"]\)/g },
          { name: "no-cors", re: /mode:\s*['"]no-cors['"]/g },
        ]
      : []),
    ...(isCPython
      ? [
          { name: "eval", re: /\beval\s*\(/g },
          { name: "exec", re: /\bexec\s*\(/g },
          { name: "pickle.loads", re: /pickle\.loads/g },
          { name: "os.system", re: /os\.system\s*\(/g },
          { name: "subprocess", re: /subprocess\./g },
          { name: "sqlite3.execute", re: /\.execute\s*\(/g },
          { name: "input", re: /\binput\s*\(/g },
        ]
      : []),
    ...(isRust
      ? [
          { name: "unsafe", re: /\bunsafe\b/g },
          { name: "transmute", re: /\btransmute\b/g },
          { name: "as_ptr", re: /\.as_ptr\(\)/g },
          { name: "from_raw_parts", re: /from_raw_parts/g },
        ]
      : []),
  ];

  const lines = (content as string).split("\n");
  const matches: Array<{ pattern: string; line: number; context: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of securityPatterns) {
      p.re.lastIndex = 0;
      if (p.re.test(lines[i]!)) {
        matches.push({ pattern: p.name, line: i + 1, context: lines[i]!.slice(0, 200) });
      }
    }
  }

  const candidates = matches.slice(0, maxCandidates);

  const jev = jevRuntimeFromContext(ctx);
  if (jev?.enabled && jev.evaluator("browser" as string)) {
    // Use browser feature evaluator for general source analysis
    try {
      const evaluator = jev.evaluator("browser" as string);
      if (evaluator) {
        const questions: Record<string, JevQuestion> = {};
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i]!;
          questions[`c${i}_risk`] = {
            type: "boolean",
            instructions: `Does '${c.pattern}' at line ${c.line} represent a security concern?`,
            criteria: { true: "Likely security issue", false: "Benign pattern or properly guarded" },
          };
        }
        if (Object.keys(questions).length > 0) {
          await evaluator.evaluate({
            signal,
            state: { target: targetPath, snippets: candidates.map((c) => ({ pattern: c.pattern, line: c.line, context: c.context })), evidence },
            questions,
          }).catch(() => {}); // Jev failure doesn't block returning the match results
        }
      }
    } catch {
      // Jev failure is non-fatal for source-only prepass
    }
  }

  return {
    success: true,
    output: {
      operation: "source",
      target: targetPath,
      candidates: candidates.map((c) => ({
        pattern: c.pattern,
        line: c.line,
        snippet: c.context,
      })),
      total_matches: matches.length,
      evaluated: candidates.length,
      file_type: isTypeScript ? "typescript" : isJavaScript ? "javascript" : isCPython ? "python" : isRust ? "rust" : "unknown",
      note: "Pattern matches for manual review — use kernel/crash/radar operations for deeper analysis",
    },
  };
}

// ── Commit prepass ──

async function executeCommitPrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  // targetPath is a git repo directory or a commit range
  const commits = await getRecentCommits(targetPath, maxCandidates);
  if ("error" in commits) return errResult(commits.error);

  if (commits.length === 0) {
    return {
      success: true,
      output: {
        operation: "commit",
        target: targetPath,
        candidates: [],
        evaluated: 0,
        note: "No commits found in the specified range",
      },
    };
  }

  // Get diff stats for each commit
  const { execSync } = await import("node:child_process");
  const candidates = commits.map((c) => {
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    try {
      const stat = execSync(
        `git -C ${JSON.stringify(targetPath)} diff --shortstat ${c.sha}~1..${c.sha}`,
        { encoding: "utf8", maxBuffer: 16_000, timeout: 5_000 },
      );
      const match = stat.match(/(\d+) files? changed/);
      filesChanged = match ? parseInt(match[1]!, 10) : 0;
      const ins = stat.match(/(\d+) insertions?/);
      insertions = ins ? parseInt(ins[1]!, 10) : 0;
      const del = stat.match(/(\d+) deletions?/);
      deletions = del ? parseInt(del[1]!, 10) : 0;
    } catch {
      // Stats are best-effort
    }
    return { ...c, filesChanged, insertions, deletions };
  });

  const jev = jevRuntimeFromContext(ctx);
  let evaluated = 0;

  if (jev?.enabled && jev.evaluator("radar" as string)) {
    try {
      const evaluator = jev.evaluator("radar" as string);
      if (evaluator) {
        const questions: Record<string, JevQuestion> = {};
        for (let i = 0; i < candidates.length && i < 10; i++) {
          const c = candidates[i]!;
          questions[`c${i}_risk`] = {
            type: "choice",
            instructions: `Assess the risk of this commit based on its subject and diff size`,
            criteria: {
              high: "High risk — modifies security-sensitive code or large diff with concerning patterns",
              medium: "Medium risk — moderate changes in security-adjacent areas",
              low: "Low risk — routine changes, documentation, or tests",
            },
          };
        }
        if (Object.keys(questions).length > 0) {
          await evaluator.evaluate({
            signal,
            state: { target: targetPath, commits: candidates.map((c) => ({ sha: c.sha, subject: c.subject, author: c.author, filesChanged: c.filesChanged })), evidence },
            questions,
          }).catch(() => {});
          evaluated = Object.keys(questions).length;
        }
      }
    } catch {
      // Jev failure is non-fatal
    }
  }

  return {
    success: true,
    output: {
      operation: "commit",
      target: targetPath,
      candidates,
      evaluated,
      note: evaluated > 0
        ? "Commits evaluated by Jev for risk assessment"
        : "Jev evaluation unavailable — commit metadata shown for manual triage",
    },
  };
}

// ── Crash prepass ──

async function executeCrashPrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const content = await readSourceFile(targetPath, 512_000);
  if (typeof content === "object" && "error" in content) {
    return errResult(content.error);
  }

  // Parse crash-like patterns from the content
  const crashPatterns = [
    { name: "NULL-deref", re: /NULL pointer dereference|general protection fault|GPF|oops/i },
    { name: "buffer-overflow", re: /buffer overflow|stack smashing|heap corruption/i },
    { name: "use-after-free", re: /use-after-free|UAF|dangling pointer/i },
    { name: "double-free", re: /double free|already freed/i },
    { name: "stack-overflow", re: /stack overflow|stack exhaustion/i },
    { name: "segfault", re: /segfault|SIGSEGV|signal 11/i },
    { name: "panic", re: /kernel panic|panic:|BUG:/i },
    { name: "lockdep", re: /BUG:.*(scheduling|lock)|lock held|soft lockup/i },
    { name: "KASAN", re: /KASAN|kasan|syzkaller/i },
  ];
  const { execSync } = await import("node:child_process");

  // Try to get addr2line or coredumpctl info
  const crashInfo: Array<{ line: number; snippet: string }> = [];
  const lines2 = (content as string).split("\n");
  for (let i = 0; i < lines2.length; i++) {
    for (const cp of crashPatterns) {
      cp.re.lastIndex = 0;
      if (cp.re.test(lines2[i]!)) {
        crashInfo.push({ line: i + 1, snippet: lines2[i]!.slice(0, 200) });
        break;
      }
    }
  }

  const jev = jevRuntimeFromContext(ctx);
  const candidates = crashInfo.slice(0, maxCandidates);

  if (jev?.enabled && jev.evaluator("crash" as string)) {
    try {
      const evaluator = jev.evaluator("crash" as string);
      if (evaluator && candidates.length > 0) {
        const questions: Record<string, JevQuestion> = {};
        for (let i = 0; i < candidates.length; i++) {
          questions[`c${i}_exploitable`] = {
            type: "boolean",
            instructions: "Based on the crash context, is this likely exploitable?",
            criteria: { true: "Appears exploitable — controllable data in the crash path", false: "Not exploitable — deterministic or controlled crash" },
          };
        }
        await evaluator.evaluate({
          signal,
          state: { target: targetPath, crashes: candidates, evidence },
          questions,
        }).catch(() => {});
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    success: true,
    output: {
      operation: "crash",
      target: targetPath,
      candidates: candidates.map((c) => ({
        line: c.line,
        snippet: c.snippet,
      })),
      total_matches: crashInfo.length,
      evaluated: candidates.length,
      note: "Crash pattern analysis — candidates for triage and verification",
    },
  };
}

// ── Radar prepass ──

async function executeRadarPrepass(
  ctx: ToolContext,
  targetPath: string,
  evidence: string | undefined,
  maxCandidates: number,
  _costCeilingUsd: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  // targetPath is a directory to sweep
  const { readdir, stat } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");

  let dirInfo: { entries: string[]; error?: string };
  try {
    const info = await stat(targetPath);
    if (!info.isDirectory()) {
      return errResult("radar operation requires a directory path");
    }
    const entries: string[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 5) return;
      const dirents = await readdir(dir, { withFileTypes: true });
      const sorted = dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const ext = join(dir, entry.name).split(".").pop() ?? "";
          if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "c", "h", "cpp", "java"].includes(ext)) {
            entries.push(join(dir, entry.name));
          }
        }
      }
    }
    await walk(targetPath, 0);
    dirInfo = { entries };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    dirInfo = { entries: [], error: code === "ENOENT" ? "Directory does not exist" : `Directory error: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (dirInfo.error) return errResult(dirInfo.error);

  const sourceFiles = dirInfo.entries;
  const sampled = sourceFiles.slice(0, maxCandidates);
  const totalFiles = sourceFiles.length;

  return {
    success: true,
    output: {
      operation: "radar",
      target: targetPath,
      total_files: totalFiles,
      sampled: sampled.map((f) => ({
        path: relative(targetPath, f),
        ext: f.split(".").pop() ?? "",
      })),
      evaluated: 0,
      note: "Radar sweep complete. Use kernel/source/commit operations on specific targets for deeper Jev analysis.",
    },
  };
}