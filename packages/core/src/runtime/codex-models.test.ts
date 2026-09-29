import { afterEach, expect, test, vi } from "vitest";
import { loadCodexModelCatalog, parseCodexModels } from "./codex-models.js";
import { getChatGptCodexAccessToken } from "./llm-api.js";

vi.mock("./llm-api.js", () => ({ getChatGptCodexAccessToken: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test("keeps account model IDs and reported windows without a static allowlist", () => {
  expect(parseCodexModels({ models: [
    { slug: "gpt-daybreak-blue-latest", context_window: 1_050_000 },
    { slug: "future-model" },
    { slug: "private-hidden", visibility: "hide" },
    { id: "other-hidden", hidden: true },
  ] })).toEqual([{ id: "gpt-daybreak-blue-latest", contextTokens: 1_050_000 }, { id: "future-model" }]);
  expect(parseCodexModels({ models: [] })).toEqual([]);
  expect(() => parseCodexModels({ error: "failure" })).toThrow("Invalid Codex model catalog");
  expect(() => parseCodexModels({ models: [{ slug: "bad\nmodel" }] })).toThrow("Invalid Codex model id");
  expect(parseCodexModels({ models: [
    { slug: "fractional-window", context_window: 0.5 },
    { slug: "unsafe-window", context_window: Number.MAX_SAFE_INTEGER + 1 },
  ] })).toEqual([{ id: "fractional-window" }, { id: "unsafe-window" }]);
});

test("uses the runtime account resolver and sends a bounded, non-redirecting metadata request", async () => {
  const env = { ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-token" };
  vi.mocked(getChatGptCodexAccessToken).mockResolvedValue({ accessToken: "synthetic-token", accountId: "synthetic-account" });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-daybreak-blue-latest" }] })));
  expect(await loadCodexModelCatalog({ env, fetchImpl })).toEqual([{ id: "gpt-daybreak-blue-latest" }]);
  expect(getChatGptCodexAccessToken).toHaveBeenCalledWith(env);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.144.1");
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
  expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("synthetic-account");
});

test("does not replace a denied catalog with public models or expose its response body", async () => {
  vi.mocked(getChatGptCodexAccessToken).mockResolvedValue({ accessToken: "synthetic-token" });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private diagnostic body", { status: 403 }));
  await expect(loadCodexModelCatalog({ fetchImpl })).rejects.toThrow("Codex model discovery failed (HTTP 403)");
  expect(fetchImpl).toHaveBeenCalledOnce();
});


test("cancellation bounds credential resolution without cancelling the shared refresh", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>();
  let finish!: (value: { accessToken: string }) => void;
  const resolveCredentials = () => new Promise<{ accessToken: string }>((resolve) => { finish = resolve; });
  const pending = loadCodexModelCatalog({ signal: controller.signal, fetchImpl, resolveCredentials });
  controller.abort(new Error("picker closed"));
  await expect(pending).rejects.toThrow("picker closed");
  finish({ accessToken: "synthetic-token" });
  await Promise.resolve();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a transient metadata outage keeps only the account just resolved", async () => {
  let accountId = "isolated-cache-account-a";
  let accessToken = "synthetic-cache-a";
  const resolveCredentials = async () => ({ accessToken, accountId });
  const models = [{ id: "future-account-model", contextTokens: 524288 }];
  await loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      models: [{ slug: models[0].id, context_window: models[0].contextTokens }],
    })),
  });
  accessToken = "synthetic-rotated-token-same-account";
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  await expect(loadCodexModelCatalog({ resolveCredentials, fetchImpl: offline }))
    .rejects.toMatchObject({ name: "CodexCatalogRefreshError", cachedModels: models });
  accountId = "isolated-cache-account-b";
  await expect(loadCodexModelCatalog({ resolveCredentials, fetchImpl: offline }))
    .rejects.toThrow("offline");
});

test("revoked account access invalidates a previously usable catalog", async () => {
  const resolveCredentials = async () => ({ accessToken: "synthetic-denied-token", accountId: "isolated-denied-account" });
  await loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [{ slug: "previous-model" }] })),
  });
  await expect(loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
  })).rejects.toThrow("Codex model discovery failed (HTTP 403)");
  await expect(loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline after revoked access")),
  })).rejects.toThrow("offline after revoked access");
});
