import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_MAX_CHARS, instructionCounter, instructionDraftState, instructionSaveBody, instructionSummary, instructionsUrl } from "./instructions-model";

describe("instructions model", () => {
  it("formats the counter", () => {
    expect(instructionCounter(1234)).toBe("1,234 of 32,000");
    expect(instructionCounter(0)).toBe("0 of 32,000");
  });
  it("blocks saving unchanged or oversize drafts", () => {
    expect(instructionDraftState("a", "a").canSave).toBe(false);
    expect(instructionDraftState("a", "ab")).toEqual({ dirty: true, overLimit: false, canSave: true });
    expect(instructionDraftState("", "x".repeat(INSTRUCTIONS_MAX_CHARS + 1))).toMatchObject({ overLimit: true, canSave: false });
    expect(instructionDraftState("", "x".repeat(INSTRUCTIONS_MAX_CHARS)).canSave).toBe(true);
  });
  it("summarises and builds requests", () => {
    expect(instructionSummary("  \n")).toBe("Empty");
    expect(instructionSummary("hello")).toBe("5 characters");
    expect(instructionsUrl("global", "/x")).toBe("/api/console/instructions/global");
    expect(instructionsUrl("workspace", "/a b")).toBe("/api/console/instructions/workspace?path=%2Fa%20b");
    expect(JSON.parse(instructionSaveBody("workspace", "c", "r1", "/w"))).toEqual({ content: "c", revision: "r1", path: "/w" });
    expect(JSON.parse(instructionSaveBody("global", "c", "r1", "/w"))).toEqual({ content: "c", revision: "r1" });
  });
});
