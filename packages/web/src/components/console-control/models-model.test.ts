import { describe, expect, it } from "vitest";
import { differsFromDefault, failingProviders, modelRows, modelsPageState, redactProviderError } from "./models-model";

const providers = [
  { id: "openai", label: "OpenAI API", configured: true },
  { id: "deepseek", label: "DeepSeek", configured: true },
  { id: "azure", label: "Azure OpenAI", configured: true },
  { id: "anthropic", label: "Anthropic", configured: false },
];

describe("redactProviderError", () => {
  it("removes bearer tokens, key assignments and long opaque strings", () => {
    expect(redactProviderError("failed Authorization: Bearer sk-abcdef1234567890abcd")).not.toMatch(/abcdef1234/);
    expect(redactProviderError("GET /v1/models?api_key=supersecretvalue&x=1")).toBe("GET /v1/models?api_key=[redacted]&x=1");
    expect(redactProviderError("token ghp_abcdefghijklmnop1234 rejected")).not.toMatch(/abcdefghijklmnop/);
    expect(redactProviderError("id 0123456789abcdef0123456789abcdef0123 bad")).toBe("id [redacted] bad");
  });
  it("keeps ordinary diagnostics readable", () => {
    expect(redactProviderError("Provider model discovery failed (HTTP 401)")).toBe("Provider model discovery failed (HTTP 401)");
  });
});

describe("failingProviders", () => {
  it("returns one row per provider with the label and a redacted tooltip, never the raw text", () => {
    const rows = failingProviders([
      { providerId: "deepseek", message: "HTTP 401 Bearer sk-abcdef1234567890abcd" },
      { providerId: "deepseek", message: "again" },
      { providerId: "azure", message: "Azure deployment discovery requires Azure CLI." },
    ], providers);
    expect(rows.map(row => row.label)).toEqual(["DeepSeek", "Azure OpenAI"]);
    expect(rows[0]!.title).not.toContain("sk-abcdef");
  });
  it("falls back to a friendly label for providers the host did not list", () => {
    expect(failingProviders([{ providerId: "xai", message: "x" }], [])[0]!.label).toBe("xAI");
  });
});

describe("modelRows", () => {
  const models = [
    { id: "gpt-5.4", provider: "openai", source: "public-catalog", contextWindowTokens: 1000 },
    { id: "gpt-5.4", provider: "openai", source: "account", contextWindowTokens: 400000, price: "$2 / $8" },
    { id: "deepseek-chat", provider: "deepseek" },
    { id: "claude", provider: "anthropic" },
    { id: "old", provider: "openai", enabled: false },
  ];
  it("keeps connected providers only, dedupes preferring account rows, groups by provider", () => {
    const rows = modelRows(models, providers);
    expect(rows.map(row => row.id)).toEqual(["gpt-5.4", "old", "deepseek-chat"]);
    expect(rows[0]).toMatchObject({ providerLabel: "OpenAI API", detail: "400K context · $2 / $8", disabled: false });
  });
  it("marks models turned off in Connections", () => {
    expect(modelRows(models, providers).find(row => row.id === "old")).toMatchObject({ disabled: true, hint: "Turned off in Connections" });
  });
});

describe("modelsPageState", () => {
  it("is loading, empty without a connected provider, otherwise ready", () => {
    expect(modelsPageState({ providers: undefined, loading: true })).toBe("loading");
    expect(modelsPageState({ providers: [providers[3]!], loading: false })).toBe("empty");
    expect(modelsPageState({ providers: [], loading: false })).toBe("empty");
    expect(modelsPageState({ providers, loading: false })).toBe("ready");
  });
});

describe("differsFromDefault", () => {
  it("shows the reset link only when the choice differs from the saved default", () => {
    expect(differsFromDefault({ providerId: "openai", model: "a" }, null)).toBe(false);
    expect(differsFromDefault({ providerId: "openai", model: "a" }, { providerId: "openai", model: "a" })).toBe(false);
    expect(differsFromDefault({ providerId: "openai", model: "b" }, { providerId: "openai", model: "a" })).toBe(true);
  });
});
