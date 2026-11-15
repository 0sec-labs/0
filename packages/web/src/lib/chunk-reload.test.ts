import { describe, expect, it, vi } from "vitest";
import { CHUNK_FAILURE, currentBuildId, reloadOnceForBuild } from "./chunk-reload";

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }; };

describe("stale tab recovery", () => {
  it("recognises a failed lazy import", () => {
    expect(CHUNK_FAILURE.test("Failed to fetch dynamically imported module: http://x/assets/page-abc.js")).toBe(true);
    expect(CHUNK_FAILURE.test("Cannot read properties of undefined")).toBe(false);
  });
  it("reloads once per build and never loops", () => {
    const store = memory(); const reload = vi.fn();
    expect(reloadOnceForBuild("build-a", store, reload)).toBe(true);
    expect(reloadOnceForBuild("build-a", store, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("allows one reload for the next build", () => {
    const store = memory(); const reload = vi.fn();
    reloadOnceForBuild("build-a", store, reload);
    expect(reloadOnceForBuild("build-b", store, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does not reload when storage is blocked", () => {
    const reload = vi.fn();
    expect(reloadOnceForBuild("a", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} }, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it("identifies the build by its entry script", () => {
    expect(currentBuildId({ querySelector: () => ({ src: "http://h/assets/index-123.js" }) as never })).toBe("http://h/assets/index-123.js");
  });
});
