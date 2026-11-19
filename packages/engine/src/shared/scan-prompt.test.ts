import { describe, expect, it } from "vitest";
import { scanPrompt } from "./scan-prompt.js";

describe("scanPrompt", () => {
  it("names the target and the skill, and asks for located findings and a summary", () => {
    const text = scanPrompt("/work/app");
    expect(text).toContain("Scan /work/app");
    expect(text).toContain("`scan` skill");
    expect(text).toMatch(/source_path, source_start_line and source_end_line/);
    expect(text).toMatch(/summary of what you covered/);
  });
  it("uses the skill it is given", () => expect(scanPrompt("x", "other")).toContain("`other` skill"));
});
