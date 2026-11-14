import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { statusSummary } from "./overview-model";
import { autonomyModeLabel } from "../../autonomy-options";

const snapshot = (status: string, error?: string) => ({ session: { status }, pendingDecisions: [], lastOutcome: error ? { error } : null }) as unknown as ConsoleSessionSnapshot;

describe("statusSummary", () => {
  it("is Ready after a clean turn", () => {
    expect(statusSummary(snapshot("ready"))).toMatchObject({ label: "Ready", tone: "ok" });
  });
  it("says Needs attention in plain words when the last turn failed on a connection", () => {
    const summary = statusSummary(snapshot("ready", "DeepSeek API error: HTTP 401 unauthorized"));
    expect(summary.label).toBe("Needs attention");
    expect(summary.detail).toContain("connection needs attention");
    expect(summary.detail).not.toMatch(/401|HTTP/);
  });
  it("ignores cancellations", () => {
    expect(statusSummary(snapshot("ready", "Turn cancelled by operator")).label).toBe("Ready");
  });
});

describe("autonomyModeLabel", () => {
  it("uses the composer wording, never the internal mode name", () => {
    expect(autonomyModeLabel("yolo")).toBe("Act without asking");
    expect(autonomyModeLabel("standard")).toBe("Ask before acting");
    expect(autonomyModeLabel("copilot")).toBe("Ask before acting");
  });
});
