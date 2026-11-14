import { expect, test } from "vitest";
import { bustSharedReads, sharedRead } from "../src/lib/shared-read.js";

test("joins in-flight and recent reads, refetches after the window, a mutation bust, or a failure", async () => {
  bustSharedReads();
  let calls = 0, clock = 0;
  const load = async () => ++calls;
  const read = (signal?: AbortSignal) => sharedRead("k", 1000, load, signal, () => clock);
  expect(await Promise.all([read(), read()])).toEqual([1, 1]);
  clock = 500; expect(await read()).toBe(1);
  clock = 1500; expect(await read()).toBe(2);
  bustSharedReads(); expect(await read()).toBe(3);
  let failing = 0;
  await expect(sharedRead("f", 1000, async () => { failing++; throw new Error("x"); }, undefined, () => clock)).rejects.toThrow("x");
  await expect(sharedRead("f", 1000, async () => ++failing, undefined, () => clock)).resolves.toBe(2);
});

test("one caller aborting never fails the others", async () => {
  bustSharedReads();
  const gate = Promise.withResolvers<number>();
  const controller = new AbortController();
  const first = sharedRead("a", 1000, () => gate.promise, controller.signal);
  const second = sharedRead("a", 1000, () => gate.promise);
  controller.abort();
  await expect(first).rejects.toBeDefined();
  gate.resolve(7);
  await expect(second).resolves.toBe(7);
});
