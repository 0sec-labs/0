import { describe, expect, it } from "vitest";
import { findingSchema, normalizeAttackCategory } from "./finding-schemas.js";

describe("normalizeAttackCategory", () => {
  it("keeps a category we have, ignoring case and spaces around it", () => {
    expect(normalizeAttackCategory("sql-injection")).toEqual({ category: "sql-injection" });
    expect(normalizeAttackCategory("  SSRF ")).toEqual({ category: "ssrf" });
  });
  it("turns a label we do not have into other and returns the label", () => {
    expect(normalizeAttackCategory("broken-access-control")).toEqual({ category: "other", unknownLabel: "broken-access-control" });
  });
  it("turns a missing category into other with no label", () => {
    for (const value of [undefined, "", "   ", 7]) expect(normalizeAttackCategory(value)).toEqual({ category: "other" });
  });
  it("always yields a category the finding schema accepts", () => {
    for (const value of ["idor", "xss", undefined]) {
      const { category } = normalizeAttackCategory(value);
      expect(findingSchema.shape.category.safeParse(category).success).toBe(true);
    }
  });
});
