import { describe, expect, it } from "vitest";
import { applySentinelPatch, dropAccessFields, parseSentinelCreate, sentinelReviewFingerprint, type Sentinel } from "./sentinels.js";

describe("Agent access: there is one mode", () => {
  const stored = (extra: Record<string, unknown>) => ({ ...parseSentinelCreate({ name: "A" }), id: "1", homeMissionId: null, owner: "x", version: 1, createdAt: "", updatedAt: "", ...extra }) as unknown as Sentinel;
  it("a new Agent stores no access fields", () => {
    const created = parseSentinelCreate({ name: "A" });
    expect(created).not.toHaveProperty("autonomy");
    expect(created).not.toHaveProperty("toolAccess");
  });
  it("accepts every older access input on create and ignores it", () => {
    for (const extra of [{ autonomy: "observe" }, { autonomy: "propose" }, { autonomy: "run" }, { autonomy: "act" }, { toolAccess: "read-only" }, { toolAccess: "read-web" }, { access: "read-only" }, { accessLevel: "changes" }, { access: "commands" }, { access: "anything" }]) {
      const created = parseSentinelCreate({ name: "A", ...extra });
      expect(created).toEqual(parseSentinelCreate({ name: "A" }));
    }
  });
  it("loads a stored record that still carries the retired fields and patches it without error", () => {
    for (const legacy of [{ autonomy: "observe", toolAccess: "read-only" }, { autonomy: "propose", toolAccess: "read-web" }, { autonomy: "run", toolAccess: "exec" }, { autonomy: "act", toolAccess: "exec" }]) {
      const patched = applySentinelPatch(stored(legacy), { version: 1, mission: "m", access: "read-only" });
      expect(patched.mission).toBe("m");
      expect(patched).not.toHaveProperty("autonomy");
      expect(patched).not.toHaveProperty("toolAccess");
    }
  });
  it("dropAccessFields removes only the retired keys", () => {
    expect(dropAccessFields({ name: "A", autonomy: "observe", toolAccess: "read-only", access: "x", accessLevel: "y" })).toEqual({ name: "A" });
  });
  it("the review fingerprint keeps the shell-access constant so reviewed Agents stay reviewed", () => {
    const sentinel = parseSentinelCreate({ name: "A" });
    expect(sentinelReviewFingerprint(sentinel)).toContain('"toolAccess":"exec","autonomy":"act"');
  });
});
