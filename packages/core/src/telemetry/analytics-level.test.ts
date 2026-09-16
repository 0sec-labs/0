import { describe, expect, it } from "vitest";
import {
  ANALYTICS_OPT_OUT_ENV,
  type AnalyticsLevel,
  levelAtLeast,
  resolveAnalyticsLevel,
} from "./analytics-level.js";

describe("levelAtLeast", () => {
  it("orders off < usage < commands < full", () => {
    expect(levelAtLeast("full", "commands")).toBe(true);
    expect(levelAtLeast("commands", "usage")).toBe(true);
    expect(levelAtLeast("usage", "off")).toBe(true);
    expect(levelAtLeast("off", "usage")).toBe(false);
    expect(levelAtLeast("usage", "full")).toBe(false);
    expect(levelAtLeast("commands", "commands")).toBe(true);
  });
});

describe("resolveAnalyticsLevel — parsing", () => {
  const levels: AnalyticsLevel[] = ["off", "usage", "commands", "full"];
  for (const level of levels) {
    it(`parses ${level}`, () => {
      expect(resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": level })).toBe(level);
    });
  }

  it("is case-insensitive and trims", () => {
    expect(resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "  FULL " })).toBe("full");
  });

  it("defaults to full when unset", () => {
    expect(resolveAnalyticsLevel({})).toBe("full");
  });

  it("opt-out env still wins over default full", () => {
    expect(resolveAnalyticsLevel({ "0SEC_OFFLINE": "1" })).toBe("off");
    expect(resolveAnalyticsLevel({ "DO_NOT_TRACK": "1" })).toBe("off");
  });

  it("fails closed to off on an unknown/invalid value", () => {
    expect(resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "everything" })).toBe("off");
    expect(resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "" })).toBe("off");
  });
});

describe("resolveAnalyticsLevel — opt-out wins", () => {
  for (const name of ANALYTICS_OPT_OUT_ENV) {
    it(`${name} forces off even with full requested`, () => {
      expect(
        resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "full", [name]: "1" }),
      ).toBe("off");
    });

    it(`${name} set to a truthy word forces off`, () => {
      expect(
        resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "full", [name]: "true" }),
      ).toBe("off");
    });

    it(`${name} explicitly falsy does NOT force off`, () => {
      expect(
        resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "full", [name]: "0" }),
      ).toBe("full");
      expect(
        resolveAnalyticsLevel({ "0SEC_ANALYTICS_LEVEL": "full", [name]: "false" }),
      ).toBe("full");
    });
  }
});
