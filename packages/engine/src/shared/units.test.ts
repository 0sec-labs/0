import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, KB, MB, MINUTE_MS, SECOND_MS } from "./units.js";

describe("units", () => {
  it("matches the literals they replace", () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
    expect(HOUR_MS).toBe(3_600_000);
    expect(MINUTE_MS).toBe(60_000);
    expect(SECOND_MS).toBe(1000);
    expect(KB).toBe(1024);
    expect(MB).toBe(1024 * 1024);
  });
});
