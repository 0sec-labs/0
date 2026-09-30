import { describe, expect, it } from "vitest";
import { toolCallStatus } from "../../../dashboard/src/console/tool-call-status.js";

const call = { id: "fixture-call", name: "bash", arguments: { command: "pwd" }, isRunning: false };

describe("web console tool receipt labels", () => {
  it("keeps incomplete, running and successful calls distinct", () => {
    expect(toolCallStatus(call)).toBe("Stopped");
    expect(toolCallStatus({ ...call, isRunning: true })).toBe("Running");
    expect(toolCallStatus({ ...call, result: null })).toBe("Done");
    expect(toolCallStatus({ ...call, result: { success: true, output: "ok" } })).toBe("Done");
  });
  it("recognizes actual failure flags in live and retained receipts", () => {
    expect(toolCallStatus({ ...call, result: { success: false, error: "Connection refused" } })).toBe("Error");
    expect(toolCallStatus({ ...call, result: { is_error: true, content: "Connection refused" } })).toBe("Error");
  });
  it.each(["Tool call cancelled before dispatch.", "Tool call cancelled by operator before dispatch."])("labels engine cancellation %s as stopped across receipt forms", error => {
    expect(toolCallStatus({ ...call, result: { success: false, error } })).toBe("Stopped");
    expect(toolCallStatus({ ...call, result: { is_error: true, content: error } })).toBe("Stopped");
  });
  it("does not treat arbitrary successful output as an error or cancellation", () => {
    expect(toolCallStatus({ ...call, result: "Error: cancelled" })).toBe("Done");
    expect(toolCallStatus({ ...call, result: { error: "Tool call cancelled before dispatch." } })).toBe("Done");
  });
});
