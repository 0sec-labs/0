import { describe, expect, it } from "vitest";
import { applySentinelPatch, parseSentinelCreate, sentinelAccessFields, sentinelAccessLevel, sentinelWrittenAutonomy, normalizeSentinelAccessLevel, type Sentinel } from "./sentinels.js";

describe("Agent access: Read-only or Can make changes", () => {
  it("derives the level from the stored autonomy without widening anything", () => {
    expect(sentinelAccessLevel("observe")).toBe("read-only");
    for (const stored of ["propose", "run", "act"] as const) expect(sentinelAccessLevel(stored)).toBe("changes");
    expect(sentinelWrittenAutonomy("observe")).toBe("observe");
    for (const stored of ["propose", "run", "act"] as const) expect(sentinelWrittenAutonomy(stored)).toBe("act");
  });
  it("accepts the older access values as aliases of changes", () => {
    expect(normalizeSentinelAccessLevel("commands")).toBe("changes");
    expect(normalizeSentinelAccessLevel("pull-requests")).toBe("changes");
    expect(normalizeSentinelAccessLevel("changes")).toBe("changes");
    expect(normalizeSentinelAccessLevel("root")).toBeUndefined();
  });
  it("stores only observe or act for new choices", () => {
    expect(sentinelAccessFields("changes")).toEqual({ autonomy: "act", toolAccess: "exec" });
    expect(sentinelAccessFields("read-only")).toEqual({ autonomy: "observe", toolAccess: "read-only" });
    expect(sentinelAccessFields("changes", { autonomy: "run", toolAccess: "read-only" })).toEqual({ autonomy: "act", toolAccess: "read-only" });
    expect(sentinelAccessFields("changes", { autonomy: "observe", toolAccess: "read-web" })).toEqual({ autonomy: "act", toolAccess: "exec" });
    expect(sentinelAccessFields("read-only", { autonomy: "act", toolAccess: "exec" })).toEqual({ autonomy: "observe", toolAccess: "read-only" });
  });
  it("accepts accessLevel (and its older spellings) as a create alias and still validates the stored shape", () => {
    for (const level of ["changes", "commands", "pull-requests"]) expect(parseSentinelCreate({ name: "A", accessLevel: level })).toMatchObject({ autonomy: "act", toolAccess: "exec" });
    expect(parseSentinelCreate({ name: "A", accessLevel: "read-only" })).toMatchObject({ autonomy: "observe", toolAccess: "read-only" });
    expect(parseSentinelCreate({ name: "A" })).toMatchObject({ autonomy: "observe" });
    expect(() => parseSentinelCreate({ name: "A", accessLevel: "root" })).toThrow();
  });
  it("saving normalises older values to observe or act and keeps web access", () => {
    const make = (autonomy: "propose" | "run") => ({ ...parseSentinelCreate({ name: "A", autonomy }), id: "1", homeMissionId: null, owner: "x", version: 1, createdAt: "", updatedAt: "" }) as Sentinel;
    expect(parseSentinelCreate({ name: "A", autonomy: "propose" })).toMatchObject({ autonomy: "act" });
    expect(parseSentinelCreate({ name: "A", access: "changes" })).toMatchObject({ autonomy: "act", toolAccess: "exec" });
    // A stored propose Agent is only rewritten when a save names access; other patches leave the row alone.
    const stored = { ...make("run"), autonomy: "propose", toolAccess: "read-only" } as Sentinel;
    expect(applySentinelPatch(stored, { version: 1, mission: "m" })).toMatchObject({ autonomy: "propose" });
    expect(applySentinelPatch(stored, { version: 1, access: "changes" })).toMatchObject({ autonomy: "act", toolAccess: "read-only" });
    expect(applySentinelPatch(stored, { version: 1, autonomy: "run" })).toMatchObject({ autonomy: "act" });
    expect(applySentinelPatch(stored, { version: 1, accessLevel: "commands" })).toMatchObject({ autonomy: "act" });
    expect(applySentinelPatch(stored, { version: 1, access: "read-only" })).toMatchObject({ autonomy: "observe" });
  });
});
