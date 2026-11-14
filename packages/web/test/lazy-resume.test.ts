import { expect, test } from "vitest";
import { findLiveForSaved, resumeSavedOnce } from "../src/lib/lazy-resume.js";

const live = (id: string, savedId: string | undefined, updatedAt: string, status = "ready") => ({ id, savedId, updatedAt, createdAt: updatedAt, status }) as never;
test("reuses the newest open live session for a saved mission", () => {
  const roster = [live("a", "s1", "2026-01-01T00:00:00Z"), live("b", "s1", "2026-02-01T00:00:00Z"), live("c", "s1", "2026-03-01T00:00:00Z", "closed")];
  expect(findLiveForSaved(roster, "s1")?.id).toBe("b");
  expect(findLiveForSaved(roster, "other")).toBeUndefined();
  expect(findLiveForSaved(undefined, "s1")).toBeUndefined();
});
test("repeated opens share one resume request and skip it once a live session exists", async () => {
  let calls = 0;
  const resume = async () => { calls++; await Promise.resolve(); return live("x", "s9", "2026-01-01T00:00:00Z"); };
  const [first, second] = await Promise.all([resumeSavedOnce({ backendId: "local", savedId: "s9", resume }), resumeSavedOnce({ backendId: "local", savedId: "s9", resume })]);
  expect(calls).toBe(1); expect(first).toBe(second);
  const reused = await resumeSavedOnce({ backendId: "local", savedId: "s9", roster: [first], resume });
  expect(calls).toBe(1); expect(reused.id).toBe("x");
  await resumeSavedOnce({ backendId: "other", savedId: "s9", resume });
  expect(calls).toBe(2);
});
