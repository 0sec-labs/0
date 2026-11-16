import { describe, expect, it } from "vitest";
import { moveBefore, moveId, usageBar, safeLogo } from "./connections-model";

describe("safeLogo", () => {
  it("allows same-origin only", () => {
    expect(safeLogo("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeLogo("/assets/logo.png")).toBe("/assets/logo.png");
    for (const bad of ["https://evil.example/x.png", "//evil.example/x.png", "http://a/b", "javascript:alert(1)", "data:text/html;base64,AAAA", "/../x", "/\\evil.com", "", undefined, 3]) expect(safeLogo(bad)).toBeUndefined();
  });
});

describe("list helpers", () => {
  it("reorders", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    const same = ["a", "b"]; expect(moveId(same, "a", -1)).toBe(same); expect(moveId(same, "z", 1)).toBe(same);
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });
  it("only reports usage the backend provided", () => {
    expect(usageBar(undefined)).toBeNull();
    expect(usageBar({ available: false, source: null, window: null, reason: "not_exposed" })).toBeNull();
    expect(usageBar({ available: true, window: { kind: "credit-limit", limit: 0, remaining: 0 } })).toBeNull();
    const bar = usageBar({ available: true, window: { kind: "credit-limit", limit: 10, remaining: 2.5, usedDaily: 1, currency: "USD" } });
    expect(bar).toMatchObject({ usedPercent: 75, caption: "$7.50 of $10.00 used", breakdown: ["$1.00 today"] });
    expect(usageBar({ available: true, window: { limit: 10, remaining: -5 } })?.usedPercent).toBe(100);
  });
});
