/**
 * `ApiRuntime`: THE API-key/OAuth runtime every call site holds. It is a thin
 * facade over one implementation chosen by the factory:
 *
 *   - `PiAiRuntime`      (pi-ai provider layer) - default for the routes it serves
 *   - `LegacyRuntimeAdapter` (= LlmApiRuntime)  - routes pi-ai cannot serve yet
 *     (ChatGPT Codex / ChatGPT plan / Azure / OpenCode / z-ai /
 *     kimi / qwen, cyber-access programs, granted transports,
 *     workbench proxy) and the `ZERO_RUNTIME=legacy` escape hatch.
 *
 * The facade keeps ONE stable object identity for a live console session while
 * the implementation underneath can change when the operator switches
 * provider (`reconfigure`), so WeakMaps and instanceof-style checks keyed on the
 * runtime keep working across a pi <-> legacy switch.
 *
 * No call site constructs a runtime directly; see runtime/native-api.ts and
 * `scripts/check-architecture.mjs`.
 */
import type { SiwcConnection } from "./siwc-connection.js";
import type {
  CyberAccessProgram, NativeMessage, NativeRuntime, NativeRuntimeResult, NativeStreamCallbacks, NativeToolDef,
  Runtime, RuntimeConfig, RuntimeContext, RuntimeResult, SubagentModelSelection,
} from "./types.js";
import type { CodexCatalogModel } from "./codex-models.js";
import type { ApiRuntimeDiagnostics } from "./llm-api/provider-detect.js";
import type { ApiProvider } from "./llm-api/provider-config.js";
// Imported through the runtime/llm-api.js barrel on purpose: it is the module tests mock to stub the legacy client.
import { LlmApiRuntime } from "./llm-api.js";
import type { PrivateWorkerRuntimeBinding } from "./llm-api/runtime.js";
import { PiAiRuntime } from "./pi/runtime.js";
import { resolvePiRoute } from "./pi/route.js";

/** Marked alias: the hand-written provider client, retained until pi-ai serves every route. */
export const LegacyRuntimeAdapter = LlmApiRuntime;
export type LegacyRuntimeAdapter = LlmApiRuntime;

export type RuntimeMode = "legacy" | "pi-ai" | "auto";
export type RuntimeKind = "legacy" | "pi-ai";
type Impl = LlmApiRuntime | PiAiRuntime;

/** ZERO_RUNTIME: `legacy` (escape hatch), `pi-ai` (force pi), anything else/unset = auto (pi where served, else legacy). */
export function runtimeMode(env: Readonly<Record<string, string | undefined>> = process.env, override?: Readonly<Record<string, string | undefined>>): RuntimeMode {
  const value = (override?.["ZERO_RUNTIME"] ?? env["ZERO_RUNTIME"])?.trim().toLowerCase();
  return value === "legacy" ? "legacy" : value === "pi-ai" ? "pi-ai" : "auto";
}

/** The single implementation decision. Pure over (config, env). */
export function selectRuntimeKind(config: RuntimeConfig, processEnv: Readonly<NodeJS.ProcessEnv> = process.env): RuntimeKind {
  const mode = runtimeMode(processEnv, config.env);
  if (mode === "legacy") return "legacy";
  // Routes pi-ai does not serve: always legacy, even when pi is forced (the caller gets legacy's own behaviour).
  if (config.providerTransport || config.siwcConnection || config.cyberAccessProgram !== undefined || config.provider === "chatgpt-plan") return "legacy";
  if (mode === "pi-ai") return "pi-ai";
  try {
    resolvePiRoute(config, Object.freeze({ ...processEnv, ...config.env }));
    return "pi-ai";
  } catch {
    return "legacy";
  }
}

function construct(config: RuntimeConfig): { kind: RuntimeKind; impl: Impl } {
  const kind = selectRuntimeKind(config);
  // The two construction sites below are the only `new LlmApiRuntime(` / `new PiAiRuntime(` in non-test code outside runtime internals.
  return kind === "pi-ai" ? { kind, impl: new PiAiRuntime(config) } : { kind, impl: new LegacyRuntimeAdapter(config) };
}

export class ApiRuntime implements Runtime, NativeRuntime {
  readonly type = "api" as const;
  #impl: Impl;
  #kind: RuntimeKind;
  #config: RuntimeConfig;

