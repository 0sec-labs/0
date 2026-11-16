import { describe, expect, it } from "vitest";
import { approvalRefusal } from "../approval-gate.js";

describe("approval gate", () => {
  it("refuses from an agent session even with a terminal", () => {
    expect(approvalRefusal("install an extension", { env: { ZERO_AGENT_SESSION: "1" }, stdinIsTTY: true })).toMatch(/agent session/);
  });
  it("refuses without a terminal: a flag alone never approves", () => {
    expect(approvalRefusal("install an extension", { env: {}, stdinIsTTY: false })).toMatch(/without a terminal/);
  });
  it("lets an operator at a terminal proceed", () => {
    expect(approvalRefusal("install an extension", { env: {}, stdinIsTTY: true })).toBeNull();
  });
});
