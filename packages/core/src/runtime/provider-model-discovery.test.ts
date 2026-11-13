import { describe, expect, it, vi } from "vitest";
import { getRates, hasKnownPricing } from "@0/shared";
import { discoverProviderModels, type AzureModelDiscoveryRunner } from "./provider-model-discovery.js";

const headers = { Authorization: "Bearer synthetic-key" };
const baseUrl = "https://selected.example/private/v1/";
const account = {
  id: "/subscriptions/selected-sub/resourceGroups/selected-group/providers/Microsoft.CognitiveServices/accounts/resource",
  name: "resource", resourceGroup: "selected-group",
  properties: { endpoint: "https://resource.openai.azure.com/", customSubDomainName: "resource" },
};
const azureOptions = { provider: "azure", baseUrl: "https://resource.openai.azure.com/openai/v1", headers };

function runnerFor(accounts: unknown[], deployments: unknown[]) {
  return vi.fn<AzureModelDiscoveryRunner>()
    .mockResolvedValueOnce(JSON.stringify(accounts))
    .mockResolvedValueOnce(JSON.stringify(deployments));
}
function deployment(name: string, modelName: string, extra: Record<string, unknown> = {}) {
  return { name, properties: { provisioningState: "Succeeded", model: { name: modelName }, ...extra } };
}