  constructor(config: RuntimeConfig);
  constructor(config: RuntimeConfig, wrapped: { kind: RuntimeKind; impl: Impl });
  constructor(config: RuntimeConfig, wrapped?: { kind: RuntimeKind; impl: Impl }) {
    const built = wrapped ?? construct(config);
    this.#impl = built.impl;
    this.#kind = built.kind;
    this.#config = config;
    // Opt-in trace (no secrets): shows which implementation the factory chose.
    if (process.env["ZERO_RUNTIME_TRACE"] === "1") process.stderr.write(`[runtime] implementation=${this.#kind} provider=${this.#impl.resolvedProvider?.() ?? "?"} model=${this.#impl.resolvedModel?.() ?? "?"}\n`);
  }

  /** Which implementation currently serves this runtime (diagnostics/tests only). */
  get implementation(): RuntimeKind { return this.#kind; }

  static fromPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding): ApiRuntime {
    const wrapped: { kind: RuntimeKind; impl: Impl } = binding.runtimeKind === "pi-ai"
      ? { kind: "pi-ai", impl: PiAiRuntime.fromPrivateWorkerBinding(binding) }
      : { kind: "legacy", impl: LegacyRuntimeAdapter.fromPrivateWorkerBinding(binding) };
    return new ApiRuntime(binding.config, wrapped);
  }

