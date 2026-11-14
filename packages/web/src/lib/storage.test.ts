import { describe, expect, it } from "vitest";
import { STORAGE_KEYS, createStorage, parseJson, type KeyValueStore } from "./storage";

function stub(options: { failWrites?: boolean; failReads?: boolean } = {}) {
  const map = new Map<string, string>();
  const store: KeyValueStore & { map: Map<string, string> } = {
    map,
    getItem: key => { if (options.failReads) throw new Error("denied"); return map.get(key) ?? null; },
    setItem: (key, value) => { if (options.failWrites) throw new Error("quota"); map.set(key, value); },
    removeItem: key => { map.delete(key); },
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
  };
  return store;
}

describe("storage", () => {
  it("parses JSON safely", () => {
    expect(parseJson("{\"a\":1}", {})).toEqual({ a: 1 });
    expect(parseJson("{oops", { ok: true })).toEqual({ ok: true });
    expect(parseJson("", 5)).toBe(5);
    expect(parseJson("\"x\"", 1, (value): value is number => typeof value === "number")).toBe(1);
  });
  it("round-trips and survives broken storage", () => {
    const local = stub();
    const api = createStorage(() => local);
    expect(api.writeJson(STORAGE_KEYS.drafts, { a: "draft" })).toBe(true);
    expect(local.map.get("0-console-drafts")).toBe("{\"a\":\"draft\"}");
    expect(api.readJson(STORAGE_KEYS.drafts, {})).toEqual({ a: "draft" });
    const broken = createStorage(() => stub({ failWrites: true, failReads: true }));
    expect(broken.writeJson("k", 1)).toBe(false);
    expect(broken.readJson("k", "fallback")).toBe("fallback");
    const missing = createStorage(() => undefined);
    expect(missing.writeText("k", "v")).toBe(false);
    expect(missing.readText("k")).toBeNull();
    expect(missing.clear()).toBe(0);
    const throwing = createStorage(() => { throw new Error("SecurityError"); });
    expect(throwing.readJson("k", 2)).toBe(2);
    expect(throwing.writeJson("k", 2)).toBe(false);
  });
  it("migrates a legacy key once without losing the old copy", () => {
    const local = stub();
    local.map.set("legacy", "{\"w\":563}");
    const api = createStorage(() => local);
    expect(api.readJsonMigrating("current", "legacy", null)).toEqual({ w: 563 });
    expect(local.map.get("current")).toBe("{\"w\":563}");
    expect(local.map.has("legacy")).toBe(true);
    local.map.set("current", "{\"w\":1}");
    expect(api.readJsonMigrating("current", "legacy", null)).toEqual({ w: 1 });
    expect(api.readJsonMigrating("none", undefined, "fb")).toBe("fb");
  });
  it("migrates even when the new key cannot be written", () => {
    const local = stub({ failWrites: true });
    local.map.set("legacy", "[1]");
    expect(createStorage(() => local).readJsonMigrating("current", "legacy", [])).toEqual([1]);
  });
  it("clears only registry-owned keys in both areas", () => {
    const local = stub(); const session = stub();
    for (const key of ["0-console-drafts", "0-backend:[\"local\",\"x\"]", "0-last-model:local", "0-console-dock-view:abc:layout", "agent-editor:7", "zero-web-theme", "unrelated", "other-app"]) local.map.set(key, "1");
    session.map.set("0:model-catalog:v1:[1]", "1"); session.map.set("foreign", "1");
    const api = createStorage(area => area === "local" ? local : session);
    expect(api.clear()).toBe(7);
    expect([...local.map.keys()].sort()).toEqual(["other-app", "unrelated"]);
    expect([...session.map.keys()]).toEqual(["foreign"]);
  });
});
