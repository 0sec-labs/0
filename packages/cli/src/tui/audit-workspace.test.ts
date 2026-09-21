import { describe, expect, it, vi } from "vitest";
import { AuditWorkspace, type AuditRecord } from "./audit-workspace.js";
import type { ConsoleSession } from "@0/core";

/** A record's runtime handle, as ChatScreen publishes it via buildSession. */
function bindRuntimeHandle(record: AuditRecord, applySelection: (sel: unknown) => void): void {
  record.runtimeInfo.current = {
    model: () => "current-model",
    providerId: () => "anthropic",
    applySelection: applySelection as never,
  };
}

describe("AuditWorkspace#applySelection", () => {
  it("does not live-apply when the audit has no live session yet", () => {
    const ws = new AuditWorkspace();
    const record = ws.records[0]!;
    const apply = vi.fn();
    // Even with a bound handle, a record with no session must not apply live:
    // the runtime is not owned yet, so the caller keeps its staging fallback.
    bindRuntimeHandle(record, apply);
    expect(record.session).toBeNull();
    expect(record.applySelection({ model: "gpt-5.6" })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns false when a live session exists but no runtime handle is bound", () => {
    const ws = new AuditWorkspace();
    const record = ws.records[0]!;
    record.session = { scanId: "s1" } as unknown as ConsoleSession;
    // runtimeInfo.current is still null (handle not published) → no live apply.
    expect(record.applySelection({ model: "gpt-5.6" })).toBe(false);
  });

  it("dispatches to the runtime handle and reports applied when a session is live", () => {
    const ws = new AuditWorkspace();
    const record = ws.records[0]!;
    const apply = vi.fn();
    record.session = { scanId: "s1" } as unknown as ConsoleSession;
    bindRuntimeHandle(record, apply);
    expect(record.applySelection({ model: "gpt-5.6", providerId: "openai" })).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ model: "gpt-5.6", providerId: "openai" });
  });

  it("never live-applies to a closing audit, even with a bound handle", () => {
    const ws = new AuditWorkspace();
    const record = ws.records[0]!;
    const apply = vi.fn();
    record.session = { scanId: "s1" } as unknown as ConsoleSession;
    record.closeRequested = true;
    bindRuntimeHandle(record, apply);
    expect(record.applySelection({ singleModel: true })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps staging (onNextOptions) independent of live apply", () => {
    const ws = new AuditWorkspace();
    const record = ws.records[0]!;
    // Staging still records the next-audit fallback whether or not a session exists.
    record.onNextOptions({ model: "kimi-k3", agentModels: { review: "gpt-5.6" } });
    expect(record.nextOptions.model).toBe("kimi-k3");
    expect(record.nextOptions.agentModels).toEqual({ review: "gpt-5.6" });
  });
});
