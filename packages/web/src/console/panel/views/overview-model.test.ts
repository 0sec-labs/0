import { describe, expect, it } from "vitest";
import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { formatCost, statusSummary } from "./overview-model";

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

describe("formatCost", () => {
  it("never shows real sub-cent spend as $0.00", () => {
    expect(formatCost(0.0008)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(undefined)).toBeUndefined();
  });
});
