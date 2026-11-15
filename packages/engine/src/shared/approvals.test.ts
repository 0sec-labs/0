import { describe, expect, it } from "vitest";
import { approvalsFromMode, effectiveEngineMode, executionPolicy, modeFromApprovals, parseApprovals, type ApprovalsEngineMode } from "./approvals.js";

/**
 * Golden characterisation of what each engine mode allows. These flags were
 * extracted from direct `autonomyMode === "yolo"` checks; if this table changes
 * the safety posture of a mode changed, and that must be a deliberate decision.
 */
const GOLDEN: Record<ApprovalsEngineMode, ReturnType<typeof executionPolicy>> = {
  standard: { asksBeforeEffectfulTools: true, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" },
  recon: { asksBeforeEffectfulTools: false, refusesEffectfulTools: true, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" },
  copilot: { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "engagement" },
  yolo: { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: true, fullShell: true, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: true, verificationReceipts: true, scopeExpansion: "target-related" },
};

describe("execution policy golden table", () => {
  for (const mode of Object.keys(GOLDEN) as ApprovalsEngineMode[]) {
    it(`${mode} keeps its capability flags`, () => expect(executionPolicy(mode)).toEqual(GOLDEN[mode]));
  }
  it("unknown or missing modes get the most restrictive (standard) capabilities", () => {
    for (const mode of [undefined, "", "constructor", "nope"]) expect(executionPolicy(mode)).toEqual(GOLDEN.standard);
  });
  it("only the auto engine mode unlocks public network, full shell and automatic folder grants", () => {
    const unlockers = (Object.keys(GOLDEN) as ApprovalsEngineMode[]).filter(m => executionPolicy(m).publicNetwork || executionPolicy(m).fullShell || executionPolicy(m).autoGrantsLocalPaths);
    expect(unlockers).toEqual(["yolo"]);
  });
});

describe("approvals vocabulary", () => {
  it("reads stored modes without migrating them", () => {
    expect(approvalsFromMode("yolo")).toBe("auto");
    expect(approvalsFromMode("copilot")).toBe("auto");
    expect(approvalsFromMode("standard")).toBe("ask");
    expect(approvalsFromMode("recon")).toBe("ask");
    expect(approvalsFromMode(undefined)).toBe("ask");
  });
  it("writes the internal values", () => {
    expect(modeFromApprovals("auto")).toBe("yolo");
    expect(modeFromApprovals("ask")).toBe("standard");
  });
  it("parses only ask and auto", () => {
    expect(parseApprovals("ask")).toBe("ask");
    expect(parseApprovals("auto")).toBe("auto");
    expect(parseApprovals("yolo")).toBeUndefined();
  });
  it("ask-first only tightens", () => {
    expect(effectiveEngineMode("yolo", "ask")).toBe("standard");
    expect(effectiveEngineMode("copilot", "ask")).toBe("standard");
    expect(effectiveEngineMode("recon", "ask")).toBe("recon");
    expect(effectiveEngineMode("standard", "ask")).toBe("standard");
    expect(effectiveEngineMode("yolo", "auto")).toBe("yolo");
    expect(effectiveEngineMode("yolo", undefined)).toBe("yolo");
  });
});
