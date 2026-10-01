import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Finding, ScanReport } from "@0/shared";
import {
  LinuxBootMatrixImportAdapter, LinuxKernelResearchAdapter, MobileStaticResearchAdapter,
  UnifiedPipelineResearchAdapter, runResearch, runPipeline, workflowPolicyRuntime,
  type NativeRuntime, type WorkflowExecutorRegistry, type WorkflowAssessmentContext,
  type ResearchRunResult,
} from "@0/core";
import { loadFindingFocus } from "./finding-focus.js";

const integer = z.number().int().positive();
const researchInputs = z.object({
  engine: z.enum(["pipeline", "mobile", "linux-matrix", "linux"]).default("pipeline"),
  artifactRoot: z.string().min(1).optional(), targetType: z.enum(["url", "web-app", "source-code", "npm-package", "pypi-package", "cargo-package", "oci-image"]).optional(),
  profile: z.string().min(1).optional(), matrixPath: z.string().min(1).optional(), reproducerPath: z.string().min(1).optional(),
  expectedSignature: z.string().trim().min(1).optional(), boots: integer.max(16).default(3), minHits: integer.max(16).default(2),
  findingId: z.string().min(1).optional(), fromStep: z.string().optional(), scanId: z.string().optional(), artifactId: z.string().optional(),
});
const deepInputs = z.object({
  profile: z.string().min(1).optional(), subsystem: z.string().min(1).optional(), models: z.array(z.string().min(1)).min(1).max(8).optional(),
  attemptsPerCandidate: integer.max(16).optional(), concurrency: integer.max(32).optional(), maxCandidates: integer.max(5000).optional(),
  quorum: integer.max(32).optional(), useThreatModel: z.boolean().optional(),
  fromStep: z.string().optional(), findingId: z.string().optional(), scanId: z.string().optional(), artifactId: z.string().optional(),
});
function contained(root: string, path: string): boolean { const suffix = relative(root, path); return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`); }
/** Resolve existing ancestors too, so a new output directory cannot escape via a symlink. */
async function scopedPath(workspace: string, input: string, existing = true): Promise<string> {
  const root = await realpath(workspace);
  const path = resolve(root, input);
  let ancestor = path;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      if (!contained(root, canonical)) throw new Error("Research path is outside the workflow workspace.");
      if (existing && ancestor !== path) throw new Error("Research input path does not exist.");
      return resolve(canonical, relative(ancestor, path));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
async function validateMatrixPaths(workspace: string, matrix: string): Promise<void> {
  const manifest = JSON.parse(await readFile(matrix, "utf8")) as { vulnerable?: { boots?: Array<{ logPath?: unknown }> }; patched?: { boots?: Array<{ logPath?: unknown }> } };
  for (const side of [manifest.vulnerable, manifest.patched]) {
    if (!side || !Array.isArray(side.boots)) throw new Error("Invalid boot-matrix manifest sides.");
    for (const boot of side.boots) {
      if (typeof boot.logPath !== "string" || !boot.logPath) throw new Error("Boot-matrix logs require explicit paths.");
      await scopedPath(workspace, resolve(dirname(matrix), boot.logPath));
    }
  }
}
function report(context: WorkflowAssessmentContext, findings: Finding[], warnings: string[], started: number): ScanReport {
  return {
    target: context.target, scanDepth: context.plan.depth, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - started,
    findings, warnings: warnings.map(message => ({ stage: "source-analysis", message })),
    summary: { totalAttacks: 0, totalFindings: findings.length, critical: findings.filter(f => f.severity === "critical").length, high: findings.filter(f => f.severity === "high").length,
      medium: findings.filter(f => f.severity === "medium").length, low: findings.filter(f => f.severity === "low").length, info: findings.filter(f => f.severity === "info").length },
  };
}
function boundFinding(context: WorkflowAssessmentContext, id: string | undefined, dbPath?: string): Finding {
  const candidates = context.priorReports.flatMap(report => report.findings);
  if (id) return candidates.find(finding => finding.id === id) ?? loadFindingFocus(id, { dbPath }).finding;
  if (candidates.length === 1) return candidates[0];
  throw new Error("Kernel research requires an exact findingId or one connected finding.");
}
export async function validateResearchWorkflowInputs(type: "research" | "deep-review", inputs: Readonly<Record<string, unknown>>, scope?: { workspace: string; target?: string }): Promise<void> {
  if (type === "deep-review") { deepInputs.parse(inputs); if (scope?.target) await scopedPath(scope.workspace, scope.target); return; }
  const value = researchInputs.parse(inputs);
  if (value.engine === "linux") throw new Error("Managed Linux reproducer research is unavailable: the kernel VM/build runner does not yet support workflow cancellation and deadlines. Use the explicit research linux command.");
  if (scope) {
    if (value.engine === "pipeline" && value.targetType && value.targetType !== "source-code") throw new Error("Managed local research requires targetType source-code.");
    await scopedPath(scope.workspace, value.artifactRoot ?? ".0/workflow-artifacts", false);
    if ((value.engine === "mobile" || value.engine === "pipeline") && scope.target) await scopedPath(scope.workspace, scope.target);
    if (value.engine === "linux-matrix" && (value.matrixPath ?? scope.target)) {
      const matrix = await scopedPath(scope.workspace, (value.matrixPath ?? scope.target)!);
      await validateMatrixPaths(scope.workspace, matrix);
    }
  }
}
export interface ResearchWorkflowExecutorOptions { runtime: NativeRuntime; workspace: string; dbPath?: string; model?: string }
/** Existing research engines keep their native evidence and promotion gates. */
export function createResearchWorkflowExecutors(options: ResearchWorkflowExecutorOptions): WorkflowExecutorRegistry {
  return {
    research: async context => {
      context.signal.throwIfAborted();
      await validateResearchWorkflowInputs("research", context.inputs, { workspace: options.workspace, target: context.target });
      const input = researchInputs.parse(context.inputs);
      const artifactRoot = await scopedPath(options.workspace, input.artifactRoot ?? ".0/workflow-artifacts", false);
      await mkdir(artifactRoot, { recursive: true });
      const started = Date.now();
      let result: ResearchRunResult;
      if (input.engine === "pipeline") {
        const sourceTarget = await scopedPath(options.workspace, context.target);
        const runtime = workflowPolicyRuntime(options.runtime);
        const adapter = new UnifiedPipelineResearchAdapter(config => runPipeline({ ...config, nativeRuntime: runtime, signal: context.signal, costLedger: context.costLedger,
          costCeilingUsd: context.plan.costCapUsd, plan: context.plan, timeout: Math.max(1, context.deadline - Date.now()), model: options.model, priorFindings: context.priorFindings }));
        result = await runResearch(adapter, { kind: "pipeline.unified", id: context.node.id, location: sourceTarget,
          config: { options: { depth: context.plan.depth, format: "json", runtime: "api", targetType: "source-code", ...(input.profile ? { reviewProfile: input.profile as "default" } : {}) } } }, { artifactRoot, signal: context.signal });
      } else if (input.engine === "mobile") {
        const target = await scopedPath(options.workspace, context.target);
        result = await runResearch(new MobileStaticResearchAdapter(), { kind: "mobile.static-intake", id: context.node.id, location: target, config: {} }, { artifactRoot, signal: context.signal });
      } else {
        const finding = boundFinding(context, input.findingId, options.dbPath);
        if (input.engine === "linux-matrix") {
          const matrix = await scopedPath(options.workspace, input.matrixPath ?? context.target);
          result = await runResearch(new LinuxBootMatrixImportAdapter(), { kind: "linux.kernel-boot-matrix-import", id: context.node.id, location: matrix, config: { finding } }, { artifactRoot, signal: context.signal });
          if (!result.candidates.length) return { status: "failed", error: "External boot-matrix manifest failed validation.", outputs: [{ kind: "research", value: result }] };
        } else {
          if (!input.reproducerPath || !input.expectedSignature) throw new Error("Linux research requires reproducerPath and expectedSignature.");
          if (input.minHits > input.boots) throw new Error("minHits cannot exceed boots.");
          const tree = await scopedPath(options.workspace, context.target);
          const reproducer = await scopedPath(options.workspace, input.reproducerPath);
          const verify = { ...(reproducer.endsWith(".syz") ? { syzProgramPath: reproducer } : { reproducerPath: reproducer }), boots: input.boots, minHits: input.minHits, expectedSignature: input.expectedSignature,
            signal: context.signal };
          result = await runResearch(new LinuxKernelResearchAdapter(), { kind: "linux.kernel-reproducer", id: context.node.id, location: tree, config: { finding, verify } }, { artifactRoot, signal: context.signal });
        }
      }
      return { status: result.completed ? "completed" : "failed", reports: [report(context, result.findings.map(item => item.finding), result.warnings, started)],
        outputs: [{ kind: "research", value: result, artifactRefs: result.envelopePath ? [result.envelopePath] : [] }] };
    },
    "deep-review": async context => {
      context.signal.throwIfAborted();
      const input = deepInputs.parse(context.inputs);
      const target = await scopedPath(options.workspace, context.target);
      const selected = options.model ?? options.runtime.resolvedModel?.();
      if (input.models?.some(model => model !== selected)) throw new Error("Workflow deep review models must match its bound model connection.");
      const { runDeepReview } = await import("./commands/deep-review.js");
      const result = await runDeepReview({ ...input, target, runtime: "api", nativeRuntime: workflowPolicyRuntime(options.runtime), signal: context.signal,
        costLedger: context.costLedger, plan: context.plan, costCeilingUsd: context.plan.costCapUsd, timeoutMs: Math.max(1, context.deadline - Date.now()) });
      return { status: result.exitCode === 0 ? "completed" : "failed", reports: result.report ? [result.report] : [],
        ...(result.exitCode !== 0 ? { error: `Deep review did not complete (exit ${result.exitCode}).` } : {}), outputs: [{ kind: "deep-review", value: result }] };
    },
  };
}
