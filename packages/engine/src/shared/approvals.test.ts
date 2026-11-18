import { describe, expect, it } from "vitest";
import { LEGACY_ACCESS_VALUES, executionPolicy, legacyAskedFirst, parseApprovals } from "./approvals.js";

/**
 * Golden characterisation of the one execution policy. There is a single mode (shell access); the only switch is the
 * global operator setting "Ask before running commands".
 *
 *  - default (auto): full shell syntax and verification receipts. Budget and sandbox still bound it.
 *  - Ask before running commands: every effectful call goes to the operator (asksBeforeEffectfulTools) and the narrower
 *    capability set the setting always had (tokenised commands).
 * If this table changes, the safety posture changed, and that must be a deliberate decision.
 */
const GOLDEN_AUTO = { asksBeforeEffectfulTools: false, fullShell: true, verificationReceipts: true };
const GOLDEN_ASK_FIRST = { asksBeforeEffectfulTools: true, fullShell: false, verificationReceipts: false };

describe("execution policy golden table", () => {
  it("default keeps its capability flags", () => expect(executionPolicy()).toEqual(GOLDEN_AUTO));
  it("Ask before running commands gates tool execution through approvals", () => {
    expect(executionPolicy("ask")).toEqual(GOLDEN_ASK_FIRST);
    expect(executionPolicy(true)).toEqual(GOLDEN_ASK_FIRST);
    expect(executionPolicy("auto")).toEqual(GOLDEN_AUTO);
  });
  it("has no state that refuses effectful tools", () => {
    for (const approvals of [undefined, "ask", "auto"] as const) expect(executionPolicy(approvals)).not.toHaveProperty("refusesEffectfulTools");
  });
});

describe("older stored access values all load as the single mode", () => {
  it("no legacy value is refused or narrows the policy, except the two that used to ask first", () => {
    for (const value of [...LEGACY_ACCESS_VALUES, "observe", "recon", "read-only", undefined, null, "", "nope"]) {
      expect(executionPolicy("auto", value)).toEqual(GOLDEN_ASK_FIRST.asksBeforeEffectfulTools && legacyAskedFirst(value) ? GOLDEN_ASK_FIRST : GOLDEN_AUTO);
      expect(() => executionPolicy(undefined, value)).not.toThrow();
    }
  });
  it("read-only, observe and recon are the one mode with full shell", () => {
    for (const value of ["read-only", "observe", "recon"]) expect(executionPolicy(undefined, value)).toEqual(GOLDEN_AUTO);
  });
  it("knows which older values asked before every action", () => {
    expect(legacyAskedFirst("standard")).toBe(true);
    expect(legacyAskedFirst("propose")).toBe(true);
    for (const value of ["recon", "copilot", "yolo", "act", "run", "observe", "changes", "read-only", undefined]) expect(legacyAskedFirst(value)).toBe(false);
  });
  it("an older standard value handed to the engine still asks first", () => {
    expect(executionPolicy(undefined, "standard")).toEqual(GOLDEN_ASK_FIRST);
  });
});

describe("approvals setting", () => {
  it("parses only ask and auto", () => {
    expect(parseApprovals("ask")).toBe("ask");
    expect(parseApprovals("auto")).toBe("auto");
    expect(parseApprovals("yolo")).toBeUndefined();
  });
});
