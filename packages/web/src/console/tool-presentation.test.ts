import { describe, expect, it } from "vitest";
import { presentToolCall } from "./tool-presentation";

describe("saved finding calls", () => {
  it("renders the old save_finding and update_finding names like the merged finding tool", () => {
    const result = { success: true, output: { message: "Finding saved", findingId: "f1" } };
    const args = { title: "SQL injection", severity: "high" };
    const merged = presentToolCall({ id: "t1", name: "finding", arguments: args, result } as never);
    for (const name of ["save_finding", "update_finding"]) {
      const old = presentToolCall({ id: "t2", name, arguments: args, result } as never);
      expect(old.title).toBe(merged.title);
      expect(old.output).toBe(merged.output);
    }
  });
});
