import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS, normalizePrefs, shouldDeliver } from "./notifications";
import { STORAGE_KEYS, createStorage } from "./storage";

const on = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true };

describe("notification preferences", () => {
  it("defaults to off with a sound and hidden-only", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(DEFAULT_NOTIFICATION_PREFS).toMatchObject({ enabled: false, sound: true, onlyWhenHidden: true });
  });
  it("keeps valid fields and drops malformed ones", () => {
    const prefs = normalizePrefs({ enabled: true, sound: "loud", events: { "scan-finished": false, bogus: false } });
    expect(prefs.enabled).toBe(true);
    expect(prefs.sound).toBe(true);
    expect(prefs.events["scan-finished"]).toBe(false);
    expect(prefs.events["mission-finished"]).toBe(true);
    expect(Object.keys(prefs.events)).not.toContain("bogus");
  });
  it("is registered with the storage door and wiped by clear", () => {
    const map = new Map<string, string>();
    const api = createStorage(() => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); }, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null }));
    api.writeJson(STORAGE_KEYS.notificationPrefs, on);
    expect(normalizePrefs(api.readJson(STORAGE_KEYS.notificationPrefs, {}))).toEqual(on);
    expect(api.clear()).toBe(1);
  });
});

describe("shouldDeliver", () => {
  it("needs the master switch, the event and permission", () => {
    expect(shouldDeliver(DEFAULT_NOTIFICATION_PREFS, "mission-finished", { hidden: true, permission: "granted" })).toBe(false);
    expect(shouldDeliver(on, "mission-finished", { hidden: true, permission: "default" })).toBe(false);
    expect(shouldDeliver({ ...on, events: { ...on.events, "mission-finished": false } }, "mission-finished", { hidden: true, permission: "granted" })).toBe(false);
    expect(shouldDeliver(on, "mission-finished", { hidden: true, permission: "granted" })).toBe(true);
  });
  it("skips a visible tab unless hidden-only is off", () => {
    expect(shouldDeliver(on, "mission-approval", { hidden: false, permission: "granted" })).toBe(false);
    expect(shouldDeliver({ ...on, onlyWhenHidden: false }, "mission-approval", { hidden: false, permission: "granted" })).toBe(true);
  });
});
