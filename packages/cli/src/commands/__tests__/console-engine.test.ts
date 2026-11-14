import { afterEach, describe, expect, it, vi } from "vitest";
import { runAttachedConsole } from "../console.js";

const previousExitCode = process.exitCode;
afterEach(() => { process.exitCode = previousExitCode; });
function fixture() {
  const initial = { session: { id: "live-1", status: "ready" }, cursor: 7, pendingDecisions: [], lastOutcome: null };
  const outcome = { assistantText: "Found the evidence.", stopReason: "end_turn" };
  const events = [{ type: "assistant-delta", text: "Found the evidence.", sequence: 8 }, { type: "turn-complete", ...outcome, sequence: 9 }];
  const runtime = {
    attachSession: vi.fn(async () => initial),
    sendMessage: vi.fn(async () => ({ id: "live-1", status: "working" })),
    getSessionEvents: vi.fn(async () => ({ events, cursor: 9, gap: false })),
    getSession: vi.fn(async () => ({ ...initial, lastOutcome: outcome })),
    dispose: vi.fn(async () => {}),
  };
  const chunks: string[] = [];
  const deps = { runtime: vi.fn(async () => runtime), write: (text: string) => chunks.push(text), sleep: vi.fn(async () => {}) };
  return { runtime, deps, chunks };
}
describe("console engine attachment", () => {
  it("requires the canonical print prompt before creating a transport", async () => {
    const { deps } = fixture();
    await expect(runAttachedConsole({ session: "live-1" }, " ", deps)).rejects.toThrow("Supply --print with a nonempty prompt.");
    expect(deps.runtime).not.toHaveBeenCalled();
  });
  it("uses the resolved live identity and cursor, returns clean JSON, and detaches", async () => {
    const { runtime, deps, chunks } = fixture();
    await runAttachedConsole({ session: "saved-reference", backend: "staging", format: "json" }, "Inspect it", deps);
    expect(runtime.attachSession).toHaveBeenCalledWith("saved-reference");
    expect(runtime.sendMessage).toHaveBeenCalledWith("live-1", "Inspect it");
    expect(runtime.getSessionEvents).toHaveBeenCalledWith("live-1", 7);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0])).toMatchObject({ sessionId: "live-1", outcome: { assistantText: "Found the evidence." } });
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
  it("streams engine events as NDJSON followed by the result", async () => {
    const { deps, chunks } = fixture();
    await runAttachedConsole({ session: "live-1", format: "ndjson" }, "Inspect it", deps);
    expect(chunks.map(chunk => JSON.parse(chunk).type)).toEqual(["assistant-delta", "turn-complete", "result"]);
  });
  it("rejects local reconfiguration before creating a transport", async () => {
    const { deps } = fixture();
    await expect(runAttachedConsole({ session: "live-1", model: "other" }, "Inspect", deps)).rejects.toThrow("chat's configuration");
    expect(deps.runtime).not.toHaveBeenCalled();
  });
  it("refuses busy sessions without sending and detaches", async () => {
    const { runtime, deps } = fixture();
    runtime.attachSession.mockResolvedValueOnce({ session: { id: "live-1", status: "working" }, cursor: 7, pendingDecisions: [], lastOutcome: null });
    await expect(runAttachedConsole({ session: "live-1" }, "Inspect", deps)).rejects.toThrow("not ready");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
  it("reports pending decisions without automatically approving or cancelling", async () => {
    const { runtime, deps, chunks } = fixture();
    runtime.getSession.mockResolvedValue({ session: { id: "live-1", status: "waiting" }, cursor: 7, pendingDecisions: [{ id: "approval-1" }] as never[], lastOutcome: null as never });
    await runAttachedConsole({ session: "live-1", format: "json" }, "Inspect", deps);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(chunks[0]).pendingDecisions).toEqual([{ id: "approval-1" }]);
  });
  it("fails on lost events and detaches without resending", async () => {
    const { runtime, deps } = fixture();
    runtime.getSessionEvents.mockResolvedValueOnce({ events: [], cursor: 30, gap: true });
    await expect(runAttachedConsole({ session: "live-1" }, "Inspect", deps)).rejects.toThrow("gap");
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
