import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAdmission, withWorkerAdmission, type WorkerOutcome } from "./worker-admission.js";

const request = { memoryMb: 128, cpus: 0.5, timeoutMs: 1000 };
const limits = { maxActive: 4, maxQueued: 8, memoryMb: 1024, cpus: 4 };
const ok = { timedOut: false };
const deferredPromise = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
};
function deferred<T>() { return deferredPromise.withResolvers<T>(); }
async function tick() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("worker admission", () => {
  it.each([
    { maxActive: 1 },
    { memoryMb: 192 },
    { cpus: 0.75 },
  ])("bounds aggregate reservations with %j", async (budget) => {
    const pool = new WorkerAdmission({ ...limits, ...budget, maxQueued: 1 });
    const release = deferred<WorkerOutcome>();
    const active = pool.run(request, undefined, () => release.promise);
    let starts = 0;
    const queued = pool.run(request, undefined, async () => { starts++; return ok; });
    await tick();
    expect(starts).toBe(0);
    await expect(pool.run(request, undefined, async () => ok)).rejects.toThrow(/queue full/);
    release.resolve(ok);
    await Promise.all([active, queued]);
    expect(starts).toBe(1);
  });

  it("rejects impossible requests without blocking a valid worker", async () => {
    const pool = new WorkerAdmission(limits);
    const execute = vi.fn(async () => ok);
    await expect(pool.run({ ...request, memoryMb: 2048 }, undefined, execute)).rejects.toThrow(/budget/);
    await expect(pool.run({ ...request, cpus: 8 }, undefined, execute)).rejects.toThrow(/budget/);
    expect(execute).not.toHaveBeenCalled();
    await pool.run(request, undefined, execute);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves FIFO and advances the queue when a blocking waiter cancels", async () => {
    const pool = new WorkerAdmission({ ...limits, memoryMb: 512 });
    const release = deferred<WorkerOutcome>();
    const active = pool.run({ ...request, memoryMb: 256 }, undefined, () => release.promise);
    const cancel = new AbortController();
    const blocked = pool.run({ ...request, memoryMb: 384 }, cancel.signal, async () => { throw new Error("must not start"); });
    const rejected = expect(blocked).rejects.toThrow("cancel queued");
    let smallerStarted = false;
    const smaller = pool.run(request, undefined, async () => { smallerStarted = true; return ok; });
    await tick();
    expect(smallerStarted).toBe(false);
    cancel.abort(new Error("cancel queued"));
    await rejected;
    await smaller;
    expect(smallerStarted).toBe(true);
    release.resolve(ok);
    await active;
  });

  it("expires queued work before the active worker releases its reservation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    const release = deferred<WorkerOutcome>();
    const active = pool.run(request, undefined, () => release.promise);
    const execute = vi.fn(async () => ok);
    const queued = pool.run({ ...request, timeoutMs: 20 }, undefined, execute);
    const rejected = expect(queued).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(execute).not.toHaveBeenCalled();
    release.resolve(ok);
    await active;
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["operator", "deadline"] as const)("keeps resources through %s cancellation and teardown", async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    const abort = new AbortController();
    const cleanup = deferred<WorkerOutcome>();
    let observedAbort = false;
    const active = pool.run({ ...request, timeoutMs: 20 }, abort.signal, async signal => {
      signal.addEventListener("abort", () => { observedAbort = true; }, { once: true });
      return cleanup.promise;
    });
    let nextStarted = false;
    const next = pool.run(request, undefined, async () => { nextStarted = true; return ok; });
    if (kind === "operator") abort.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(observedAbort).toBe(true);
    expect(nextStarted).toBe(false);
    cleanup.resolve(ok);
    expect((await active).timedOut).toBe(kind === "deadline");
    await next;
    expect(nextStarted).toBe(true);
  });

  it("gives execution only the time left after queueing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    const release = deferred<WorkerOutcome>();
    const active = pool.run(request, undefined, () => release.promise);
    let stopped = false;
    const next = pool.run({ ...request, timeoutMs: 100 }, undefined, signal => {
      const done = deferred<WorkerOutcome>();
      signal.addEventListener("abort", () => { stopped = true; done.resolve(ok); }, { once: true });
      return done.promise;
    });
    await vi.advanceTimersByTimeAsync(70);
    release.resolve(ok);
    await active;
    await vi.advanceTimersByTimeAsync(29);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await next).timedOut).toBe(true);
  });

  it("releases reservations on thrown execution failure", async () => {
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    await expect(pool.run(request, undefined, async () => { throw new Error("execution failed"); })).rejects.toThrow("execution failed");
    expect(await pool.run(request, undefined, async () => ({ ...ok, value: "next" }))).toMatchObject({ value: "next" });
  });

  it("stops queued and future workers after uncertain cleanup", async () => {
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    const release = deferred<WorkerOutcome>();
    const active = pool.run(request, undefined, () => release.promise);
    const execute = vi.fn(async () => ok);
    const queued = pool.run(request, undefined, execute);
    const rejected = expect(queued).rejects.toThrow(/unconfirmed cleanup/);
    release.resolve({ ...ok, cleanupFailed: true });
    await active;
    await rejected;
    await expect(pool.run(request, undefined, execute)).rejects.toThrow(/unconfirmed cleanup/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails a nested worker promptly on aggregate resource exhaustion", async () => {
    const pool = new WorkerAdmission({ ...limits, cpus: 0.75 });
    await pool.run(request, undefined, async signal => {
      await expect(pool.run(request, signal, async () => ok)).rejects.toThrow(/nested.*capacity/);
      return ok;
    });
  });

  it("admits a fitting child ahead of waiting roots without sharing the parent reservation", async () => {
    const pool = new WorkerAdmission({ ...limits, maxActive: 2 });
    const enterChild = deferred<void>();
    const order: string[] = [];
    const parent = pool.run(request, undefined, async signal => {
      await enterChild.promise;
      await pool.run(request, signal, async childSignal => {
        order.push("child");
        await expect(pool.run(request, childSignal, async () => ok)).rejects.toThrow(/nested.*capacity/);
        return ok;
      });
      return ok;
    });
    const root = pool.run({ ...request, memoryMb: 1024 }, undefined, async () => { order.push("root"); return ok; });
    enterChild.resolve();
    await Promise.all([parent, root]);
    expect(order).toEqual(["child", "root"]);
  });

  it("does not treat detached work as nested after its parent lease ends", async () => {
    const pool = new WorkerAdmission({ ...limits, maxActive: 1 });
    const trigger = deferred<void>();
    let detached!: Promise<WorkerOutcome>;
    await pool.run(request, undefined, async () => {
      detached = trigger.promise.then(() => pool.run(request, undefined, async () => ok));
      return ok;
    });
    const release = deferred<WorkerOutcome>();
    const holder = pool.run(request, undefined, () => release.promise);
    trigger.resolve();
    await tick();
    release.resolve(ok);
    await holder;
    await expect(detached).resolves.toEqual(ok);
  });

  it("cannot bypass invalid environment limits by retrying initialization", async () => {
    vi.stubEnv("0SEC_WORKER_MAX_ACTIVE", "NaN");
    const execute = vi.fn(async () => ok);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(async () => withWorkerAdmission(request, undefined, execute)).rejects.toThrow(/invalid worker/);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
