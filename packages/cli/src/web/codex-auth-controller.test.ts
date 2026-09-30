import { describe, expect, it, vi } from "vitest";
import { CodexAuthController, webAuthStatus } from "./codex-auth-controller.js";

describe("CodexAuthController", () => {
  it("keeps OAuth tokens daemon-side while publishing lifecycle status", () => {
    let onUpdate: ((update: { phase: "running" | "connected" | "cancelled" | "failed" | "unavailable"; message: string; lines: readonly string[] }) => void) | undefined;
    const cancel = vi.fn();
    const controller = new CodexAuthController({
      env: { ZERO_CHATGPT_AUTH_FILE: "/no-such-0-web-auth-file" },
      probe: () => true,
      start: (options) => {
        onUpdate = options.onUpdate;
        return { cancel };
      },
    });

    expect(controller.status()).toMatchObject({ phase: "idle" });
    controller.start();
    onUpdate?.({ phase: "running", message: "Open your browser.", lines: ["https://auth.example.test"] });
    expect(controller.status()).toMatchObject({
      phase: "running",
      lines: ["https://auth.example.test"],
    });

    controller.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    onUpdate?.({ phase: "connected", message: "Connected.", lines: [] });
    expect(controller.status()).toMatchObject({ phase: "connected" });
  });

  it("discovers existing auth even when the official sign-in executable is unavailable", () => {
    const controller = new CodexAuthController({
      env: { ZERO_CHATGPT_ACCESS_TOKEN: "private-existing-auth", ZERO_CHATGPT_AUTH_FILE: "/no-such-0-web-auth-file" },
      probe: () => false,
    });
    const status = controller.status();
    expect(status).toMatchObject({ phase: "connected", available: false });
    expect(JSON.stringify(status)).not.toContain("private-existing-auth");
  });

  it("reports unavailable sign-in without claiming a connection", () => {
    const controller = new CodexAuthController({
      env: { ZERO_CHATGPT_AUTH_FILE: "/no-such-0-web-auth-file" },
      probe: () => false,
    });
    expect(controller.status()).toMatchObject({ phase: "unavailable", available: false });
    expect(controller.start()).toMatchObject({ phase: "unavailable", available: false });
  });

  it("never turns credential-bearing or off-provider auth output into a browser link", () => {
    for (const url of ["https://auth.openai.com/codex/device?access_token=private", "https://auth.openai.com.evil.test/codex/device"]) {
      expect(webAuthStatus({ phase: "running", message: "", lines: [url] }).verificationUrl).toBeNull();
    }
    expect(webAuthStatus({
      phase: "running", message: "", lines: ["Visit: https://auth.x.ai/device", "Enter code: ABCD-EFGH"],
    })).toMatchObject({ verificationUrl: "https://auth.x.ai/device", userCode: "ABCD-EFGH" });
  });
});
