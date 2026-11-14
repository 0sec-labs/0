import { afterEach, expect, test, vi } from "vitest";
import { documentVisible, pollInterval, startVisibleInterval } from "../src/lib/polling.js";
import { queryKeys } from "../src/queries.js";
import { makeQueryClient } from "../src/lib/query-client.js";

function fakeDocument(state: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    set(next: "visible" | "hidden") { this.visibilityState = next; listeners.forEach(fn => fn()); },
    listeners,
  };
}
afterEach(() => vi.useRealTimers());

test("pollInterval is fast while active and slow or off when idle", () => {
  expect(pollInterval(true, 3000, 20_000)).toBe(3000);
  expect(pollInterval(false, 3000, 20_000)).toBe(20_000);
  expect(pollInterval(false, 3000)).toBe(false);
});
test("documentVisible treats a missing document as visible", () => {
  expect(documentVisible(undefined)).toBe(true);
  expect(documentVisible({ visibilityState: "hidden" })).toBe(false);
  expect(documentVisible({ visibilityState: "visible" })).toBe(true);
});
test("startVisibleInterval ticks only while visible and catches up when the tab returns", () => {
  vi.useFakeTimers();
  const doc = fakeDocument("visible");
  const callback = vi.fn();
  const stop = startVisibleInterval(callback, 1000, doc as never, { setInterval: (f, ms) => setInterval(f, ms) as never, clearInterval: id => clearInterval(id) }, () => Date.now());
  vi.advanceTimersByTime(2000);
  expect(callback).toHaveBeenCalledTimes(2);
  doc.set("hidden");
  vi.advanceTimersByTime(5000);
  expect(callback).toHaveBeenCalledTimes(2);
  doc.set("visible");
  expect(callback).toHaveBeenCalledTimes(3);
  stop();
  vi.advanceTimersByTime(5000);
  expect(callback).toHaveBeenCalledTimes(3);
  expect(doc.listeners.size).toBe(0);
});
test("becoming visible again does not refetch when the last tick was recent", () => {
  vi.useFakeTimers();
  const doc = fakeDocument("visible");
  const callback = vi.fn();
  startVisibleInterval(callback, 1000, doc as never, { setInterval: (f, ms) => setInterval(f, ms) as never, clearInterval: id => clearInterval(id) }, () => Date.now());
  vi.advanceTimersByTime(1000);
  doc.set("hidden"); doc.set("visible");
  expect(callback).toHaveBeenCalledTimes(1);
});
test("query keys keep the historical array shapes and prefix relationships", () => {
  expect(queryKeys.consoleSessions()).toEqual(["console-sessions"]);
  expect(queryKeys.runs("b1")).toEqual(["runs", "b1"]);
  expect(queryKeys.skills("b", "w", "u")).toEqual(["skills", "b", "w", "u"]);
  const client = makeQueryClient();
  client.setQueryData(queryKeys.findingFamily("b", "fp"), 1);
  expect(client.getQueryCache().findAll({ queryKey: queryKeys.findingFamily() })).toHaveLength(1);
});
