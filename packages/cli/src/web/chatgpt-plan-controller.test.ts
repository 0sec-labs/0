import { describe, expect, it, vi } from "vitest";
import { ChatGptPlanAuthController } from "./chatgpt-plan-controller.js";
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("native ChatGPT browser controller", () => {
  it("cancels the operation, clears the browser link and ignores late completion", async () => {
    let finish!: () => void;
    const signIn = vi.fn(async (options: Parameters<typeof import("../tui/chatgpt-plan-store.js").signInChatGptPlan>[0]) => {
      await options.onAuthorize("https://auth.openai.com/oauth/authorize?state=random");
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const controller = new ChatGptPlanAuthController({ signIn, list: () => [] });
    expect(controller.start("profile").phase).toBe("running"); await flush();
    expect(controller.status().verificationUrl).toContain("https://auth.openai.com/");
    expect(controller.cancel()).toMatchObject({ phase: "cancelled", verificationUrl: null });
    expect(signIn.mock.calls[0]![0].signal?.aborted).toBe(true);
    finish(); await flush(); expect(controller.status().phase).toBe("cancelled");
  });
  it("rejects credential-bearing and arbitrary authorization destinations without leaking the error", async () => {
    for (const url of ["https://evil.example/oauth", "https://auth.openai.com/oauth?access_token=secret", "http://auth.openai.com/oauth", "https://auth.openai.com:444/oauth"]) {
      const controller = new ChatGptPlanAuthController({ list: () => [], signIn: async options => { await options.onAuthorize(url); } });
      controller.start(); await flush();
      expect(controller.status()).toMatchObject({ phase: "failed", verificationUrl: null, lines: [] });
      expect(JSON.stringify(controller.status())).not.toContain("secret");
    }
  });
  it("distinguishes an identity connection from consent to use plan models", () => {
    const controller = new ChatGptPlanAuthController({ list: () => [{ id: "profile", label: "account", active: true, status: "connected", sharing: false }] });
    expect(controller.status()).toMatchObject({ phase: "connected", message: "ChatGPT identity is connected. Grant plan usage to use models." });
  });
});
