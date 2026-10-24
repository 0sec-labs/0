/** Local-only benign protocol-panel adapter. Never pulls models or sends credentials. */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { NativeContentBlock, NativeMessage, NativeRuntime, NativeRuntimeResult, NativeToolDef } from "../runtime/types.js";
import type { RoutingQualificationPlan } from "./task-routing.js";

const endpoint = "http://127.0.0.1:11434";
const responseSchema = z.object({
  model: z.string(), message: z.object({ content: z.string().max(65536).default(""), tool_calls: z.array(z.object({ function: z.object({ name: z.string().max(160), arguments: z.union([z.record(z.string(), z.unknown()), z.string().max(16000)]) }) })).max(4).optional() }),
  done: z.boolean(), done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative(), eval_count: z.number().int().nonnegative(),
  total_duration: z.number().nonnegative().optional(), load_duration: z.number().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(), eval_duration: z.number().nonnegative().optional(),
});
export interface LocalRoutingObservation {
  adapterDigest: string; endpoint: string; model: string; manifestDigest: string; sourcePin: string; weightsDigest: string;
  runtimeVersion: string | null; inferenceRequests: number; metadataRequests: number;
  measurements: Array<{ inputTokens: number; outputTokens: number; wallMs: number; serverTotalNs: number | null; serverLoadNs: number | null; serverPromptNs: number | null; serverGenerationNs: number | null }>;
  clientCpuMicros: { user: number; system: number }; clientMaxRssKiB: number; clientWallMs: number;
  runtimeReportedResidentModelBytes: number | null; runtimeReportedVramBytes: number | null;
  externalApiFeeUsd: 0; computeCostUsd: null; energyJoules: null;
}
export interface LocalRoutingRuntime extends NativeRuntime { observation(): Promise<LocalRoutingObservation> }

export function createLocalOllamaRoutingRuntime(plan: RoutingQualificationPlan, fetchImpl: typeof fetch = fetch): LocalRoutingRuntime {
  if (plan.mode !== "local-model" || !plan.local || plan.models.length !== 1) throw new Error("one pinned local-model plan required");
  const model = plan.models[0]!;
  const bounds = plan.local;
  const start = Date.now();
  const cpu = process.cpuUsage();
  let metadataRequests = 0;
  let inferenceRequests = 0;
  const measurements: LocalRoutingObservation["measurements"] = [];
  const json = async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(endpoint + path, { ...init, redirect: "error", signal });
    if (!response.ok) throw new Error(`local Ollama ${path} returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("local Ollama response exceeds 2 MB");
    return JSON.parse(text);
  };
  const verify = async (signal?: AbortSignal) => {
    metadataRequests++;
    const tags = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string() })).max(1000) }).parse(await json("/api/tags", {}, signal));
    const selected = tags.models.find(row => row.name === model);
    if (!selected || `sha256:${selected.digest}` !== bounds.manifestDigest) throw new Error("pinned local Ollama manifest unavailable or changed; no pull or fallback");
  };
  const convert = (system: string, messages: NativeMessage[]) => [
    { role: "system", content: system },
    ...messages.flatMap(message => {
      const plain = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const tools = message.content.filter(block => block.type === "tool_use");
      const rows: Array<Record<string, unknown>> = [];
      if (plain || tools.length) rows.push({ role: message.role, content: plain, ...(tools.length ? { tool_calls: tools.map(block => ({ id: block.id, type: "function", function: { name: block.name, arguments: block.input } })) } : {}) });
      for (const block of message.content) if (block.type === "tool_result") rows.push({ role: "tool", content: block.content, tool_call_id: block.tool_use_id, tool_name: "read_fixture" });
      return rows;
    }),
  ];
  const runtime: LocalRoutingRuntime = {
    type: "api", outputTokenLimit: bounds.maxOutputTokens,
    resolvedModel: () => model, resolvedProvider: () => "ollama-local", isAvailable: async () => { await verify(); return true; },
    forkForSubagent: async (_timeout, selection) => { if (selection?.model !== model) throw new Error("local routing model substitution refused"); return runtime; },
    async executeNative(system: string, messages: NativeMessage[], tools: NativeToolDef[], _callbacks, signal): Promise<NativeRuntimeResult> {
      signal?.throwIfAborted();
      await verify(signal);
      const began = Date.now();
      inferenceRequests++;
      const result = responseSchema.parse(await json("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: convert(system, messages), tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })), stream: false, think: false, keep_alive: "1m", options: { temperature: 0, seed: 0, num_ctx: bounds.maxInputTokens, num_predict: bounds.maxOutputTokens } }),
      }, signal));
      const durationMs = Date.now() - began;
      measurements.push({ inputTokens: result.prompt_eval_count, outputTokens: result.eval_count, wallMs: durationMs, serverTotalNs: result.total_duration ?? null, serverLoadNs: result.load_duration ?? null, serverPromptNs: result.prompt_eval_duration ?? null, serverGenerationNs: result.eval_duration ?? null });
      const usage = { inputTokens: result.prompt_eval_count, outputTokens: result.eval_count };
      if (!result.done || result.model !== model || result.prompt_eval_count > bounds.maxInputTokens || result.eval_count > bounds.maxOutputTokens) return { content: [], stopReason: "error", error: "local model identity or token bound mismatch", durationMs, usage };
      try { await verify(signal); } catch { return { content: [], stopReason: "error", error: "local manifest changed during inference", durationMs, usage }; }
      const content: NativeContentBlock[] = result.message.content ? [{ type: "text", text: result.message.content }] : [];
      for (const [index, call] of (result.message.tool_calls ?? []).entries()) {
        const input = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments;
        content.push({ type: "tool_use", id: `local-tool-${index}`, name: call.function.name, input });
      }
      return { content, stopReason: result.done_reason === "length" ? "max_tokens" : result.message.tool_calls?.length ? "tool_use" : "end_turn", durationMs, usage };
    },
    async observation() {
      let runtimeVersion: string | null = null;
      let resident: number | null = null;
      let vram: number | null = null;
      const remainingMs = plan.timeCapMs - (Date.now() - start);
      if (remainingMs > 0) {
      const metadataSignal = AbortSignal.timeout(Math.max(1, Math.min(5_000, remainingMs)));
      try { metadataRequests++; runtimeVersion = z.object({ version: z.string().max(80) }).parse(await json("/api/version", {}, metadataSignal)).version; } catch { /* unavailable stays unknown */ }
      try {
        metadataRequests++;
        const loaded = z.object({ models: z.array(z.object({ name: z.string(), size: z.number().nonnegative().optional(), size_vram: z.number().nonnegative().optional() })).max(1000) }).parse(await json("/api/ps", {}, metadataSignal)).models.find(row => row.name === model);
        resident = loaded?.size ?? null; vram = loaded?.size_vram ?? null;
      } catch { /* no memory estimate is manufactured */ }
      }
      return { adapterDigest: `sha256:${createHash("sha256").update(createLocalOllamaRoutingRuntime.toString()).digest("hex")}`, endpoint, model, manifestDigest: bounds.manifestDigest, sourcePin: bounds.sourcePin, weightsDigest: bounds.weightsDigest, runtimeVersion, inferenceRequests, metadataRequests, measurements, clientCpuMicros: process.cpuUsage(cpu), clientMaxRssKiB: process.resourceUsage().maxRSS, clientWallMs: Date.now() - start, runtimeReportedResidentModelBytes: resident, runtimeReportedVramBytes: vram, externalApiFeeUsd: 0, computeCostUsd: null, energyJoules: null };
    },
  };
  return runtime;
}
