import type { TerminalCapabilities } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { expect, it, vi } from "vitest";
import { launch } from "../driver.js";

it("shows the native portrait when the body fits it and releases its space on shrink", async () => {
  // The headless renderer can use a different OpenTUI module instance.
  const probe = await createTestRenderer({ width: 130, height: 34 });
  const capabilities = vi.spyOn(Object.getPrototypeOf(probe.renderer), "capabilities", "get")
    .mockReturnValue({ kitty_graphics: true, multiplexer: "none" } as TerminalCapabilities);
  probe.renderer.destroy();
  let tui: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    tui = await launch({
      cols: 130, rows: 34,
      settings: { showRuntimeNotices: false },
      route: { type: "chat", options: { providerId: "openai", model: "gpt-4o" } },
      env: { OPENAI_API_KEY: "fixture-only-not-a-real-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" },
    });
    const screen = tui;
    const portraitSpace = async () => {
      await screen.settle();
      const lines = screen.rawFrame().split("\n");
      const eyebrow = lines.findIndex(line => line.includes("Swiss Applied"));
      const mark = lines.findIndex(line => line.includes("██"));
      return eyebrow < 0 ? -1 : mark - eyebrow;
    };
    await expect.poll(portraitSpace).toBe(12);
    await screen.resize(130, 24);
    await expect.poll(portraitSpace).toBe(2);
    expect(screen.rawFrame()).toContain("type to chat or / for commands");
    await screen.resize(130, 34);
    await expect.poll(portraitSpace).toBe(12);
  } finally {
    await tui?.close();
    capabilities.mockRestore();
  }
});
