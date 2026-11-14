import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, effectiveName, initialsOf, normalizeProfile } from "./profile";

describe("local profile", () => {
  it("normalizes malformed storage to defaults", () => {
    expect(normalizeProfile(null)).toEqual(DEFAULT_PROFILE);
    expect(normalizeProfile({ displayName: 5, colour: "pink" })).toEqual(DEFAULT_PROFILE);
    expect(normalizeProfile({ displayName: "  Ada   Lovelace ", colour: "green" })).toEqual({ displayName: "Ada Lovelace", colour: "green" });
    expect(normalizeProfile({ displayName: "x".repeat(200) }).displayName).toHaveLength(40);
  });
  it("derives initials and the effective name", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("ada")).toBe("A");
    expect(initialsOf("Grace Brewster Hopper")).toBe("GH");
    expect(initialsOf("  ")).toBe("?");
    expect(effectiveName(DEFAULT_PROFILE)).toBe("Local");
    expect(effectiveName(DEFAULT_PROFILE, "peak")).toBe("peak");
    expect(effectiveName({ displayName: "Ada", colour: "neutral" }, "peak")).toBe("Ada");
  });
});
