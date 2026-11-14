import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestMissionStart, resetMissionStartForTest, runMissionStart, takeMissionStart } from "./mission-start";

beforeEach(() => resetMissionStartForTest());

describe("mission start", () => {
  it("accepts one queued request until it is taken", () => {
    expect(requestMissionStart("go")).toBe(true);
    expect(requestMissionStart("go")).toBe(false);
    expect(takeMissionStart()).toBe("go");
    expect(takeMissionStart()).toBeNull();
    expect(requestMissionStart("  ")).toBe(false);
  });
  it("sends once while in flight", async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(r => { resolve = r; }));
    const fallback = vi.fn();
    const first = runMissionStart("go", send, fallback);
    expect(await runMissionStart("go", send, fallback)).toBe(false);
    expect(requestMissionStart("go")).toBe(false);
    resolve(true);
    expect(await first).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("falls back to the composer when sending fails or throws", async () => {
    const fallback = vi.fn();
    expect(await runMissionStart("a", async () => false, fallback)).toBe(false);
    expect(await runMissionStart("b", async () => { throw new Error("no runtime"); }, fallback)).toBe(false);
    expect(fallback.mock.calls).toEqual([["a"], ["b"]]);
    expect(requestMissionStart("c")).toBe(true);
  });
});
