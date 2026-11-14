import { describe, expect, it } from "vitest"
import { NOT_FOUND_SECTIONS, notFoundMessage } from "./not-found"

describe("not found mapping", () => {
  it("links each section back to its list page", () => {
    expect(NOT_FOUND_SECTIONS.findings.to).toBe("/findings")
    expect(NOT_FOUND_SECTIONS.sentinels.to).toBe("/sentinels")
    expect(NOT_FOUND_SECTIONS.automations.to).toBe("/automations")
  })
  it("names the missing entity", () => {
    expect(notFoundMessage("sentinels")).toContain("sentinel")
  })
})
