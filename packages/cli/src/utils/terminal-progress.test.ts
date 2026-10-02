import { afterEach, expect, test, vi } from "vitest";
import { terminalProgress } from "./terminal-progress.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

test("terminal progress animates one line, changes stages and cleans up exactly once", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm-256color");
  const write = vi.fn();
  const progress = terminalProgress("Updating 0", { isTTY: true, columns: 80, write } as never);
  vi.advanceTimersByTime(1000);
  progress.update("Downloading binary");
  expect(write.mock.calls.at(-1)?.[0]).toContain("Downloading binary · 1s");
  progress.finish("Installed");
  const calls = write.mock.calls.length;
  progress.finish("Duplicate");
  progress.update("Late output");
  vi.advanceTimersByTime(1000);
  expect(write.mock.calls).toHaveLength(calls);
  expect(vi.getTimerCount()).toBe(0);
  expect(write.mock.calls.at(-1)?.[0]).toBe("Installed\n");
});

test("redirected and dumb terminals never receive animation control sequences", () => {
  for (const isTTY of [false, true]) {
    vi.stubEnv("TERM", isTTY ? "dumb" : "xterm");
    const write = vi.fn();
    const progress = terminalProgress("Updating", { isTTY, write } as never);
    progress.update("Downloading");
    progress.finish("Done");
    expect(write.mock.calls.map(call => call[0]).join("")).toBe("Updating…\nDone\n");
  }
});

test("reduced motion stays still and installer control characters cannot rewrite the terminal", () => {
  vi.useFakeTimers();
  vi.stubEnv("TERM", "xterm");
  const write = vi.fn();
  const progress = terminalProgress("Update", { isTTY: true, columns: 80, write } as never, true);
  expect(vi.getTimerCount()).toBe(0);
  progress.update("\x1b[31mDownloading\x1b[0m\nnow");
  expect(write.mock.calls.at(-1)?.[0]).toContain("Downloading now");
  progress.finish();
});
