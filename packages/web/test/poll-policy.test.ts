import { expect, test } from "vitest";
import { pollDelay, shouldResyncSnapshot, snapshotActive } from "../src/console/use-console-workspace.js";

const snap = (status: string, extra: Record<string, unknown> = {}) => ({ session: { status }, queuedMessages: [], workers: [], ...extra }) as never;
test("running turns keep 350ms polling; idle backs off to 1s; recovery stays 1.5s", () => {
  expect(pollDelay({ recovering: false, active: true })).toBe(350);
  expect(pollDelay({ recovering: false, active: false })).toBe(1000);
  expect(pollDelay({ recovering: true, active: true })).toBe(1500);
});
test("activity covers turns, workers and queued messages", () => {
  expect(snapshotActive(snap("ready"))).toBe(false);
  expect(snapshotActive(snap("working"))).toBe(true);
  expect(snapshotActive(snap("ready", { workers: [{ status: "running" }] }))).toBe(true);
  expect(snapshotActive(snap("ready", { queuedMessages: [{}] }))).toBe(true);
  expect(snapshotActive(null)).toBe(true);
});
test("the periodic full resync is skipped only while idle with an unchanged cursor", () => {
  const base = { missing: false, invalidated: false, age: 20_000, active: false, cursorMoved: false };
  expect(shouldResyncSnapshot(base)).toBe(false);
  expect(shouldResyncSnapshot({ ...base, cursorMoved: true })).toBe(true);
  expect(shouldResyncSnapshot({ ...base, active: true })).toBe(true);
  expect(shouldResyncSnapshot({ ...base, age: 5000, active: true, cursorMoved: true })).toBe(false);
  expect(shouldResyncSnapshot({ ...base, missing: true, age: 0 })).toBe(true);
  expect(shouldResyncSnapshot({ ...base, invalidated: true, age: 0 })).toBe(true);
});

import { findingSignal } from "../src/console/use-console-workspace.js";
test("off-screen docked chats never poll faster than 5s", () => {
  expect(pollDelay({ recovering: false, active: true, visible: false })).toBe(5000);
  expect(pollDelay({ recovering: true, active: true, visible: false })).toBe(5000);
  expect(pollDelay({ recovering: false, active: true, visible: true })).toBe(350);
});
test("finished turns and finding tool results signal a dashboard refresh", () => {
  expect(findingSignal({ type: "turn-complete" } as never)).toBe(true);
  expect(findingSignal({ type: "tool-result", call: { name: "record_finding" } } as never)).toBe(true);
  expect(findingSignal({ type: "tool-result", call: { name: "read_file" } } as never)).toBe(false);
  expect(findingSignal({ type: "assistant-delta", text: "x" } as never)).toBe(false);
});
