import type { ToolCallState } from "./transcript";

const cancelledBeforeDispatch = new Set([
  "Tool call cancelled before dispatch.",
  "Tool call cancelled by operator before dispatch.",
]);

/** Only structured engine receipts signal errors; arbitrary output remains output. */
export function toolCallStatus(call: ToolCallState): "Running" | "Done" | "Stopped" | "Error" {
  if (call.isRunning) return "Running";
  if (call.result === undefined) return "Stopped";
  if (call.result && typeof call.result === "object") {
    const receipt = call.result as Record<string, unknown>;
    if (receipt.success === false || receipt.is_error === true) {
      const error = receipt.success === false ? receipt.error : receipt.content;
      return typeof error === "string" && cancelledBeforeDispatch.has(error) ? "Stopped" : "Error";
    }
  }
  return "Done";
}
