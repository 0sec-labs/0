import { beforeEach, describe, expect, it } from "vitest";
import { consumeComposerPrefill, mergePrefill, queueComposerPrefill, resetComposerPrefillForTest } from "./composer-prefill";

function fake() {
  const map = new Map<string, string>();
  return {
    map,
    writeText: (key: string, value: string) => { map.set(key, value); return true; },
    readText: (key: string) => map.get(key) ?? null,
    remove: (key: string) => { map.delete(key); },
  };
}

describe("composer prefill", () => {
  beforeEach(resetComposerPrefillForTest);
  it("queues, persists and consumes once", () => {
    const api = fake();
    queueComposerPrefill("set me up", api);
    expect([...api.map.values()]).toEqual(["set me up"]);
    expect(consumeComposerPrefill(api)).toBe("set me up");
    expect(consumeComposerPrefill(api)).toBeNull();
    expect(api.map.size).toBe(0);
  });
  it("recovers from storage after a reload", () => {
    const api = fake();
    queueComposerPrefill("after reload", api);
    resetComposerPrefillForTest();
    expect(consumeComposerPrefill(api)).toBe("after reload");
  });
  it("ignores blanks and does not duplicate repeated clicks", () => {
    const api = fake();
    queueComposerPrefill("  ", api);
    expect(consumeComposerPrefill(api)).toBeNull();
    queueComposerPrefill("a", api); queueComposerPrefill("a", api);
    expect(consumeComposerPrefill(api)).toBe("a");
  });
  it("appends on a new line and never overwrites typed text", () => {
    expect(mergePrefill("", "x")).toBe("x");
    expect(mergePrefill("typed", "x")).toBe("typed\nx");
    expect(mergePrefill("typed\n", "x")).toBe("typed\nx");
    expect(mergePrefill("typed x here", "x")).toBe("typed x here");
  });
});
