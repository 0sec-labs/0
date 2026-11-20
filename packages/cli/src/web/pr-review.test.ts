import { describe, expect, it } from "vitest";
import { diffRightLines, MAX_INLINE_SUGGESTIONS, planInlineSuggestions, suggestionBody, suggestionKey, type SuggestionFinding } from "./pr-review.js";

const patch = ["@@ -1,4 +10,5 @@ fn", " context ten", "-old", "+new eleven", "+new twelve", " context thirteen", "\\ No newline at end of file"].join("\n");
const finding = (over: Partial<SuggestionFinding> = {}): SuggestionFinding => ({ id: "f", title: "SQL injection", severity: "high", path: "src/db.ts", startLine: 11, suggestion: 'db.query("SELECT 1 WHERE id = ?", [id]);', ...over });
const plan = (findings: SuggestionFinding[], existing: Array<[string, string]> = []) => planInlineSuggestions({ sentinelId: "s1", findings, changed: new Map([["src/db.ts", diffRightLines(patch)]]), existing: new Map(existing) });

describe("diffRightLines", () => {
  it("counts added and context lines on the new side and skips removed lines", () => {
    expect([...diffRightLines(patch)]).toEqual([10, 11, 12, 13]);
    expect(diffRightLines(undefined).size).toBe(0);
  });
});

describe("planInlineSuggestions", () => {
  it("posts a suggestion block on a changed line, and a multi-line range from its first line", () => {
    const one = plan([finding()]);
    expect(one.post).toHaveLength(1);
    expect(one.post[0]).toMatchObject({ path: "src/db.ts", line: 11 });
    expect(one.post[0]!.body).toContain("```suggestion\ndb.query(");
    const range = plan([finding({ startLine: 11, endLine: 12 })]);
    expect(range.post[0]).toMatchObject({ line: 12, startLine: 11 });
  });

  it("skips findings with no replacement, outside the diff, or on an unsafe path", () => {
    const result = plan([finding({ suggestion: "  " }), finding({ startLine: 99 }), finding({ startLine: 12, endLine: 14 }), finding({ path: "../x" })]);
    expect(result.post).toEqual([]);
    expect(result.skipped).toBe(4);
  });

  it("does not post twice for the same finding and takes down comments whose finding is gone", () => {
    const key = suggestionKey(finding());
    const again = plan([finding()], [[key, "100"], ["stale", "200"]]);
    expect(again.post).toEqual([]);
    expect(again.remove).toEqual(["200"]);
  });

  it("caps how many it posts, most severe first", () => {
    const many = Array.from({ length: 14 }, (_, index) => finding({ title: `t${index}`, severity: index === 13 ? "critical" : "low" }));
    const result = plan(many);
    expect(result.post).toHaveLength(MAX_INLINE_SUGGESTIONS);
    expect(result.post[0]!.body).toContain("critical");
  });

  it("keeps a suggestion from closing its own fence or notifying anyone", () => {
    const body = suggestionBody("s1", finding({ title: "ping @victim [x](http://evil)", suggestion: "a\n```\nb" }));
    expect(body).toContain("````suggestion");
    expect(body).not.toMatch(/@(?!​)/);
    expect(body).not.toContain("http://evil");
  });
});
