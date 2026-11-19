import { describe, expect, it, vi } from "vitest";
import { closeQuietly, probeFolderReadable } from "./workspace-access.js";

// Under Bun (the compiled `0`), Dir.close() returns undefined instead of a promise.
const bunLikeOpen = (closes: { count: number }) => (async () => ({
  read: async () => null,
  close: () => { closes.count++; return undefined; },
})) as unknown as typeof import("node:fs/promises").opendir;

describe("folder probes when Dir.close() returns nothing (Bun)", () => {
  it("probeFolderReadable still reports a readable folder and closes the handle", async () => {
    const closes = { count: 0 };
    expect(await probeFolderReadable("/any", { open: bunLikeOpen(closes) })).toBe("readable");
    expect(closes.count).toBe(1);
  });

  it("closeQuietly accepts a close that returns nothing, a promise, or throws", async () => {
    await expect(closeQuietly({ close: () => undefined })).resolves.toBeUndefined();
    await expect(closeQuietly({ close: async () => undefined })).resolves.toBeUndefined();
    await expect(closeQuietly({ close: () => { throw new Error("already closed"); } })).resolves.toBeUndefined();
    await expect(closeQuietly({ close: () => Promise.reject(new Error("already closed")) })).resolves.toBeUndefined();
    const close = vi.fn();
    await closeQuietly({ close });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
