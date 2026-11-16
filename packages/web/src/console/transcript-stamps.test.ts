import { describe, expect, it } from "vitest";
import { needsStamp } from "./transcript-stamps";

describe("needsStamp", () => {
  const at = (hh: number, mm: number, day = 4) => new Date(2026, 10, day, hh, mm).toISOString();
  it("stamps the first turn", () => expect(needsStamp(undefined, at(22, 22))).toBe(true));
  it("does not stamp a quick follow-up", () => expect(needsStamp(at(22, 0), at(22, 20))).toBe(false));
  it("stamps after a gap over 30 minutes", () => expect(needsStamp(at(22, 0), at(22, 45))).toBe(true));
  it("stamps a new day even within 30 minutes", () => expect(needsStamp(at(23, 50), at(0, 10, 5))).toBe(true));
  it("never stamps a turn without a time", () => expect(needsStamp(at(1, 0), undefined)).toBe(false));
});