  // ── NativeRuntime / Runtime ──
  get outputTokenLimit(): number | undefined { return this.#impl.outputTokenLimit; }
  executeNative(system: string, messages: NativeMessage[], tools: NativeToolDef[], callbacks?: NativeStreamCallbacks, signal?: AbortSignal): Promise<NativeRuntimeResult> {
    return this.#impl.executeNative(system, messages, tools, callbacks, signal);
  }
  execute(prompt: string, context?: RuntimeContext): Promise<RuntimeResult> { return this.#impl.execute(prompt, context); }
  isAvailable(): Promise<boolean> { return this.#impl.isAvailable(); }
  finishInvocation(): Promise<void> { return (this.#impl as { finishInvocation?: () => Promise<void> }).finishInvocation?.() ?? Promise.resolve(); }
  async forkForSubagent(timeoutMs: number, selection?: SubagentModelSelection): Promise<ApiRuntime> {
    // Optional on the NativeRuntime contract: an implementation without forks keeps serving as its own child.
    if (typeof (this.#impl as { forkForSubagent?: unknown }).forkForSubagent !== "function") return this;
    const child = await this.#impl.forkForSubagent(timeoutMs, selection);
    return new ApiRuntime(this.#config, { kind: this.#kind, impl: child });
  }
  accessibleModels(): string[] { return (this.#impl as Partial<Impl>).accessibleModels?.() as string[]; }
  resolvedModel(): string { return (this.#impl as Partial<Impl>).resolvedModel?.() as string; }
  resolvedProvider(): string { return (this.#impl as Partial<Impl>).resolvedProvider?.() as string; }
  resolvedPricingModel(): string { return (this.#impl as Partial<Impl>).resolvedPricingModel?.() as string; }
  modelSelection(): { agentModels: Record<string, string>; singleModel: boolean; autoRoute: boolean } { return (this.#impl as Partial<Impl>).modelSelection?.() as { agentModels: Record<string, string>; singleModel: boolean; autoRoute: boolean }; }

  /**
   * In-place selection change. A provider/connection change re-runs the factory decision, so a console that
   * starts on pi can move to a legacy-only provider (and back) without changing the runtime object.
   */
  reconfigure(sel: {
    cyberAccessProgram?: CyberAccessProgram | null;
    siwcConnection?: SiwcConnection;
    model?: string;
    provider?: string;
    agentModels?: Record<string, string>;
    singleModel?: boolean;
    autoRoute?: boolean;
    env?: NodeJS.ProcessEnv;
  }): void {
    const providerChanged = sel.provider !== undefined && sel.provider !== this.#impl.resolvedProvider();
    if (providerChanged || sel.siwcConnection !== undefined || sel.env !== undefined || (sel.cyberAccessProgram ?? null) !== null) {
      const merged: RuntimeConfig = {
        ...this.#config, ...this.modelSelection(),
        provider: (sel.provider ?? this.#impl.resolvedProvider()) as RuntimeConfig["provider"],
        model: sel.model ?? (providerChanged ? undefined : this.#impl.resolvedModel()),
        apiKey: providerChanged ? undefined : this.#config.apiKey,
        siwcConnection: sel.siwcConnection,
        ...(sel.agentModels !== undefined ? { agentModels: sel.agentModels } : {}),
        ...(sel.singleModel !== undefined ? { singleModel: sel.singleModel } : {}),
        ...(sel.autoRoute !== undefined ? { autoRoute: sel.autoRoute } : {}),
        ...(sel.env !== undefined ? { env: sel.env as Record<string, string> } : {}),
        ...(sel.cyberAccessProgram != null ? { cyberAccessProgram: sel.cyberAccessProgram } : {}),
      };
      const nextKind = selectRuntimeKind(merged);
      if (nextKind !== this.#kind) {
        // Build first: a failing construction leaves this runtime untouched.
        const next = construct(merged);
        this.#impl = next.impl; this.#kind = next.kind; this.#config = merged;
        return;
      }
    }
    (this.#impl as LlmApiRuntime).reconfigure(sel);
  }

  // ── console surface ──
  connectionIdentity(): string | undefined { return this.#impl.connectionIdentity(); }
  reasoningConfiguration(): { effort: string; options: string[] } | null { return this.#impl.reasoningConfiguration(); }
  setReasoningEffort(effort: string): void { this.#impl.setReasoningEffort(effort); }
  codexModelCatalog(signal?: AbortSignal): Promise<CodexCatalogModel[]> { return this.#impl.codexModelCatalog(signal); }
  availableModelCatalog(signal?: AbortSignal): Promise<Array<{ id: string; contextTokens?: number; source?: "catalog" }>> { return this.#impl.availableModelCatalog(signal); }
  publishedContextWindowTokens(): number | undefined { return this.#impl.publishedContextWindowTokens(); }
  accessibleProviders(): ApiProvider[] { return this.#impl.accessibleProviders(); }
  refreshConnection(env: NodeJS.ProcessEnv): void { this.#impl.refreshConnection(env); }
  getConfigurationDiagnostics(): ApiRuntimeDiagnostics { return this.#impl.getConfigurationDiagnostics(); }
  workbenchCredentialResolver(): () => Promise<{ accessToken: string; accountId?: string }> { return this.#impl.workbenchCredentialResolver(); }
  useGrantedProviderTransport(transport: NonNullable<RuntimeConfig["providerTransport"]>, selection: { model?: string; agentModels?: Record<string, string>; singleModel?: boolean; autoRoute?: boolean } = {}): void {
    if (this.#kind !== "legacy") {
      // A granted transport is a legacy-only route: rebuild under the factory decision, then apply.
      const next = construct({ type: "api", timeout: this.#config.timeout, model: selection.model ?? this.#impl.resolvedModel(), provider: transport.provider, providerTransport: transport, ...selection });
      this.#impl = next.impl; this.#kind = next.kind;
      return;
    }
    (this.#impl as LlmApiRuntime).useGrantedProviderTransport(transport, selection);
  }
  setCyberAccessProgram(value: CyberAccessProgram | null): void {
    if (value !== null && this.#kind === "pi-ai") {
      // Cyber access programs ride OpenAI Responses account headers that only the legacy client implements:
      // re-run the factory decision with the program set (it selects legacy), failing closed if that route is invalid.
      const merged: RuntimeConfig = {
        ...this.#config, ...this.modelSelection(),
        provider: this.#impl.resolvedProvider() as RuntimeConfig["provider"], model: this.#impl.resolvedModel(), cyberAccessProgram: value,
      };
      const next = construct(merged);
      this.#impl = next.impl; this.#kind = next.kind; this.#config = merged;
      return;
    }
    this.#impl.setCyberAccessProgram(value);
  }
  getCyberAccessProgram(): CyberAccessProgram | undefined { return this.#impl.getCyberAccessProgram(); }
  cyberAccessProgramConfiguration(): { confirmed?: CyberAccessProgram; requested?: CyberAccessProgram; options: CyberAccessProgram[]; unavailableReason?: string } { return this.#impl.cyberAccessProgramConfiguration(); }
  exportPrivateWorkerBinding(): PrivateWorkerRuntimeBinding { return this.#impl.exportPrivateWorkerBinding(); }
  applyPrivateWorkerBinding(binding: PrivateWorkerRuntimeBinding, options?: { replaceSelection: true }): void {
    const bindingKind: RuntimeKind = binding.runtimeKind === "pi-ai" ? "pi-ai" : "legacy";
    if (bindingKind === this.#kind) { this.#impl.applyPrivateWorkerBinding(binding, options); return; }
    // A worker may have moved the session to the other implementation; only a replaceSelection checkpoint may do that.
    if (!options?.replaceSelection) throw new Error("Worker checkpoint does not match the current session connection and model.");
    const next = ApiRuntime.fromPrivateWorkerBinding(binding);
    this.#impl = next.#impl; this.#kind = next.#kind; this.#config = next.#config;
  }
}

/** Any runtime the console can manage: the facade, or a raw implementation handed in by an embedder/test. */
export type ConsoleRuntime = ApiRuntime | LlmApiRuntime | PiAiRuntime;

export function isApiRuntime(value: unknown): value is ConsoleRuntime {
  return value instanceof ApiRuntime || value instanceof LlmApiRuntime || value instanceof PiAiRuntime;
}
