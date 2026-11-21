import { describe, expect, it } from "vitest";
import { parseScannerList, scannerArguments, scannerById } from "./scanners.js";
import { prePassBlock } from "./scan-prompt.js";

describe("scanners", () => {
  it("defaults to foxguard and accepts a list, with commas", () => {
    expect(parseScannerList(undefined)).toEqual(["foxguard"]);
    expect(parseScannerList(["semgrep,opengrep", "semgrep"])).toEqual(["semgrep", "opengrep"]);
    expect(() => parseScannerList(["nope"])).toThrow("Unknown scanner 'nope'");
  });
  it("puts the folder in the arguments and never lets it become a flag", () => {
    expect(scannerArguments(scannerById("foxguard")!, "/work/app")).toEqual(["--format", "sarif", "/work/app"]);
    expect(scannerArguments(scannerById("semgrep")!, "/w", "p/default")).toContain("p/default");
  });
  it("names every scanner in the leads block", () => {
    const lead = { tool: "semgrep", ruleId: "r", title: "t", description: "", severity: "high" as const, category: "other" as const, path: "a.ts", startLine: 1, fingerprint: "x", cwe: [] };
    const text = prePassBlock({ tools: ["foxguard", "semgrep"], total: 1, leads: [lead] });
    expect(text).toContain("foxguard, semgrep");
    expect(text).toContain("- semgrep high a.ts:1 r");
  });
});
