import { describe, expect, it } from "vitest";
import { executionPolicy, legacyAskedFirst, normalizeAccess, parseAccess, parseApprovals, type ConsoleAccess } from "./approvals.js";

/**
 * Golden characterisation of what each of the two access states allows. This table was deliberately re-baselined
 * when the four engine modes (standard, recon, copilot, yolo) collapsed into two states:
 *
 *  - read-only grants exactly what the former recon mode did: nothing effectful. Effectful tools are refused outright,
 *    there is no public network, no full shell, no automatic folder grants and scope never grows on its own.
 *  - changes grants exactly what the former yolo mode did: public-network tools, full shell syntax, the lifted audit
 *    allow-list, inherited console tools, automatic folder grants, verification receipts and target-related scope growth.
 *
 * "Ask before running commands" is not a state. It is the global setting, applied on top of changes: it gates every
 * effectful tool call through approvals (asksBeforeEffectfulTools) and keeps the narrower capability set the setting always
 * had (the former standard row: no public-network shortcut, tokenised commands, every grant behind a prompt). It grants
 * nothing and does nothing to read-only.
 * If this table changes, the safety posture changed, and that must be a deliberate decision.
 */
const GOLDEN: Record<ConsoleAccess, ReturnType<typeof executionPolicy>> = {
  "read-only": { asksBeforeEffectfulTools: false, refusesEffectfulTools: true, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" },
  changes: { asksBeforeEffectfulTools: false, refusesEffectfulTools: false, publicNetwork: true, fullShell: true, liftsAuditAllowList: true, inheritsConsoleTools: true, autoGrantsLocalPaths: true, verificationReceipts: true, scopeExpansion: "target-related" },
};
const GOLDEN_ASK_FIRST = { asksBeforeEffectfulTools: true, refusesEffectfulTools: false, publicNetwork: false, fullShell: false, liftsAuditAllowList: false, inheritsConsoleTools: false, autoGrantsLocalPaths: false, verificationReceipts: false, scopeExpansion: "ask" } as const;

describe("execution policy golden table", () => {
  for (const access of Object.keys(GOLDEN) as ConsoleAccess[]) {
    it(`${access} keeps its capability flags`, () => expect(executionPolicy(access)).toEqual(GOLDEN[access]));
  }
  it("changes with Ask before running commands on gates tool execution through approvals", () => {
    expect(executionPolicy("changes", "ask")).toEqual(GOLDEN_ASK_FIRST);
    expect(executionPolicy("changes", "auto")).toEqual(GOLDEN.changes);
  });
  it("read-only cannot run commands or mutate, whatever the approvals setting says", () => {
    for (const approvals of [undefined, "ask", "auto"] as const) {
      expect(executionPolicy("read-only", approvals)).toEqual(GOLDEN["read-only"]);
      expect(executionPolicy("read-only", approvals).refusesEffectfulTools).toBe(true);
    }
  });
  it("unknown or missing values get the most restrictive (read-only) capabilities", () => {
    for (const value of [undefined, "", "constructor", "nope"]) expect(executionPolicy(value)).toEqual(GOLDEN["read-only"]);
  });
  it("only changes unlocks public network, full shell and automatic folder grants", () => {
    const unlockers = (Object.keys(GOLDEN) as ConsoleAccess[]).filter(a => executionPolicy(a).publicNetwork || executionPolicy(a).fullShell || executionPolicy(a).autoGrantsLocalPaths);
    expect(unlockers).toEqual(["changes"]);
  });
});

describe("older stored values stay readable", () => {
  it("reads every older value as one of the two states", () => {
    for (const value of ["recon", "observe", "read-only"]) expect(normalizeAccess(value)).toBe("read-only");
    for (const value of ["standard", "copilot", "yolo", "propose", "run", "act", "changes", "commands", "pull-requests"]) expect(normalizeAccess(value)).toBe("changes");
  });
  it("defaults when absent and reads garbage as read-only", () => {
    expect(normalizeAccess(undefined)).toBe("read-only");
    expect(normalizeAccess(undefined, "changes")).toBe("changes");
    expect(normalizeAccess("nope", "changes")).toBe("read-only");
    expect(parseAccess("nope")).toBeUndefined();
  });
  it("knows which older values asked before every action", () => {
    expect(legacyAskedFirst("standard")).toBe(true);
    expect(legacyAskedFirst("propose")).toBe(true);
    for (const value of ["recon", "copilot", "yolo", "act", "run", "observe", "changes", undefined]) expect(legacyAskedFirst(value)).toBe(false);
  });
  it("an older standard value handed to the engine still asks first", () => {
    expect(executionPolicy("standard")).toEqual(GOLDEN_ASK_FIRST);
    expect(executionPolicy("yolo")).toEqual(GOLDEN.changes);
    expect(executionPolicy("recon")).toEqual(GOLDEN["read-only"]);
  });
});

describe("approvals setting", () => {
  it("parses only ask and auto", () => {
    expect(parseApprovals("ask")).toBe("ask");
    expect(parseApprovals("auto")).toBe("auto");
    expect(parseApprovals("yolo")).toBeUndefined();
  });
});
