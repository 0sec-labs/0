import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount, loadAccountStore, saveAccountStore, accountEnvPatch } from "../state/credential-store.js";
import { ConnectionExtras, applySpread, disabledModelsFor, fetchConnectionUsage, isModelDisabled } from "./connection-meta.js";

describe("connection extras", () => {
  let home: string; let extras: ConnectionExtras;
  const fetchImpl = vi.fn<typeof fetch>();
  const call = (path: string, method: string, body?: unknown) => extras.handle(path, method, body);
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "zero-conn-")); fetchImpl.mockReset();
    let store = loadAccountStore(home);
    store = addAccount(store, "openrouter", { kind: "api_key", secret: "sk-or-first-secret" }, { accountId: "work" }).store;
    store = addAccount(store, "openrouter", { kind: "api_key", secret: "sk-or-second-secret" }, { accountId: "home", makeActive: false }).store;
    store = addAccount(store, "openrouter", { kind: "api_key", secret: "sk-or-third-secret" }, { accountId: "lab", makeActive: false }).store;
    expect(saveAccountStore(store, home)).toBe(true);
    extras = new ConnectionExtras({ homeDir: home, fetchImpl, knownProvider: id => id === "openrouter" });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const ids = (data: unknown) => (data as { connections: Array<{ id: string }> }).connections.map(c => c.id);

  it("lists connections without secrets, never intercepts POST connections", async () => {
    const list = await call("connections", "GET");
    expect(ids(list!.data)).toEqual(["openrouter:work", "openrouter:home", "openrouter:lab"]);
    expect(JSON.stringify(list)).not.toContain("sk-or");
    expect(await call("connections", "POST", {})).toBeNull();
  });

  it("renames a connection without touching the credential store", async () => {
    const before = readFileSync(join(home, ".0", "credentials.json"), "utf8");
    const renamed = await call("connections/openrouter%3Awork", "PATCH", { label: "  Work key " });
    expect(renamed!.data).toMatchObject({ connection: { label: "Work key", defaultLabel: "work" } });
    expect(readFileSync(join(home, ".0", "credentials.json"), "utf8")).toBe(before);
    expect(lstatSync(join(home, ".0", "connection-meta.json")).mode & 0o777).toBe(0o600);
    expect((await call("connections/openrouter%3Awork", "PATCH", { label: null }))!.data).toMatchObject({ connection: { label: "work" } });
    expect((await call("connections/openrouter%3Awork", "PATCH", { label: "x".repeat(81) }))?.status).toBe(400);
    expect((await call("connections/openrouter%3Anope", "PATCH", { label: "x" }))?.status).toBe(404);
  });

  it("orders accounts and validates the permutation", async () => {
    const ok = await call("connections/order", "PUT", { providerId: "openrouter", accountIds: ["lab", "work", "home"] });
    expect(ids(ok!.data)).toEqual(["openrouter:lab", "openrouter:work", "openrouter:home"]);
    for (const accountIds of [["lab", "work"], ["lab", "lab", "home"], ["lab", "work", "x"]]) expect((await call("connections/order", "PUT", { providerId: "openrouter", accountIds }))?.status).toBe(400);
  });

  it("spread really rotates the active account per new runtime, in operator order, without persisting the credential store", async () => {
    await call("connections/order", "PUT", { providerId: "openrouter", accountIds: ["home", "lab", "work"] });
    await call("connections/spread", "PUT", { providerId: "openrouter", enabled: true });
    const used: string[] = [];
    for (let i = 0; i < 4; i++) {
      const rotated = applySpread(loadAccountStore(home), home);
      used.push(rotated.providers.openrouter!.activeAccountId!);
      expect(accountEnvPatch(rotated, {}).OPENROUTER_API_KEY).toBe({ work: "sk-or-first-secret", home: "sk-or-second-secret", lab: "sk-or-third-secret" }[used.at(-1)!]);
    }
    expect(used).toEqual(["home", "lab", "work", "home"]);
    expect(loadAccountStore(home).providers.openrouter!.activeAccountId).toBe("work");
    await call("connections/spread", "PUT", { providerId: "openrouter", enabled: false });
    expect(applySpread(loadAccountStore(home), home).providers.openrouter!.activeAccountId).toBe("work");
  });

  it("persists per-connection disabled models and enforces the matching", async () => {
    const result = await call("connections/openrouter%3Awork/models", "PUT", { disabled: ["anthropic/claude-x", "gpt-y", "gpt-y"] });
    expect(result!.data).toMatchObject({ connection: { disabledModels: ["anthropic/claude-x", "gpt-y"] } });
    const disabled = disabledModelsFor("openrouter", loadAccountStore(home), home);
    expect(isModelDisabled(disabled, "anthropic/claude-x")).toBe(true);
    expect(isModelDisabled(disabled, "openrouter/gpt-y")).toBe(true);
    expect(isModelDisabled(disabled, "other")).toBe(false);
    expect((await call("connections/openrouter%3Awork/models", "PUT", { disabled: "all" }))?.status).toBe(400);
  });

  it("reports real OpenRouter key usage and nothing invented elsewhere", async () => {
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ data: { limit: 50, limit_remaining: 41.5, usage: 8.5, usage_daily: 1, usage_weekly: 3, usage_monthly: 8.5 } })));
    const usage = await call("connections/openrouter%3Awork/usage", "GET");
    expect(usage!.data).toMatchObject({ usage: { available: true, source: "openrouter-key", window: { limit: 50, remaining: 41.5, usedTotal: 8.5, usedDaily: 1, currency: "USD" } } });
    expect(fetchImpl).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer sk-or-first-secret" }) }));
    expect(JSON.stringify(usage)).not.toContain("sk-or");
    fetchImpl.mockResolvedValue(new Response("", { status: 401 }));
    expect((await call("connections/openrouter%3Awork/usage", "GET"))!.data).toMatchObject({ usage: { available: false, reason: "credentials_rejected", window: null } });
    expect(await fetchConnectionUsage("chatgpt-codex", undefined, fetchImpl)).toEqual({ available: false, source: null, window: null, reason: "not_exposed" });
    expect(await fetchConnectionUsage("copilot", undefined, fetchImpl)).toMatchObject({ available: false, reason: "not_exposed" });
  });
});
