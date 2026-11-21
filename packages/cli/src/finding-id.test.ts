import { describe, expect, it } from "vitest";
import { resolveFindingId, shortFindingId, shortFingerprint } from "./finding-id.js";

const scan = `sarif-${"a1".repeat(32)}`;
const imported = (own: string) => ({ id: `${scan}-${own}` });
const rows = [imported("0123456789abcdef01234567"), imported("0f9e8d7c6b5a49382716f5e4"), { id: "native-1234-abcd" }];

describe("finding ids", () => {
  it("shows the part that differs for imported findings and the start for ordinary ones", () => {
    expect(shortFindingId(rows[0]!.id)).toBe("01234567");
    expect(shortFindingId("native-1234-abcd")).toBe("native-1");
    expect(shortFingerprint(`${scan}:sarif:deadbeefcafe0123`)).toBe("deadbeefca");
    expect(shortFingerprint("loc:abcdef0123456789")).toBe("loc:abcdef");
  });
  it("finds a finding by its whole id, a prefix, the shown part, or its end", () => {
    expect(resolveFindingId(rows, rows[0]!.id)).toBe(rows[0]);
    expect(resolveFindingId(rows, "native-12")).toBe(rows[2]);
    expect(resolveFindingId(rows, "0123")).toBe(rows[0]);
    expect(resolveFindingId(rows, "ef01234567")).toBe(rows[0]);
  });
  it("says so when the text is ambiguous, and returns nothing for no match", () => {
    expect(() => resolveFindingId(rows, "0")).toThrow("is ambiguous");
    expect(() => resolveFindingId(rows, scan.slice(0, 20))).toThrow("is ambiguous");
    expect(resolveFindingId(rows, "zzzz")).toBeUndefined();
    expect(resolveFindingId(rows, "  ")).toBeUndefined();
  });
});
