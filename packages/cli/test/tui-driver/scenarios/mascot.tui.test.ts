import React from "react";
import { setTimeout as delay } from "node:timers/promises";
import { CliRenderEvents, type TerminalCapabilities } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { expect, it } from "vitest";
import { createZeroImage } from "../../../src/tui/chat/mascot.js";
import { Masthead } from "../../../src/tui/chat/Masthead.js";
import { TERMINAL_BLOCK_LOGO } from "../../../src/tui/chat/logo.js";
import { finalLogoFrame } from "../../../src/tui/logo-animation.js";
import { getTheme } from "../../../src/tui/themes.js";

it("bakes the active canvas into the portrait instead of leaving terminal-controlled transparency", () => {
  const dark = createZeroImage("#111111");
  const light = createZeroImage("#fcfcfd");
  try {
    const darkPixels = dark.raw();
    const lightPixels = light.raw();
    // Exterior pixels must match the requested canvas, including after a
    // theme change. Otherwise native image protocols can show a matte box.
    expect([...darkPixels.data.subarray(0, 4)]).toEqual([17, 17, 17, 255]);
    expect([...lightPixels.data.subarray(0, 4)]).toEqual([252, 252, 253, 255]);
    for (const raw of [darkPixels, lightPixels]) {
      for (let y = 0; y < raw.height; y++) {
        for (let x = 0; x < raw.width; x++) {
          // No remaining transparency, including partially transparent edges.
          expect(raw.data[y * raw.stride + x * 4 + 3]).toBe(255);
        }
      }
    }
  } finally {
    dark.dispose();
    light.dispose();
  }
});

it("removes the mascot and its space when native graphics would fall back to blocks", async () => {
  const setup = await createTestRenderer({ width: 130, height: 44 });
  let capabilities: Partial<TerminalCapabilities> | null = null;
  let resolution: { width: number; height: number } | null = null;
  Object.defineProperty(setup.renderer, "capabilities", { get: () => capabilities });
  Object.defineProperty(setup.renderer, "resolution", { get: () => resolution });
  // Match the driver's adapter for OpenTUI's headless root-removal mismatch.
  const rendererRoot = setup.renderer.root as { remove: (child: unknown) => unknown };
  const originalRemove = rendererRoot.remove.bind(rendererRoot);
  rendererRoot.remove = child => {
    try {
      return originalRemove(child);
    } catch (error) {
      if (error instanceof Error && /renderable child/.test(error.message)) return undefined;
      throw error;
    }
  };
  const root = createRoot(setup.renderer);
  root.render(React.createElement("box", { flexDirection: "column" }, React.createElement(Masthead, {
    showTerminalMark: true, showTagline: true, contentWidth: 130,
    logoFrameGrid: finalLogoFrame(TERMINAL_BLOCK_LOGO), theme: getTheme("0sec"),
  })));
  async function logoRow() {
    await delay(0);
    await setup.flush();
    return setup.captureCharFrame().split("\n").findIndex(line => line.includes("█"));
  }
  try {
    await expect.poll(logoRow).toBe(2);
    capabilities = { kitty_graphics: true, multiplexer: "none" };
    setup.renderer.emit(CliRenderEvents.CAPABILITIES, capabilities);
    await expect.poll(logoRow).toBe(12);

    // Advertising Kitty is insufficient inside tmux: OpenTUI selects blocks.
    capabilities = { kitty_graphics: true, multiplexer: "tmux" };
    setup.renderer.emit(CliRenderEvents.CAPABILITIES, capabilities);
    await expect.poll(logoRow).toBe(2);
    expect(setup.captureCharFrame()).not.toMatch(/[▀▄▌▐▛▜▟▙▚▞▝▘▖▗]/);

    // Sixel without a pixel-resolution report also selects blocks.
    capabilities = { sixel: true, multiplexer: "none" };
    setup.renderer.emit(CliRenderEvents.CAPABILITIES, capabilities);
    await logoRow();
    expect(await logoRow()).toBe(2);
    expect(setup.captureCharFrame()).not.toMatch(/[▀▄▌▐▛▜▟▙▚▞▝▘▖▗]/);
    // Resolution can arrive later without a second capabilities event.
    resolution = { width: 1300, height: 880 };
    setup.renderer.emit(CliRenderEvents.FRAME);
    await expect.poll(logoRow).toBe(12);
  } finally {
    root.unmount();
    await delay(0);
    setup.renderer.destroy();
  }
});
