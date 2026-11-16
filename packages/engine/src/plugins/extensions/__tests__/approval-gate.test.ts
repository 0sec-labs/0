import { describe, expect, it } from "vitest";
import { approvalRefusal } from "../approval-gate.js";

describe("approval gate", () => {
  it("refuses from an agent session even with a terminal", () => {
    expect(approvalRefusal("install an extension", { env: { ZERO_AGENT_SESSION: "1" }, stdinIsTTY: true })).toMatch(/agent session/);
  });
  it("lets a person without a terminal proceed (CI, scripts): the agent marker decides, not the TTY", () => {
    expect(approvalRefusal("install an extension", { env: {}, stdinIsTTY: false })).toBeNull();
    expect(approvalRefusal("install an extension", { env: { ZERO_AGENT_SESSION: "1" }, stdinIsTTY: false })).toMatch(/agent session/);
  });
  it("lets an operator at a terminal proceed", () => {
    expect(approvalRefusal("install an extension", { env: {}, stdinIsTTY: true })).toBeNull();
  });
});
