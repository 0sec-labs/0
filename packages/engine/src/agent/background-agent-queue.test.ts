import { describe, expect, it, vi } from "vitest";
import { BackgroundAgentQueue } from "./background-agent-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("BackgroundAgentQueue", () => {
  it("bounds concurrency and dispatches waiting turns in FIFO order", async () => {
    const queue = new BackgroundAgentQueue(2);
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const runs = gates.map((gate, index) => queue.run(new AbortController().signal, async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      try { return await gate.promise; } finally { active--; }
    }));
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve(1);
    await runs[1];
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve(0);
    await runs[0];
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve(2);
    await runs[2];
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[3]!.resolve(3);
    gates[4]!.resolve(4);
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("rejects queued cancellation immediately and never dispatches the cancelled run", async () => {
    const queue = new BackgroundAgentQueue(1);
    const gate = deferred<void>();
    const first = queue.run(new AbortController().signal, () => gate.promise);
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => "cancelled");
    const cancelled = queue.run(controller.signal, cancelledTask);
    const reason = new Error("cancel queued turn");
    const rejection = expect(cancelled).rejects.toBe(reason);
    const nextTask = vi.fn(async () => "next");
    const next = queue.run(new AbortController().signal, nextTask);
    controller.abort(reason);
    await rejection;
    expect(nextTask).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    expect(await next).toBe("next");
    expect(cancelledTask).not.toHaveBeenCalled();
  });

  it("rejects an already aborted signal without starting its task", async () => {
    const queue = new BackgroundAgentQueue(1);
    const controller = new AbortController();
    controller.abort();
    const task = vi.fn(async () => 1);
    await expect(queue.run(controller.signal, task)).rejects.toBe(controller.signal.reason);
    expect(task).not.toHaveBeenCalled();
  });

  it("keeps an active cancelled run's slot until its cooperative task settles", async () => {
    const queue = new BackgroundAgentQueue(1);
    const controller = new AbortController();
    const gate = deferred<string>();
    const first = queue.run(controller.signal, () => gate.promise);
    const nextTask = vi.fn(async () => "next");
    const next = queue.run(new AbortController().signal, nextTask);
    controller.abort();
    await Promise.resolve();
    expect(nextTask).not.toHaveBeenCalled();
    gate.resolve("cooperatively finished");
    expect(await first).toBe("cooperatively finished");
    expect(await next).toBe("next");
  });

  it("releases failed runs and allows a completed agent to queue another turn", async () => {
    const queue = new BackgroundAgentQueue(1);
    const signal = new AbortController().signal;
    const gate = deferred<void>();
    const first = queue.run(signal, () => gate.promise);
    const error = new Error("failed turn");
    const failed = queue.run(signal, () => { throw error; });
    const rejected = expect(failed).rejects.toBe(error);
    const other = queue.run(signal, async () => "other agent");
    gate.resolve();
    await first;
    await rejected;
    expect(await other).toBe("other agent");
    expect(await queue.run(signal, async () => "revived turn")).toBe("revived turn");
  });

  it("releases the slot when an active task rejects asynchronously", async () => {
    const queue = new BackgroundAgentQueue(1);
    const gate = deferred<void>();
    const signal = new AbortController().signal;
    const failed = queue.run(signal, () => gate.promise);
    const error = new Error("asynchronous failure");
    const rejected = expect(failed).rejects.toBe(error);
    const next = queue.run(signal, async () => "continued");
    gate.reject(error);
    await rejected;
    expect(await next).toBe("continued");
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid concurrency %s", limit => {
    expect(() => new BackgroundAgentQueue(limit)).toThrow(RangeError);
  });
});