describe("connection-scoped provider model discovery", () => {
  it("exposes the published Z.ai coding catalog without claiming account entitlement or probing its Anthropic route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await discoverProviderModels({ provider: "z-ai", baseUrl: "https://api.z.ai/api/anthropic", headers, fetchImpl })).toEqual([{ id: "glm-5.3", source: "catalog" }, { id: "glm-5.3-flash", source: "catalog" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps custom Z.ai endpoint inventories separate from the published catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "private-glm" }] }));
    expect(await discoverProviderModels({ provider: "z-ai", baseUrl: "https://private.example/v1", headers, fetchImpl })).toEqual([{ id: "private-glm" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses only the selected endpoint and resolved headers with a bounded nonredirecting request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: "private-future-model", context_window: 100_000 },
      { id: "private-future-model" },
      { id: "text-embedding-3-large" },
      { id: "gpt-4o-audio-preview" },
      { id: "gpt-image-1" },
      { id: "flux.1-pro" },
    ] }));
    expect(await discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl }))
      .toEqual([{ id: "private-future-model", contextTokens: 100_000 }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://selected.example/private/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-key");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps two endpoint discoveries independent, including empty account lists", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "first-account-only" }] }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    expect(await discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl }))
      .toEqual([{ id: "first-account-only" }]);
    expect(await discoverProviderModels({ provider: "openai", baseUrl: "https://other.example/v1", headers: { Authorization: "Bearer other-key" }, fetchImpl }))
      .toEqual([]);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://other.example/v1/models");
  });

  it.each([401, 403, 404, 500])("does not fallback on HTTP %i or expose response contents", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-private-response", { status }));
    await expect(discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl }))
      .rejects.toThrow(`Provider model discovery failed (HTTP ${status}).`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([[401, "credentials were rejected"], [403, "not permitted to list models"]] as const)("offers safe actionable advice for HTTP %i without consuming provider bodies", async (status, advice) => {
    const response = new Response("private-token-provider-body", { status });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const failure = await discoverProviderModels({ provider: "deepseek", baseUrl, headers, fetchImpl }).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(advice);
    expect((failure as Error).message).not.toMatch(/synthetic-key|private-token/);
    expect(response.bodyUsed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sanitizes network failures and invalid JSON", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-secret-token")),
      vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-secret-token")),
    ]) {
      await expect(discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl }))
        .rejects.not.toThrow("synthetic-secret-token");
    }
  });

  it.each([{ error: "private" }, { data: "bad" }, { data: [null] }, { data: [{ id: "bad\nmodel" }] }, { data: [{ id: "" }] }])
    ("rejects malformed model payloads", async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl })).rejects.toThrow(/invalid/);
    });

  it("follows Anthropic cursors without changing endpoint, path, query or credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-private-a", max_input_tokens: 200_000 }], has_more: true, last_id: "claude-private-a" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-private-b" }], has_more: false, last_id: "claude-private-b" }));
    expect(await discoverProviderModels({ provider: "anthropic", baseUrl: "https://anthropic.example/proxy?tenant=test", headers, fetchImpl }))
      .toEqual([{ id: "claude-private-a", contextTokens: 200_000 }, { id: "claude-private-b" }]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://anthropic.example/proxy/v1/models?tenant=test",
      "https://anthropic.example/proxy/v1/models?tenant=test&after_id=claude-private-a",
    ]);
  });

  it("does not duplicate Anthropic v1 paths and rejects repeated pagination cursors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a",
    }));
    await expect(discoverProviderModels({ provider: "anthropic", baseUrl: "https://anthropic.example/v1/", headers, fetchImpl }))
      .rejects.toThrow("repeated pagination cursor");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://anthropic.example/v1/models");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the OpenRouter account catalog instead of its public model catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: "acme/private-chat", context_length: 120_000, architecture: { output_modalities: ["text"] } },
      { id: "acme/private-image", architecture: { output_modalities: ["image"] } },
    ] }));
    expect(await discoverProviderModels({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", headers, fetchImpl }))
      .toEqual([{ id: "acme/private-chat", contextTokens: 120_000 }]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models/user");
  });

  it("offers enabled Copilot chat models with reported context, excluding denied and nonchat models", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: "enabled", model_picker_enabled: false, policy: { state: "enabled" }, capabilities: { type: "chat", limits: { max_context_window_tokens: 128_000 } } },
      { id: "denied", policy: { state: "disabled" }, capabilities: { type: "chat" } },
      { id: "embedding-model", capabilities: { type: "embeddings" } },
      { id: "no-chat-capability" },
      { id: "no-tools", capabilities: { type: "chat", supports: { tool_calls: false } } },
    ] }));
    expect(await discoverProviderModels({ provider: "copilot", baseUrl, headers, fetchImpl }))
      .toEqual([{ id: "enabled", contextTokens: 128_000 }]);
  });

  it("does not fabricate Google Code Assist models", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(discoverProviderModels({ provider: "google", baseUrl, headers, fetchImpl }))
      .rejects.toThrow("Google Code Assist does not support account model discovery");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors cancellation before issuing any request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl, signal: controller.signal })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Azure endpoint deployment discovery", () => {
  it("lists only matched resource deployments, preserving aliases and excluding unusable model types", async () => {
    const runAzureCli = runnerFor([
      { ...account, name: "wrong-resource", properties: { endpoint: "https://other.openai.azure.com/" } }, account,
    ], [
      deployment("production-alias", "gpt-4.1"),
      deployment("not-ready", "gpt-4.1", { provisioningState: "Updating" }),
      deployment("embedding-alias", "text-embedding-3-large"),
      deployment("image-alias", "gpt-image-1"),
      deployment("unknown-kind", "unrecognised-model"),
      deployment("future-chat-alias", "future-model", { capabilities: { chatCompletion: "true" } }),
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await discoverProviderModels({ ...azureOptions, runAzureCli, fetchImpl })).toEqual([
      { id: "production-alias" }, { id: "future-chat-alias" },
    ]);
    expect(runAzureCli.mock.calls[0][0]).toEqual(["cognitiveservices", "account", "list", "--output", "json", "--only-show-errors"]);
    expect(runAzureCli.mock.calls[1][0]).toEqual([
      "cognitiveservices", "account", "deployment", "list", "--name", "resource", "--resource-group", "selected-group",
      "--subscription", "selected-sub", "--output", "json", "--only-show-errors",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { endpoints: { openai: "https://resource.openai.azure.com/" } },
    { customSubDomainName: "resource" },
  ])("matches resource endpoint aliases and custom subdomains", async (properties) => {
    const runAzureCli = runnerFor([{ ...account, properties }], [deployment("alias", "gpt-4.1")]);
    expect(await discoverProviderModels({ ...azureOptions, runAzureCli })).toEqual([{ id: "alias" }]);
  });

  it("does not match misleading suffixes or fall back to any other account", async () => {
    const runAzureCli = runnerFor([account], [deployment("wrong-endpoint-model", "gpt-4.1")]);
    await expect(discoverProviderModels({ ...azureOptions, baseUrl: "https://resource.openai.azure.com.attacker.example/v1", runAzureCli }))
      .rejects.toThrow("could not uniquely match");
    expect(runAzureCli).toHaveBeenCalledOnce();
  });

  it("fails closed for ambiguous resources", async () => {
    const runAzureCli = runnerFor([account, { ...account, name: "duplicate-resource" }], []);
    await expect(discoverProviderModels({ ...azureOptions, runAzureCli })).rejects.toThrow("could not uniquely match");
    expect(runAzureCli).toHaveBeenCalledOnce();
  });

  it("does not query models or expose CLI output when Azure CLI fails", async () => {
    const runAzureCli = vi.fn<AzureModelDiscoveryRunner>().mockRejectedValue(new Error("private Azure token and stderr"));
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(discoverProviderModels({ ...azureOptions, runAzureCli, fetchImpl })).rejects.toThrow("existing signed-in session");
    await expect(discoverProviderModels({ ...azureOptions, runAzureCli, fetchImpl })).rejects.not.toThrow("private Azure token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["not JSON", "{}", "[null]"])("rejects malformed Azure CLI account responses", async (output) => {
    const runAzureCli = vi.fn<AzureModelDiscoveryRunner>().mockResolvedValue(output);
    await expect(discoverProviderModels({ ...azureOptions, runAzureCli })).rejects.toThrow();
    expect(runAzureCli).toHaveBeenCalledOnce();
  });

  it("rejects malformed deployment rows rather than inserting a configured model", async () => {
    const runAzureCli = runnerFor([account], [{ name: "broken" }]);
    await expect(discoverProviderModels({ ...azureOptions, runAzureCli })).rejects.toThrow("invalid deployment row");
  });
});


describe("Cline public model catalogs", () => {
  it("uses the selected API base, keeps Pass slugs, deduplicates and marks public provenance without sending credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "anthropic/claude-sonnet-4-6", context_length: 200_000 }, { id: "cline-pass/glm-5.3" }, { id: "text-embedding-3-large" }] }))
      .mockResolvedValueOnce(Response.json({ data: { clinePass: [{ id: "cline-pass/glm-5.3", context_length: 128_000 }] } }));
    expect(await discoverProviderModels({ provider: "cline", baseUrl, headers, fetchImpl })).toEqual([
      { id: "cline-pass/glm-5.3", contextTokens: 128_000, source: "catalog" },
      { id: "anthropic/claude-sonnet-4-6", contextTokens: 200_000, source: "catalog" },
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://selected.example/private/v1/ai/cline/models", "https://selected.example/private/v1/ai/cline/recommended-models",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    }
  });

  it("supports the official bare catalog and recommended payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ id: "openai/gpt-4o" }]))
      .mockResolvedValueOnce(Response.json({ clinePass: [{ id: "cline-pass/kimi-k3" }] }));
    expect(await discoverProviderModels({ provider: "cline", baseUrl, headers, fetchImpl })).toEqual([
      { id: "cline-pass/kimi-k3", source: "catalog" }, { id: "openai/gpt-4o", source: "catalog" },
    ]);
  });

  it.each([{ data: "invalid" }, { data: [null] }, { data: [{ id: "bad\nmodel" }] }])("rejects invalid catalogs with no invented model fallback", async catalog => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog)).mockResolvedValueOnce(Response.json({ clinePass: [] }));
    await expect(discoverProviderModels({ provider: "cline", baseUrl, headers, fetchImpl })).rejects.toThrow(/invalid/);
  });

  it("does not use a stale or hardcoded Pass inventory when catalog discovery fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-private-response", { status: 403 }));
    await expect(discoverProviderModels({ provider: "cline", baseUrl, headers, fetchImpl })).rejects.toThrow("Cline model catalog failed (HTTP 403)");
  });
});

