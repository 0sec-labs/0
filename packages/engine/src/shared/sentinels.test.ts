import { describe, expect, it } from "vitest";
import { applySentinelPatch, parseSentinelCreate, sentinelAccessFields, sentinelAccessLevel, type Sentinel } from "./sentinels.js";

describe("Agent access levels", () => {
  it("derives the level from the stored autonomy without widening anything", () => {
    expect(sentinelAccessLevel("observe")).toBe("read-only");
    expect(sentinelAccessLevel("propose")).toBe("commands");
    expect(sentinelAccessLevel("run")).toBe("commands");
    expect(sentinelAccessLevel("act")).toBe("pull-requests");
  });
  it("keeps stored fields when the level is unchanged and uses canonical ones otherwise", () => {
    expect(sentinelAccessFields("commands", { autonomy: "propose", toolAccess: "read-only" })).toEqual({ autonomy: "propose", toolAccess: "read-only" });
    expect(sentinelAccessFields("read-only", { autonomy: "act", toolAccess: "exec" })).toEqual({ autonomy: "observe", toolAccess: "read-only" });
    expect(sentinelAccessFields("commands")).toEqual({ autonomy: "run", toolAccess: "exec" });
    expect(sentinelAccessFields("pull-requests")).toEqual({ autonomy: "act", toolAccess: "exec" });
  });
  it("accepts accessLevel as a create alias and still validates the stored shape", () => {
    expect(parseSentinelCreate({ name: "A", accessLevel: "pull-requests" })).toMatchObject({ autonomy: "act", toolAccess: "exec" });
    expect(parseSentinelCreate({ name: "A", accessLevel: "read-only" })).toMatchObject({ autonomy: "observe", toolAccess: "read-only" });
    expect(parseSentinelCreate({ name: "A" })).toMatchObject({ autonomy: "propose" });
    expect(() => parseSentinelCreate({ name: "A", accessLevel: "root" })).toThrow();
  });
  it("patching with the current level changes nothing; an explicit autonomy wins", () => {
    const current = { ...parseSentinelCreate({ name: "A", autonomy: "propose" }), id: "1", homeMissionId: null, owner: "x", version: 1, createdAt: "", updatedAt: "" } as Sentinel;
    expect(applySentinelPatch(current, { version: 1, accessLevel: "commands" })).toMatchObject({ autonomy: "propose", toolAccess: "read-only" });
    expect(applySentinelPatch(current, { version: 1, accessLevel: "commands", autonomy: "run" })).toMatchObject({ autonomy: "run" });
    expect(applySentinelPatch(current, { version: 1, accessLevel: "read-only" })).toMatchObject({ autonomy: "observe" });
  });
});
