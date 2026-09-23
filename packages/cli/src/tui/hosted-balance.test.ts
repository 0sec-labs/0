import { describe, expect, it } from "vitest";
import type { CreditAccount } from "@0/core";
import { formatHostedBalance, hostedBalanceState, formatBalanceDetail } from "./hosted-balance.js";

function account(): CreditAccount {
  return {
    schemaVersion: "usage-v2",
    snapshotAt: "2026-09-18T12:00:00.000Z",
    scope: { orgId: "fixture-org" },
    state: "ready",
    reason: null,
    plan: { id: "pro", name: "Pro", monthlyPriceUsd: "39.00" },
    included: { state: "active", usedPercent: 45.5, resetsAt: "2026-10-01T00:00:00.000Z" },
    prepaid: { balanceUsd: "123.45", fallbackEnabled: true },
    canManageBilling: true,
    admission: { eligible: true, reason: null },
  };
}
const display = (value: CreditAccount | null) => formatHostedBalance(hostedBalanceState(value));

describe("usage presentation", () => {
  it("preserves prepaid decimals beyond floating-point precision", () => {
    const value = account();
    value.prepaid.balanceUsd = "123456789012345678.000000001";
    expect(display(value)).toContain("$123456789012345678.000000001");
    expect(formatBalanceDetail(value)).toContain("$123456789012345678.000000001");
  });

  it("shows included allowance percent and reset date", () => {
    const value = account();
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("45.5% used");
    expect(detail).toContain(value.included.resetsAt);
    expect(display(value)).toContain("45.5% used");
    expect(display(value)).toContain("2026-10-01");
  });

  it("hides a funded prepaid balance until fallback is enabled", () => {
    const value = account();
    value.prepaid.fallbackEnabled = false;
    for (const text of [display(value), formatBalanceDetail(value)]) {
      expect(text).toContain("45.5% used");
      expect(text).not.toMatch(/prepaid|\$123\.45/i);
    }
    value.prepaid.fallbackEnabled = true;
    for (const text of [display(value), formatBalanceDetail(value)]) {
      expect(text).toContain("45.5% used");
      expect(text).toContain("$123.45");
    }
    value.prepaid.balanceUsd = "0.00";
    expect(display(value)).toContain("$0.00");
    expect(formatBalanceDetail(value)).toContain("$0.00");
  });

  it("reports unavailable prepaid balance as unavailable", () => {
    const value = account();
    value.prepaid.balanceUsd = null;
    expect(display(value)).toContain("prepaid unavailable");
  });

  it("preserves service restriction display separately from admission", () => {
    const value = account();
    value.state = "restricted";
    value.reason = "debt";
    value.admission = { eligible: false, reason: "debt" };
    value.prepaid = { balanceUsd: "50.00", fallbackEnabled: true };
    value.included = { state: "exhausted", usedPercent: 100, resetsAt: "2026-10-01T00:00:00.000Z" };
    expect(display(value)).toContain("restricted: debt");
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("Prepaid balance: $50.00");
    expect(detail).toContain("debt");
  });

  it("does not fabricate included data when unavailable", () => {
    const value = account();
    value.included = { state: "unavailable", usedPercent: null, resetsAt: null };
    const summary = display(value);
    expect(summary).toContain("unavailable");
    expect(summary).not.toMatch(/\d+%/);
    expect(summary).not.toContain("resets");
  });

  it("distinguishes missing included allowance from an unreadable account", () => {
    const value = account();
    value.included = { state: "none", usedPercent: null, resetsAt: null };
    value.prepaid = { balanceUsd: "0", fallbackEnabled: false };
    value.admission = { eligible: false, reason: "prepaid_disabled" };
    for (const text of [display(value), formatBalanceDetail(value)]) {
      expect(text).toContain("no included allowance");
      expect(text).not.toContain("unavailable");
      expect(text).not.toMatch(/\d+%|\$|resets/i);
    }
  });

  it("returns unavailable for null account", () => {
    expect(hostedBalanceState(null).status).toBe("unavailable");
    expect(display(null)).toContain("unavailable");
  });
});