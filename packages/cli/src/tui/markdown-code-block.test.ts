import { describe, expect, it } from "vitest";

import { firstCodeBlock } from "./markdown.js";

describe("firstCodeBlock", () => {
  it("returns null when there is no fenced code block", () => {
    expect(firstCodeBlock("just a paragraph with `inline` code")).toBeNull();
    expect(firstCodeBlock("")).toBeNull();
  });

  it("extracts the verbatim contents of a fenced block", () => {
    const md = "before\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\nafter";
    expect(firstCodeBlock(md)).toBe("const x = 1;\nconsole.log(x);");
  });

  it("returns the FIRST block when several are present", () => {
    const md = "```\nfirst\n```\n\ntext\n\n```\nsecond\n```";
    expect(firstCodeBlock(md)).toBe("first");
  });

  it("handles a fence with no info string", () => {
    expect(firstCodeBlock("```\nplain\n```")).toBe("plain");
  });
});
