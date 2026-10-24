import { describe, expect, it } from "vitest";
import { collectGuidedScanPlan, parseScanModelAssignments, scanRoutingSummary } from "./guided-scan.js";

function scripted(answers: string[]) {
  const output: string[] = [];
  return { output, io: {
    question: async (prompt: string) => { output.push(prompt); if (!answers.length) throw new Error("Missing test response"); return answers.shift()!; },
    write: (text: string) => { output.push(text); },
  } };
}

describe("interactive scan planning", () => {
  it("reuses scope, collects shared limits and explicit parallel runs, then requires confirmation", async () => {
    const { io, output } = scripted(["unknown-vulnerabilities", "quick", "3", "parallel", "2", "1.5", "yes"]);
    const plan = await collectGuidedScanPlan({ target: "https://target.test/allowed", model: "operator-model", agentModels: { verify: "approved-verifier" } }, io);
    expect(plan).toEqual({ goal: "unknown-vulnerabilities", depth: "quick", runCount: 3, executionMode: "parallel", timeCapMs: 120_000, costCapUsd: 1.5 });
    const text = output.join("");
    expect(text).toContain("https://target.test/allowed");
    expect(text).toContain("3 separate run(s) · parallel · 2m total · $1.5 total");
    expect(text).toContain("verify: approved-verifier");
    expect(text).toContain("not a guaranteed provider charge ceiling");
    expect(text).toContain("Start this plan?");
  });

  it("defaults to a conservative recommendation and declines without affirmative approval", async () => {
    const { io } = scripted(["", "", "", "", "", "", ""]);
    expect(await collectGuidedScanPlan({ target: "https://target.test" }, io)).toBeUndefined();
  });

  it("retries invalid controls without increasing the operator's chosen limits", async () => {
    const { io } = scripted(["misconfigurations", "deep", "-2", "2", "parallel", "0", "0.5", "NaN", "0.25", "y"]);
    const plan = await collectGuidedScanPlan({ target: "https://target.test" }, io);
    expect(plan).toMatchObject({ depth: "deep", runCount: 2, timeCapMs: 30_000, costCapUsd: 0.25 });
  });
});

describe("explicit scan task routing", () => {
  it("preserves model IDs including embedded equals and enforces single model summaries", () => {
    const assignments = parseScanModelAssignments(["discovery=provider/recon", "verify=provider/model=id"]);
    expect(assignments).toEqual({ discovery: "provider/recon", verify: "provider/model=id" });
    expect(scanRoutingSummary("selected", assignments)).toContain("verify: provider/model=id");
    expect(scanRoutingSummary("selected", assignments, true)).toBe("discovery: selected · attack: selected · verify: selected · report: selected");
  });
  it.each(["verify=auto", "verify=", "recon=model", "model", "verify=model\nother"])("rejects invalid or implicit routing %s", value => {
    expect(() => parseScanModelAssignments([value])).toThrow(/task-model/);
  });
  it("rejects conflicting repeated task pins", () => {
    expect(() => parseScanModelAssignments(["verify=first", "verify=second"])).toThrow(/Duplicate/);
  });
});
