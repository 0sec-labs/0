import { afterEach, expect, test, vi } from "vitest";
import { loadCodexModelCatalog, parseCodexModels } from "./codex-models.js";
import { getChatGptCodexAccessToken } from "./llm-api.js";
import type * as LlmApi from "./llm-api.js";

vi.mock("./llm-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof LlmApi>(),
  getChatGptCodexAccessToken: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

test("keeps account model IDs and reported windows without a static allowlist", () => {
  expect(parseCodexModels({ models: [
    { slug: "gpt-6.1", context_window: 1_050_000 },
    { slug: "future-model" },
    { slug: "private-hidden", visibility: "hide" },
    { id: "other-hidden", hidden: true },
  ] })).toEqual([{ id: "gpt-6.1", contextTokens: 1_050_000 }, { id: "future-model" }]);
  expect(parseCodexModels({ models: [] })).toEqual([]);
  expect(() => parseCodexModels({ error: "failure" })).toThrow();
  expect(() => parseCodexModels({ models: [{ slug: "bad\nmodel" }] })).toThrow();
  expect(parseCodexModels({ models: [
    { slug: "fractional-window", context_window: 0.5 },
    { slug: "unsafe-window", context_window: Number.MAX_SAFE_INTEGER + 1 },
  ] })).toEqual([{ id: "fractional-window" }, { id: "unsafe-window" }]);
});

test("uses only reported recommendation priorities and preserves equal-rank server order", () => {
  expect(parseCodexModels({ models: [
    { slug: "unranked-first", priority: "1" },
    { slug: "ranked-later", priority: 20 },
    { slug: "preferred", priority: 0 },
    { slug: "equally-preferred", priority: 0 },
    { slug: "hidden-preferred", priority: -1, visibility: "hide" },
    { slug: "unranked-second", priority: NaN },
  ] })).toEqual([
    { id: "preferred", priority: 0 },
    { id: "equally-preferred", priority: 0 },
    { id: "ranked-later", priority: 20 },
    { id: "unranked-first" },
    { id: "unranked-second" },
  ]);
});

test("uses the runtime account resolver and sends a bounded, non-redirecting metadata request", async () => {
  const env = { ZERO_CHATGPT_ACCESS_TOKEN: "synthetic-token" };
  vi.mocked(getChatGptCodexAccessToken).mockResolvedValue({ accessToken: "synthetic-token", accountId: "synthetic-account" });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: "gpt-daybreak-blue-latest" }] })));
  expect(await loadCodexModelCatalog({ env, fetchImpl })).toEqual([{ id: "gpt-daybreak-blue-latest" }]);
  const [url, init] = fetchImpl.mock.calls[0];
  const requestUrl = new URL(String(url));
  expect(requestUrl.origin).toBe("https://chatgpt.com");
  expect(requestUrl.pathname).toBe("/backend-api/codex/models");
  expect(init?.redirect).toBe("error");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
  expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("synthetic-account");
});

test("does not replace a denied catalog with public models or expose its response body", async () => {
  vi.mocked(getChatGptCodexAccessToken).mockResolvedValue({ accessToken: "synthetic-token" });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private diagnostic body", { status: 403 }));
  await expect(loadCodexModelCatalog({ fetchImpl })).rejects.toThrow("Codex model discovery failed (HTTP 403)");
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test("tries the alternate account catalog route when the primary route is unavailable", async () => {
  const resolveCredentials = async () => ({ accessToken: "synthetic-route-token", accountId: "isolated-route-account" });
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: "future-subscription-id", context_window: 524288 }] }));
  expect(await loadCodexModelCatalog({ resolveCredentials, fetchImpl }))
    .toEqual([{ id: "future-subscription-id", contextTokens: 524288 }]);
  expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname))
    .toEqual(["/backend-api/codex/models", "/backend-api/models"]);
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
  const denied = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(loadCodexModelCatalog({ resolveCredentials, fetchImpl: denied }))
    .rejects.toThrow("Codex model discovery failed (HTTP 401)");
  expect(denied).toHaveBeenCalledTimes(2);
  await expect(loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline after revoked access")),
  })).rejects.toThrow("offline after revoked access");
});

test("token-only credentials cannot reuse another token's catalog", async () => {
  let accessToken = "synthetic-token-without-account-a";
  const resolveCredentials = async () => ({ accessToken });
  await loadCodexModelCatalog({
    resolveCredentials,
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [{ slug: "account-a-model" }] })),
  });
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("token-only offline"));
  await expect(loadCodexModelCatalog({ resolveCredentials, fetchImpl: offline }))
    .rejects.toMatchObject({ name: "CodexCatalogRefreshError", cachedModels: [{ id: "account-a-model" }] });
  accessToken = "synthetic-token-without-account-b";
  await expect(loadCodexModelCatalog({ resolveCredentials, fetchImpl: offline })).rejects.toThrow("token-only offline");
});
