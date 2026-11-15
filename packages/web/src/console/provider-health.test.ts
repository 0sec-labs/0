import { describe, expect, it } from "vitest";
import { healthBadge, healthHint, nextHealthyChoice, rejectedKeyHeadline, resolveStartChoice, unusableProviderIds, credentialOrigin } from "./provider-health";

const deepseek = { id: "deepseek", label: "DeepSeek", configured: true, source: "environment", environmentVariable: "DEEPSEEK_API_KEY", health: { state: "rejected" as const } };
const openai = { id: "openai", label: "OpenAI", configured: true, source: "account-store", health: { state: "ok" as const } };
const azure = { id: "azure", label: "Azure OpenAI", configured: true, health: { state: "unknown" as const } };

describe("health badge", () => {
  it("is green Connected only when the probe passed", () => {
    expect(healthBadge(openai, true)).toEqual({ label: "Connected", tone: "success" });
    expect(healthBadge(azure, true).tone).toBe("neutral");
    expect(healthBadge({ ...openai, health: { state: "unknown", checking: true } }, true).label).toBe("Checking…");
  });
  it("names rejected and unreachable keys", () => {
    expect(healthBadge(deepseek, true)).toEqual({ label: "Key rejected", tone: "danger" });
    expect(healthBadge({ ...openai, health: { state: "unreachable" } }, true)).toEqual({ label: "Can't reach", tone: "warning" });
    expect(healthBadge(openai, false).label).toBe("Needs connection");
  });
  it("gives an environment hint or a saved-key hint", () => {
    expect(healthHint(deepseek)).toBe("Set DEEPSEEK_API_KEY in your environment");
    expect(healthHint({ ...openai, health: { state: "rejected" } })).toBe("Update the key");
    expect(healthHint(openai)).toBeNull();
  });
  it("says when an environment variable wins over a saved key", () => {
    expect(credentialOrigin(deepseek, true)).toContain("wins over the saved key");
    expect(credentialOrigin(deepseek, false)).toBe("From environment");
    expect(credentialOrigin(openai, true)).toBeNull();
  });
});

describe("default model resolution skips unhealthy providers", () => {
  const unusable = unusableProviderIds([deepseek, openai, azure]);
  const ds = { providerId: "deepseek", model: "deepseek-flash" };
  const oa = { providerId: "openai", model: "gpt-5.5" };
  it("does not use a remembered choice from a rejected provider, and reports it", () => {
    expect(resolveStartChoice({ remembered: ds, recommended: oa }, unusable)).toEqual({ choice: oa, skipped: ds });
  });
  it("falls through host default and saved choice the same way", () => {
    expect(resolveStartChoice({ explicit: ds, saved: ds }, unusable)).toEqual({ choice: undefined, skipped: ds });
    expect(resolveStartChoice({ explicit: ds, saved: oa }, unusable).choice).toEqual(oa);
  });
  it("keeps a healthy remembered choice", () => {
    expect(resolveStartChoice({ remembered: oa, recommended: ds }, unusable)).toEqual({ choice: oa });
  });
});

describe("next healthy model", () => {
  const models = [{ id: "deepseek-flash", provider: "deepseek" }, { id: "gpt-5.5", provider: "openai" }, { id: "gpt-x", provider: "openai", enabled: false }];
  it("picks a recommended model on a healthy provider", () => {
    expect(nextHealthyChoice({ providers: [deepseek, openai], models, recommended: [{ role: "orchestrator", providerId: "openai", model: "gpt-5.5" }], failedProviderId: "deepseek" })).toEqual({ providerId: "openai", model: "gpt-5.5", providerLabel: "OpenAI" });
  });
  it("falls back to the first listed model and never offers the failed provider", () => {
    expect(nextHealthyChoice({ providers: [deepseek, openai], models, failedProviderId: "deepseek" })?.model).toBe("gpt-5.5");
    expect(nextHealthyChoice({ providers: [deepseek], models, failedProviderId: "deepseek" })).toBeUndefined();
  });
});

describe("banner", () => {
  it("names provider and model", () => {
    expect(rejectedKeyHeadline("DeepSeek", "deepseek-flash")).toBe("DeepSeek rejected your key for deepseek-flash.");
  });
});

import { rejectedBanner } from "./provider-health";
describe("rejected key banner", () => {
  const models = [{ id: "deepseek-flash", provider: "deepseek" }, { id: "gpt-5.5", provider: "openai" }];
  it("names the provider and model and offers the next healthy model plus the connection row", () => {
    const banner = rejectedBanner({ runtime: { providerId: "deepseek", model: "deepseek-flash" }, providers: [deepseek, openai], models });
    expect(banner).toMatchObject({ headline: "DeepSeek rejected your key for deepseek-flash.", providerId: "deepseek", next: { providerId: "openai", model: "gpt-5.5" } });
  });
  it("offers no switch when nothing else is healthy", () => {
    expect(rejectedBanner({ runtime: { providerId: "deepseek", model: "deepseek-flash" }, providers: [deepseek], models }).next).toBeUndefined();
  });
  it("still reads plainly when the runtime is unknown", () => {
    expect(rejectedBanner({ runtime: null, providers: [], models: [] }).headline).toBe("The model provider rejected your key.");
  });
});
