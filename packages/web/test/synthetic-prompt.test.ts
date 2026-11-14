import { describe, expect, it } from "vitest";
import { classifySyntheticPrompt, SYNTHETIC_PROMPT_PATTERNS } from "../src/console/synthetic-prompt";
import { shouldClamp } from "../src/console/message-clamp";

describe("classifySyntheticPrompt", () => {
  it("detects the engine auto-resume prompt", () => {
    const text = "Continue the existing authorized investigation from the latest retained state. The runtime now handles dropped model connections automatically. Use completed tool results. Continue now.";
    expect(classifySyntheticPrompt(text)).toBe("dropped-connection");
    expect(classifySyntheticPrompt("Resume only genuinely unfinished work.")).toBe("resume");
  });
  it("leaves ordinary user text alone", () => {
    for (const text of ["continue", "Please continue with the audit", "Can you continue the existing investigation?", "", "Resume the scan"]) expect(classifySyntheticPrompt(text)).toBeUndefined();
  });
  it("honours an explicit marker", () => {
    expect(classifySyntheticPrompt("anything", { synthetic: true })).toBe("resume");
    expect(classifySyntheticPrompt("anything", { synthetic: false })).toBeUndefined();
  });
  it("keeps patterns anchored", () => {
    expect(SYNTHETIC_PROMPT_PATTERNS.every(entry => entry.pattern.source.startsWith("^"))).toBe(true);
  });
});

describe("shouldClamp", () => {
  it("clamps only tall finished content", () => {
    expect(shouldClamp(900, false)).toBe(true);
    expect(shouldClamp(900, true)).toBe(false);
    expect(shouldClamp(330, false)).toBe(false);
  });
});