describe("Together AI model discovery", () => {
  const togetherBase = "https://api.together.ai/v1";
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, object: "model", type: "chat", running: false, context_length: 131_072,
    pricing: { hourly: 0, input: 0.15, output: 0.6, cached_input: 0.015 }, ...extra,
  });

  it("reads Together's bare-array catalog from /models with the resolved headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      row("openai/gpt-oss-120b"),
      row("zai-org/GLM-5.3", { context_length: 1_048_575 }),
    ]));
    expect(await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl })).toEqual([
      { id: "openai/gpt-oss-120b", contextTokens: 131_072, source: "catalog" },
      { id: "zai-org/GLM-5.3", contextTokens: 1_048_575, source: "catalog" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.together.ai/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-key");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("also accepts an OpenAI-style { data } envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: "list", data: [row("openai/gpt-oss-120b")] }));
    expect(await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl }))
      .toEqual([{ id: "openai/gpt-oss-120b", contextTokens: 131_072, source: "catalog" }]);
  });

  it("offers only token-priced chat models, dropping non-chat, unpriced, and duplicate rows", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      row("openai/gpt-oss-120b"),
      row("openai/gpt-oss-120b"),
      row("BAAI/bge-large-en-v1.5", { type: "embedding" }),
      row("black-forest-labs/FLUX.1-schnell", { type: "image" }),
      row("openai/whisper-large-v3", { type: "transcribe" }),
      row("mixedbread-ai/Mxbai-Rerank-Large-V2", { type: "rerank" }),
      row("cartesia/sonic", { type: "audio" }),
      row("meta-llama/Llama-2-7b-hf", { type: "language" }),
      row("someone/Qwen3.5-9B-Lora-d9236703", { pricing: { hourly: 0, input: 0, output: 0 } }),
      row("someone/dedicated-only", { pricing: { hourly: 3.99e-9 } }),
      row("someone/no-pricing", { pricing: undefined }),
      row("invalid/negative", { pricing: { input: -1, output: 0 } }),
      row("invalid/nonfinite", { pricing: { input: 0, output: Infinity } }),
      row("invalid/string", { pricing: { input: "0", output: 0 } }),
      row("output-only/priced", { pricing: { input: 0, output: 1.5 } }),
    ]));
    expect((await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl })).map(model => model.id))
      .toEqual(["openai/gpt-oss-120b", "someone/Qwen3.5-9B-Lora-d9236703", "output-only/priced"]);
  });

  it("skips malformed rows instead of failing the whole listing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      null, "text", 42, [], { type: "chat" },
      row("has space/model"), row("x".repeat(300)), row(""),
      row("openai/gpt-oss-120b", { context_length: "not-a-number" }),
    ]));
    expect(await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl }))
      .toEqual([{ id: "openai/gpt-oss-120b", source: "catalog" }]);
  });

  it("honours a custom or regional endpoint and a trailing slash", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([row("openai/gpt-oss-120b")]));
    await discoverProviderModels({ provider: "together", baseUrl: "https://us-api.together.ai/v1/", headers, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://us-api.together.ai/v1/models");
  });

  it.each([
    [401, /HTTP 401.*credentials were rejected/],
    [403, /HTTP 403.*not permitted to list models/],
    [500, /HTTP 500/],
  ])("reports HTTP %i without echoing the response body", async (status, message) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-body-synthetic-key", { status }));
    const error = await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl }).catch(e => e as Error);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain("secret-body");
  });

  it.each([{ unexpected: true }, "nope", 7, null])("rejects an unexpected response shape %j", async body => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl }))
      .rejects.toThrow("Together returned an invalid model discovery response.");
  });

  it("does not overwrite another provider's tariff for the same vendor model ID", async () => {
    const otherProvider = { ...getRates("openai/gpt-oss-120b") };
    const togetherRates = { input: 0.31, output: 1.27, cached_input: 0.011 };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      row("openai/gpt-oss-120b", { pricing: togetherRates }),
      row("synthetic-org/Provider-Isolation-9B", { pricing: togetherRates }),
    ]));
    await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl });
    expect(getRates("together/openai/gpt-oss-120b")).toEqual({ input: 0.31, output: 1.27, cachedInput: 0.011 });
    expect(getRates("openai/gpt-oss-120b")).toEqual(otherProvider);
    expect(hasKnownPricing("synthetic-org/Provider-Isolation-9B")).toBe(false);
    expect(hasKnownPricing("openai/synthetic-org/Provider-Isolation-9B")).toBe(false);
  });

  it("registers Together's published per-million prices so estimates do not fall back to the unknown-model default", async () => {
    expect(hasKnownPricing("synthetic-org/Priced-On-Together-9B")).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      row("synthetic-org/Priced-On-Together-9B", { pricing: { hourly: 0, input: 0.3, output: 1.2, cached_input: 0.006 } }),
      row("synthetic-org/No-Cache-Price-9B", { pricing: { input: 0.2, output: 0.4, cached_input: 0 } }),
      row("synthetic-org/Unlisted-Embedding", { type: "embedding", pricing: { input: 9, output: 9 } }),
    ]));
    await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl });
    expect(getRates("together/synthetic-org/Priced-On-Together-9B")).toEqual({ input: 0.3, output: 1.2, cachedInput: 0.006 });
    expect(hasKnownPricing("synthetic-org/Priced-On-Together-9B")).toBe(false);
    expect(getRates("together/synthetic-org/No-Cache-Price-9B")).toEqual({ input: 0.2, output: 0.4 });
    expect(hasKnownPricing("synthetic-org/Unlisted-Embedding")).toBe(false);
  });

  it("lists every chat model with listAll, but never registers a zero price for zero or unpriced rows", async () => {
    const fetchImpl = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      row("synthetic-org/Priced-All-9B", { pricing: { input: 0.3, output: 1.2 } }),
      row("synthetic-org/Dedicated-Only-9B", { pricing: { hourly: 3.99e-9, input: 0, output: 0 } }),
      row("account-owner/my-finetune-abcd1234", { pricing: undefined }),
      row("BAAI/bge-large-en-v1.5", { type: "embedding", pricing: { input: 0.02, output: 0 } }),
      row("meta-llama/Llama-2-7b-hf", { type: "language", pricing: undefined }),
    ]));
    // A published price of zero is listed by default; a missing price needs listAll.
    expect((await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl: fetchImpl() })).map(model => model.id))
      .toEqual(["synthetic-org/Priced-All-9B", "synthetic-org/Dedicated-Only-9B"]);
    const all = await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl: fetchImpl(), listAll: true });
    expect(all.map(model => model.id)).toEqual(["synthetic-org/Priced-All-9B", "synthetic-org/Dedicated-Only-9B", "account-owner/my-finetune-abcd1234"]);
    expect(all.every(model => model.source === "catalog")).toBe(true);
    expect(getRates("together/synthetic-org/Priced-All-9B")).toEqual({ input: 0.3, output: 1.2 });
    expect(hasKnownPricing("synthetic-org/Dedicated-Only-9B")).toBe(false);
    expect(hasKnownPricing("account-owner/my-finetune-abcd1234")).toBe(false);
  });

  it("reports an unreachable endpoint with a fixed message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED synthetic-key"));
    const error = await discoverProviderModels({ provider: "together", baseUrl: togetherBase, headers, fetchImpl }).catch(e => e as Error);
    expect((error as Error).message).toBe("Together model discovery could not reach the selected endpoint.");
  });
});

