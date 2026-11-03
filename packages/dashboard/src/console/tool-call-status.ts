import type { ToolCallState } from "./transcript";

const cancelledBeforeDispatch = new Set([
  "Tool call cancelled before dispatch.",
  "Tool call cancelled by operator before dispatch.",
]);

/** Only structured engine receipts signal errors; arbitrary output remains output. */
export function toolCallStatus(call: ToolCallState): "Running" | "Done" | "Stopped" | "Error" {
  if (call.isRunning) return "Running";
  if (call.result === undefined) return "Stopped";
  let result: unknown = call.result;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof result === "string") {
      try { result = JSON.parse(result); } catch { break; }
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) break;
    const receipt = result as Record<string, unknown>;
    if (receipt.success === false || receipt.is_error === true) {
      const error = receipt.success === false ? receipt.error : receipt.content;
      return typeof error === "string" && cancelledBeforeDispatch.has(error) ? "Stopped" : "Error";
    }
    if (receipt.success === true && Object.hasOwn(receipt, "output")) result = receipt.output;
    else if (receipt.is_error === false && Object.hasOwn(receipt, "content")) result = receipt.content;
    else break;
  }
  return "Done";
}
