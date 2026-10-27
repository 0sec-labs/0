import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ createRuntime: vi.fn(), createBroker: vi.fn(), credentials: vi.fn(async () => ({ accessToken: "local-private-token" })) }));
vi.mock("./operator-services.js", () => ({ createWebConsoleRuntime: fixture.createRuntime }));
vi.mock("@0/core", () => ({ createWorkbenchProviderBroker: fixture.createBroker }));
import { createLocalRelayProvider } from "./local-provider-relay.js";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.createRuntime.mockResolvedValue({ runtime: { resolvedProvider: () => "chatgpt-codex", resolvedModel: () => "selected", modelSelection: () => ({ agentModels: { audit: "auto", verify: "worker-model" } }), workbenchCredentialResolver: () => fixture.credentials }, info: { configured: true, diagnostics: { valid: true }, model: "selected" } });
  fixture.createBroker.mockImplementation(options => ({ grant: { provider: options.provider, models: options.models, protocol: 1, limits: {} }, request: vi.fn(), close: vi.fn() }));
});
it("binds exact local model routing to a private credential resolver without serializing credentials", async () => {
  const selection = { providerId: "chatgpt-codex", model: "selected" };
  const provider = await createLocalRelayProvider(selection);
  expect(fixture.createRuntime).toHaveBeenCalledWith(selection);
  expect(fixture.createBroker).toHaveBeenCalledWith(expect.objectContaining({ provider: "chatgpt-codex", models: ["selected", "worker-model"], resolveCredentials: fixture.credentials }));
  expect(fixture.credentials).not.toHaveBeenCalled();
  expect(provider.transport.models).toEqual(["selected", "worker-model"]);
  expect(JSON.stringify(provider)).not.toContain("local-private-token");
});
it("refuses disconnected local accounts and pre-cancelled grants without creating a broker", async () => {
  fixture.createRuntime.mockResolvedValueOnce({ runtime: { resolvedProvider: () => "chatgpt-codex", resolvedModel: () => "selected" }, info: { configured: false, diagnostics: { valid: false } } });
  await expect(createLocalRelayProvider()).rejects.toThrow(/connected ChatGPT Codex/);
  expect(fixture.createBroker).not.toHaveBeenCalled();
  const signal = AbortSignal.abort();
  await expect(createLocalRelayProvider({}, signal)).rejects.toThrow();
  expect(fixture.createRuntime).toHaveBeenCalledTimes(1);
});

it("selects local Codex when no provider is pinned and refuses explicit unsupported providers before resolution", async () => {
  await createLocalRelayProvider();
  expect(fixture.createRuntime).toHaveBeenCalledWith({ providerId: "chatgpt-codex" });
  await expect(createLocalRelayProvider({ providerId: "openai" })).rejects.toThrow(/Codex only/);
  expect(fixture.createRuntime).toHaveBeenCalledTimes(1);
  expect(fixture.credentials).not.toHaveBeenCalled();
});
