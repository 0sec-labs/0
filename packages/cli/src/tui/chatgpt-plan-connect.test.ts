import { describe, expect, it, vi } from "vitest";
import { nativePlanProviderStates, startChatGptPlanConnect } from "./chatgpt-plan-connect.js";
import type { ChatGptPlanSummary } from "./chatgpt-plan-store.js";
import type { DeviceAuthUpdate } from "./device-auth.js";
const profile = (overrides: Partial<ChatGptPlanSummary> = {}): ChatGptPlanSummary => ({ id: "fixture-profile", label: "Fixture account", active: true, status: "connected", sharing: true, ...overrides });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe("native ChatGPT TUI inventory", () => {
  it("only marks an active plan grant configured and keeps environment providers intact", () => {
    for (const p of [profile({ active: false }), profile({ status: "signed-out" }), profile({ sharing: false })]) {
      expect(nativePlanProviderStates({}, "/fixture", () => [p]).find(s => s.id === "chatgpt-plan")?.configured).toBe(false);
    }
    const env = { OPENAI_API_KEY: "fixture-key" };
    const states = nativePlanProviderStates(env, "/fixture", () => [profile()]);
    expect(states.find(s => s.id === "chatgpt-plan")?.configured).toBe(true);
    expect(states.find(s => s.id === "openai")?.configured).toBe(true);
    expect(env).toEqual({ OPENAI_API_KEY: "fixture-key" });
  });
  it("fails closed when protected inventory cannot be read", () => {
    expect(nativePlanProviderStates({}, "/fixture", () => { throw new Error("private-storage"); }).find(s => s.id === "chatgpt-plan")?.configured).toBe(false);
  });
});
describe("native ChatGPT TUI connection", () => {
  it("launches native login and rechecks the saved grant before selecting the provider", async () => {
    let saved = false;
    const updates: DeviceAuthUpdate[] = [], connected = vi.fn(), openBrowser = vi.fn();
    const signIn = vi.fn(async options => { await options.onAuthorize("https://auth.openai.com/fixture"); saved = true; });
    startChatGptPlanConnect({ homeDir: "/fixture", inventory: () => saved ? [profile()] : [], signIn, openBrowser, onUpdate: u => updates.push(u), onConnected: connected });
    await flush();
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ homeDir: "/fixture", signal: expect.any(AbortSignal), profileId: undefined }));
    expect(openBrowser).toHaveBeenCalledWith("https://auth.openai.com/fixture");
    expect(updates.at(-1)?.phase).toBe("connected"); expect(connected).toHaveBeenCalledOnce();
  });
  it("reconnects the selected existing registration rather than creating another account", async () => {
    const signIn = vi.fn(async () => {});
    startChatGptPlanConnect({ inventory: () => [profile()], signIn, onUpdate: () => {}, onConnected: () => {} });
    await flush(); expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ profileId: "fixture-profile" }));
  });
  it("does not announce identity-only sign-in as plan access", async () => {
    const updates: DeviceAuthUpdate[] = [], connected = vi.fn();
    startChatGptPlanConnect({ inventory: () => [profile({ sharing: false })], signIn: async () => {}, onUpdate: u => updates.push(u), onConnected: connected });
    await flush(); expect(updates.at(-1)?.phase).toBe("failed"); expect(updates.at(-1)?.message).toContain("plan usage was not granted"); expect(connected).not.toHaveBeenCalled();
  });
  it("cancels promptly and ignores late completion without exposing transport errors", async () => {
    const updates: DeviceAuthUpdate[] = [], connected = vi.fn();
    let complete!: () => void, signal: AbortSignal | undefined;
    const session = startChatGptPlanConnect({ inventory: () => [profile()], signIn: async options => { signal = options.signal; await new Promise<void>(resolve => { complete = resolve; }); }, onUpdate: u => updates.push(u), onConnected: connected });
    await flush(); session.cancel(); expect(signal?.aborted).toBe(true); expect(updates.at(-1)?.phase).toBe("cancelled");
    complete(); await flush(); expect(connected).not.toHaveBeenCalled(); expect(updates.filter(u => u.phase === "cancelled")).toHaveLength(1);
  });
});
