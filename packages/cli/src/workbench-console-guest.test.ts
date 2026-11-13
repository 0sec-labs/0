import { expect, it } from "vitest";
import { WorkbenchGuestRequestQueue } from "./workbench-console-guest.js";

it("acknowledges autonomy while an active guest send waits for its host approval", async () => {
  const queue = new WorkbenchGuestRequestQueue();
  const approval = Promise.withResolvers<void>(), modeAck = Promise.withResolvers<void>();
  const events: string[] = [];
  queue.enqueue({ type: "request", op: "send", id: "send" }, async () => {
    events.push("approveTool"); await approval.promise; events.push("send-result");
  });
  queue.enqueue({ type: "request", op: "autonomy", id: "mode", value: "yolo" }, async () => {
    events.push("mode-applied"); events.push("mode-result"); modeAck.resolve();
  });
  queue.enqueue({ type: "request", op: "configure", id: "scope" }, async () => { events.push("scope-change"); });
  try {
    await modeAck.promise;
    expect(events).toEqual(["approveTool", "mode-applied", "mode-result"]);
    approval.resolve(); await queue.drain();
    expect(events).toEqual(["approveTool", "mode-applied", "mode-result", "send-result", "scope-change"]);
  } finally { approval.resolve(); await queue.drain(); }
});

it("serializes mode acknowledgements independently and drains both queues", async () => {
  const queue = new WorkbenchGuestRequestQueue(), first = Promise.withResolvers<void>();
  const events: string[] = [];
  queue.enqueue({ type: "request", op: "autonomy", value: "yolo" }, async () => { events.push("first-start"); await first.promise; events.push("first-ack"); });
  queue.enqueue({ type: "request", op: "autonomy", value: "standard" }, async () => { events.push("second-ack"); });
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(events).toEqual(["first-start"]); expect(drained).toBe(false);
  first.resolve(); await drain;
  expect(events).toEqual(["first-start", "first-ack", "second-ack"]); expect(drained).toBe(true);
});