describe("OpenCode Go context metadata", () => {
  const rows = [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-v4-pro" },
    { id: "glm-5.2" }, { id: "glm-5.3" }, { id: "deepseek-v4.1-flash-free" }];

  it.each([
    ["openai", "https://opencode.ai/inference/go/openai/v1"],
    ["opencode", "https://opencode.ai/zen/go/v1/"],
  ])("fills published limits only for models actually discovered on %s %s", async (provider, baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: rows }));
    const models = await discoverProviderModels({ provider, baseUrl, headers, fetchImpl });
    expect(models).toEqual([
      ...rows.slice(0, 4).map(row => ({ ...row, contextTokens: 1_000_000 })), rows[4],
    ]);
  });

  it("retains explicit endpoint context metadata even when smaller than the published fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: "deepseek-v4.1-flash", context_length: 64_000 },
    ] }));
    expect(await discoverProviderModels({ provider: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1", headers, fetchImpl }))
      .toEqual([{ id: "deepseek-v4.1-flash", contextTokens: 64_000 }]);
  });

  it.each([
    "https://custom.example/v1", "https://api.z.ai/v1", "https://opencode.ai/zen/v1",
    "https://opencode.ai.evil.example/inference/go/openai/v1", "https://opencode.ai/not-go/v1",
  ])("does not borrow Go context metadata on %s", async baseUrl => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: rows }));
    expect(await discoverProviderModels({ provider: "openai", baseUrl, headers, fetchImpl })).toEqual(rows);
  });
});
