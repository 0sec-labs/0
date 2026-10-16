import { describe, expect, it, vi } from "vitest";
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
