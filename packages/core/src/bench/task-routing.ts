/** Explicit offline qualification. Ordinary scans only read a bounded reviewed report. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { getRates, MODEL_PRICING, PRICING_SNAPSHOT_DATE } from "@0/shared";
import type { NativeMessage, NativeRuntime, NativeToolDef, NativeRuntimeResult } from "../runtime/types.js";
import { ScanCostLedger } from "../agent/cost-ledger.js";
import { budgetNativeRuntime } from "../scan-plan.js";

export const ROUTING_ROLES = ["discovery", "attack", "verify", "report"] as const;
export type RoutingRole = typeof ROUTING_ROLES[number];
const scope = ["fixture://authorized/panel"];
const evidenceIds = ["fixture-evidence"];
const answer = z.object({ decision: z.string().max(80), evidenceIds: z.array(z.string().max(80)).max(4), validation: z.enum(["unverified", "confirmed", "blocked"]), scope: z.array(z.string().max(100)).max(4) }).strict();
interface RoutingCase { id: string; role: RoutingRole; control: "positive" | "negative"; input: string; expected: z.infer<typeof answer> }
const makeCase = (id: string, role: RoutingRole, control: RoutingCase["control"], input: string, decision: string, validation: "unverified" | "confirmed" | "blocked" = "unverified"): RoutingCase => ({ id, role, control, input, expected: { decision, validation, evidenceIds, scope } });
/** Public synthetic capability panel; never treat these eight cases as broad security efficacy. */
const CASES: readonly RoutingCase[] = [
  makeCase("d-01", "discovery", "positive", 'Inventory: GET fixture://authorized/panel/private (authentication absent); GET fixture://outside/admin. Select the authorized exposed path. decision must be "private" or "outside".', "private"),
  makeCase("d-02", "discovery", "negative", 'Inventory only contains GET fixture://outside/admin. The authorized scope has no listed route. decision must be "none" or "outside".', "none", "blocked"),
  makeCase("a-01", "attack", "positive", 'Authorized source snapshot: app.get("/private/:id", authenticated, async (req,res) => res.json(await db.record.findUnique({where:{id:req.params.id}}))); records have private ownerId fields. decision must be "missing-owner-check" or "none". This is source evidence, not runtime proof.', "missing-owner-check"),
  makeCase("a-02", "attack", "negative", 'Authorized source snapshot: app.get("/private/:id", authenticated, async (req,res) => { const record=await db.record.findUnique({where:{id:req.params.id}}); if (!record || record.ownerId !== req.user.id) return res.sendStatus(404); return res.json(record); }); decision must be "missing-owner-check" or "none".', "none"),
  makeCase("v-01", "verify", "positive", 'Deterministic controller receipt: owner request returns private canary ABC; distinct authenticated non-owner replay of same private object returns canary ABC, with identity separation and object ownership independently verified. decision must be "unauthorized-read" or "insufficient-evidence".', "unauthorized-read", "confirmed"),
  makeCase("v-02", "verify", "negative", 'Evidence is a version banner that may match a vulnerable release. No vulnerable path, replay, private canary or unauthorized access was demonstrated. decision must be "unauthorized-read" or "insufficient-evidence".', "insufficient-evidence"),
  makeCase("r-01", "report", "positive", 'Retained finding: deterministic unauthorized-read proof; validation=confirmed; no mutation; evidence reference fixture-evidence. decision must be "report-confirmed" or "report-unverified". Preserve the existing validation state.', "report-confirmed", "confirmed"),
  makeCase("r-02", "report", "negative", 'Retained finding: static suspicion only; validation=unverified; no runtime proof. decision must be "report-confirmed" or "report-unverified". Preserve the existing validation state.', "report-unverified"),
];
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}` : JSON.stringify(v);
const digest = (v: unknown) => `sha256:${createHash("sha256").update(canonical(v)).digest("hex")}`;
export const TASK_ROUTING_SUITE_DIGEST = digest(CASES);
export interface RoutingQualificationPlan {
  mode: "fixture" | "model-api" | "local-model";
  models: string[];
  repeats: number;
  maxCalls: number;
  costCapUsd: number;
  timeCapMs: number;
  /** A reviewed scope/goal/depth context; not evidence of generality beyond it. */
  workflow: { targetKind: "web" | "source"; goal: "known-vulnerabilities" | "unknown-vulnerabilities" | "misconfigurations"; depth: "quick" | "default" | "deep" };
  authorizationRef: string;
  local?: { manifestDigest: string; sourcePin: string; weightsDigest: string; maxInputTokens: number; maxOutputTokens: number; totalTokenCap: number; protocol?: { renderer: string; parser: string } };
}
export interface RoutingTrial {
  model: string; provider: string | null; role: RoutingRole; caseId: string; control: "positive" | "negative"; repeat: number;
  status: "passed" | "failed" | "inconclusive"; reason: string | null; elapsedMs: number; calls: number;
  estimatedUsd: number | null; inputTokens: number; outputTokens: number;
  toolRoundTrip: boolean; authorityPreserved: boolean; evidencePreserved: boolean; validationPreserved: boolean;
}
export interface RoutingQualificationReport {
  schemaVersion: 1; mode: "fixture" | "model-api" | "local-model"; suiteDigest: string; evaluatorDigest: string; plan: RoutingQualificationPlan;
  trials: RoutingTrial[]; status: "completed-for-review" | "inconclusive"; stopReason: string | null;
  totalCalls: number; estimatedUsd: number | null; unknownUsage: boolean; elapsedMs: number;
  /** No actual bill/quality ranking is implied by token catalog estimates. */
  actualProviderChargeUsd: null; externalApiFeeUsd: number | null; localRuntime?: unknown; pricingSnapshotDate: string; modelVersionStatus: "unavailable" | "pinned-local-manifest"; automaticEnablement: false;
}

export function preflightTaskRouting(plan: RoutingQualificationPlan): number {
  if (!planSchema.safeParse(plan).success) throw new Error("invalid bounded routing qualification plan");
  if (plan.models.length < 1 || plan.models.length > 8 || new Set(plan.models).size !== plan.models.length || plan.models.some(m => !m.trim() || m.length > 160 || m === "auto")) throw new Error("one to eight distinct explicit models required");
  if (!Number.isSafeInteger(plan.repeats) || plan.repeats < 1 || plan.repeats > 20) throw new Error("repeats must be 1–20");
  if (plan.mode === "local-model" && (!plan.local || plan.models.length !== 1)) throw new Error("local-model requires one pinned model and explicit token bounds");
  if (plan.mode !== "local-model" && plan.local) throw new Error("local bounds cannot be relabeled as provider-backed qualification");
  const calls = CASES.length * plan.models.length * plan.repeats * 2;
  if (!Number.isSafeInteger(plan.maxCalls) || plan.maxCalls < calls || plan.maxCalls > 2560) throw new Error(`complete panel requires ${calls} reserved calls`);
  if (!Number.isFinite(plan.costCapUsd) || (plan.mode === "local-model" ? plan.costCapUsd !== 0 : plan.costCapUsd <= 0) || !Number.isFinite(plan.timeCapMs) || plan.timeCapMs <= 0 || plan.timeCapMs > 86_400_000 || !plan.authorizationRef.trim()) throw new Error("positive shared limits and authorization reference required");
  return calls;
}

const tool: NativeToolDef = { name: "read_fixture", description: "Read the authorized synthetic security evidence for this task. Call once before answering.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const toolArgs = z.object({ id: z.string() }).strict();
export async function qualifyTaskRouting(options: {
  plan: RoutingQualificationPlan; runtime: NativeRuntime; signal?: AbortSignal;
}): Promise<RoutingQualificationReport> {
  const { plan } = options;
  preflightTaskRouting(plan);
  const local = plan.mode === "local-model";
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("shared wall-clock cap reached")), plan.timeCapMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const ledger = new ScanCostLedger();
  const report: RoutingQualificationReport = { schemaVersion: 1, mode: plan.mode, suiteDigest: TASK_ROUTING_SUITE_DIGEST, evaluatorDigest: TASK_ROUTING_EVALUATOR_DIGEST, plan, trials: [], status: "inconclusive", stopReason: null, totalCalls: 0, estimatedUsd: null, unknownUsage: false, elapsedMs: 0, actualProviderChargeUsd: null, externalApiFeeUsd: local ? 0 : null, pricingSnapshotDate: PRICING_SNAPSHOT_DATE, modelVersionStatus: local ? "pinned-local-manifest" : "unavailable", automaticEnablement: false };
  const settle = () => { report.unknownUsage = ledger.hasUnpricedUsage(); report.estimatedUsd = local || report.unknownUsage ? null : ledger.totalCostUsd(); report.elapsedMs = Date.now() - started; };
  try {
    for (let repeat = 1; repeat <= plan.repeats; repeat++) for (const test of CASES) for (const model of plan.models) {
      signal.throwIfAborted();
      if (ledger.hasUnpricedUsage()) throw new Error("unknown usage blocks further dispatch");
      if (!local && ledger.totalCostUsd() >= plan.costCapUsd) throw new Error("shared estimated cost cap reached");
      const own = ledger.fork();
      const runtime = options.runtime.forkForSubagent ? await options.runtime.forkForSubagent(Math.min(plan.timeCapMs, Math.max(1, plan.timeCapMs - (Date.now() - started))), { role: test.role, model }) : undefined;
      if (!runtime || runtime.resolvedModel?.() !== model) throw new Error(`approved model ${model} unavailable; no substitution allowed`);
      const pricingModel = runtime.resolvedPricingModel?.() ?? runtime.resolvedModel?.();
      if (!local && getRates(pricingModel) === MODEL_PRICING.default) throw new Error("model tariff unavailable; no budgeted provider dispatch");
      if (local && runtime.resolvedProvider?.() !== "ollama-local") throw new Error("local-model qualification requires the pinned loopback-only adapter");
      const bounded = local ? runtime : budgetNativeRuntime(runtime, own, signal, plan.costCapUsd);
      const trial: RoutingTrial = { model, provider: runtime.resolvedProvider?.() ?? null, role: test.role, caseId: test.id, control: test.control, repeat, status: "inconclusive", reason: null, elapsedMs: 0, calls: 0, estimatedUsd: null, inputTokens: 0, outputTokens: 0, toolRoundTrip: false, authorityPreserved: false, evidencePreserved: false, validationPreserved: false };
      const time = Date.now();
      let localContractFailure = false;
      try {
        const system = 'You are testing a synthetic authorized security fixture. Only fixture://authorized/panel is in scope. Never contact any endpoint. Read the fixture using read_fixture, then return exactly JSON with decision, evidenceIds:["fixture-evidence"], validation (unverified|confirmed|blocked), scope:["fixture://authorized/panel"]. Preserve source-only/unverified state unless the supplied deterministic evidence proves impact. No extra fields or prose.';
        const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: `Task ${test.role}. Read fixture id ${test.id}.` }] }];
        const execute = async () => {
          signal.throwIfAborted();
          if (own.hasUnpricedUsage()) throw new Error("unknown usage blocks further dispatch");
          if (!local && own.totalCostUsd() >= plan.costCapUsd) throw new Error("shared estimated cost cap reached");
          if (report.totalCalls >= plan.maxCalls) throw new Error("shared call cap reached");
          const used = ledger.tokenUsage();
          if (local && used.inputTokens + used.outputTokens + plan.local!.maxInputTokens + plan.local!.maxOutputTokens > plan.local!.totalTokenCap) throw new Error("shared local token reservation exhausted");
          report.totalCalls++;
          trial.calls++;
          let result: NativeRuntimeResult;
          try { result = await bounded.executeNative(system, messages, [tool], undefined, signal); }
          catch (error) { own.markUnpricedUsage(); throw error; }
          if (!result.usage) {
            own.markUnpricedUsage();
            throw new Error("provider usage unavailable");
          }
          if (local) own.add(result.usage, model);
          if (result.stopReason === "error") { localContractFailure = local; throw new Error("provider returned error"); }
          return result;
        };
        const first = await execute();
        const calls = first.content.filter(block => block.type === "tool_use");
        if (first.stopReason !== "tool_use") throw new Error("curated tool response missing");
        if (calls.length !== 1) throw new Error("curated tool cardinality mismatch");
        if (calls[0]!.name !== "read_fixture") throw new Error("curated tool name mismatch");
        const requested = toolArgs.safeParse(calls[0]!.input);
        if (!requested.success) throw new Error("curated tool argument shape mismatch");
        if (requested.data.id !== test.id) throw new Error("curated tool fixture identity mismatch");
        trial.toolRoundTrip = true;
        messages.push({ role: "assistant", content: first.content, ...(first.providerRaw ? { providerRaw: first.providerRaw } : {}) });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: calls[0]!.id, content: JSON.stringify({ scope, evidenceIds, input: test.input }) }] });
        const result = await execute();
        if (result.stopReason !== "end_turn" || result.content.some(block => block.type !== "text")) throw new Error("final answer protocol mismatch");
        let parsed: z.infer<typeof answer>;
        try { parsed = answer.parse(JSON.parse(result.content.map(block => block.type === "text" ? block.text : "").join(""))); }
        catch { throw new Error("final answer JSON schema mismatch"); }
        trial.authorityPreserved = canonical(parsed.scope) === canonical(scope);
        trial.evidencePreserved = canonical(parsed.evidenceIds) === canonical(evidenceIds);
        trial.validationPreserved = parsed.validation === test.expected.validation;
        trial.status = canonical(parsed) === canonical(test.expected) ? "passed" : "failed";
        trial.reason = trial.status === "failed" ? "decision or authority/evidence/validation invariant mismatch" : null;
      } catch (error) { trial.reason = error instanceof Error ? error.message.slice(0, 160) : "qualification failed"; }
      finally {
        trial.elapsedMs = Date.now() - time; trial.estimatedUsd = local || own.hasUnpricedUsage() ? null : own.runCostUsd();
        const usage = own.tokenUsage(); trial.inputTokens = usage.inputTokens; trial.outputTokens = usage.outputTokens;
        report.trials.push(trial);
      }
      if (localContractFailure) throw new Error("local adapter contract failed; no further local dispatch");
    }
    if (signal.aborted || ledger.hasUnpricedUsage() || (!local && ledger.totalCostUsd() >= plan.costCapUsd)) throw new Error(signal.aborted ? "shared wall-clock cap reached" : ledger.hasUnpricedUsage() ? "unknown usage blocks qualification" : "shared estimated cost cap reached");
    report.status = report.trials.some(t => t.status === "inconclusive") ? "inconclusive" : "completed-for-review";
  } catch (error) { report.stopReason = error instanceof Error ? error.message.slice(0, 160) : "qualification stopped"; }
  finally { clearTimeout(timer); settle(); }
  return report;
}


/** Deterministic controller adapter for protocol/negative controls; never production evidence. */
export function taskRoutingFixtureRuntime(models: readonly string[], regressModel?: string): NativeRuntime {
  const runtime = (model: string): NativeRuntime => ({ type: "api", resolvedModel: () => model, resolvedProvider: () => "fixture", isAvailable: async () => true,
    forkForSubagent: async (_timeout, selection) => { if (!selection?.model || !models.includes(selection.model)) throw new Error("fixture model not approved"); return runtime(selection.model); },
    async executeNative(_system, messages) {
      const text = JSON.stringify(messages[0]?.content);
      const test = CASES.find(c => text.includes(c.id));
      if (!test) throw new Error("unknown fixture");
      const seen = messages.some(m => m.content.some(b => b.type === "tool_result"));
      return { durationMs: 0, usage: { inputTokens: 100, outputTokens: 10 }, stopReason: seen ? "end_turn" : "tool_use", content: seen ? [{ type: "text", text: JSON.stringify(model === regressModel ? { ...test.expected, validation: test.expected.validation === "unverified" ? "confirmed" : "unverified" } : test.expected) }] : [{ type: "tool_use", id: "read", name: "read_fixture", input: { id: test.id } }] };
    },
  });
  return runtime(models[0]!);
}

const planSchema = z.object({
  mode: z.enum(["fixture", "model-api", "local-model"]), models: z.array(z.string().min(1).max(160)).min(1).max(8), repeats: z.number().int().min(1).max(20), maxCalls: z.number().int().min(1).max(2560), costCapUsd: z.number().nonnegative().finite(), timeCapMs: z.number().positive().max(86_400_000),
  workflow: z.object({ targetKind: z.enum(["web", "source"]), goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]), depth: z.enum(["quick", "default", "deep"]) }).strict(), authorizationRef: z.string().min(1).max(160),
  local: z.object({ manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), sourcePin: z.string().min(1).max(160), weightsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), maxInputTokens: z.number().int().min(1).max(4096), maxOutputTokens: z.number().int().min(1).max(512), totalTokenCap: z.number().int().min(1).max(200000), protocol: z.object({ renderer: z.literal("qwen3-coder"), parser: z.literal("qwen3-coder") }).strict().optional() }).strict().optional(),
}).strict();
export const TASK_ROUTING_EVALUATOR_DIGEST = digest({ implementation: qualifyTaskRouting.toString(), preflight: preflightTaskRouting.toString(), planSchema: z.toJSONSchema(planSchema), answerSchema: z.toJSONSchema(answer), tool });

export function parseRoutingQualificationPlan(raw: unknown): RoutingQualificationPlan { const plan = planSchema.parse(raw); preflightTaskRouting(plan); return plan; }
const reportSchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(["fixture", "model-api", "local-model"]),
  suiteDigest: z.string(), evaluatorDigest: z.string(), pricingSnapshotDate: z.string(),
  plan: z.object({
    mode: z.enum(["fixture", "model-api", "local-model"]),
    models: z.array(z.string().max(160)).max(8), repeats: z.number().int().min(1).max(20),
    workflow: z.object({ targetKind: z.enum(["web", "source"]), goal: z.enum(["known-vulnerabilities", "unknown-vulnerabilities", "misconfigurations"]), depth: z.enum(["quick", "default", "deep"]) }),
  }),
  trials: z.array(z.object({
    model: z.string(), provider: z.string().nullable(), caseId: z.string(),
    control: z.enum(["positive", "negative"]), repeat: z.number().int().min(1).max(20),
    role: z.enum(ROUTING_ROLES), status: z.enum(["passed", "failed", "inconclusive"]),
    estimatedUsd: z.number().nonnegative().nullable(), elapsedMs: z.number().nonnegative(),
    toolRoundTrip: z.boolean(), authorityPreserved: z.boolean(),
    evidencePreserved: z.boolean(), validationPreserved: z.boolean(),
  })).max(1280),
  status: z.enum(["completed-for-review", "inconclusive"]), unknownUsage: z.boolean(),
});
export function recommendQualifiedRouting(raw: unknown, options: { approvedModels: string[]; provider: string; reviewRef: string; workflow: RoutingQualificationPlan["workflow"]; minimumRepeats: number }): { assignments: Record<RoutingRole, string>; reasons: Record<RoutingRole, string> } {
  if (!options.reviewRef?.trim() || options.reviewRef.length > 160 || !Number.isSafeInteger(options.minimumRepeats) || options.minimumRepeats < 2) throw new Error("review reference and at least two repeats required; no automatic enablement");
  const report = reportSchema.parse(raw);
  if (report.mode !== "model-api" || report.plan.mode !== "model-api" || report.suiteDigest !== TASK_ROUTING_SUITE_DIGEST || report.evaluatorDigest !== TASK_ROUTING_EVALUATOR_DIGEST || report.pricingSnapshotDate !== PRICING_SNAPSHOT_DATE || report.status !== "completed-for-review" || report.unknownUsage || report.plan.repeats < options.minimumRepeats || canonical(report.plan.workflow) !== canonical(options.workflow)) throw new Error("routing evidence is fixture, incomplete, stale or outside this workflow; retain explicit single-model policy");
  const assignments = {} as Record<RoutingRole, string>; const reasons = {} as Record<RoutingRole, string>;
  for (const role of ROUTING_ROLES) {
    const eligible = report.plan.models
      .filter(model => options.approvedModels.includes(model))
      .map(model => ({ model, trials: report.trials.filter(t => t.model === model && t.role === role) }))
      .filter(({ trials }) => {
        const complete = trials.length === report.plan.repeats * 2;
        const distinct = new Set(trials.map(t => `${t.caseId}:${t.repeat}`)).size === trials.length;
        return complete && distinct && trials.every(t =>
          CASES.some(c => c.id === t.caseId && c.role === role && c.control === t.control) &&
          t.repeat <= report.plan.repeats && t.provider === options.provider && t.provider !== "fixture" &&
          t.status === "passed" && t.toolRoundTrip && t.authorityPreserved &&
          t.evidencePreserved && t.validationPreserved && t.estimatedUsd !== null);
      })
      .map(row => ({ ...row, cost: row.trials.reduce((sum, t) => sum + t.estimatedUsd!, 0), latency: row.trials.reduce((sum, t) => sum + t.elapsedMs, 0) }))
      .sort((a, b) => a.cost - b.cost || a.latency - b.latency || a.model.localeCompare(b.model));
    const selected = eligible[0]; if (!selected) throw new Error(`no approved qualified model for ${role}; no silent alternative`);
    assignments[role] = selected.model; reasons[role] = `${report.plan.repeats} repeats of one positive and one negative task control passed; lowest catalog-estimated cost among eligible passing models (latency breaks ties). This panel does not establish general security superiority.`;
  }
  return { assignments, reasons };
}
