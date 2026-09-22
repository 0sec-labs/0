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

describe("exact credit presentation", () => {
  it("preserves prepaid decimals beyond floating-point precision", () => {
    const value = account();
    value.prepaid.balanceUsd = "123456789012345678.000000001";
    expect(display(value)).toContain("$123456789012345678.000000001");
    expect(formatBalanceDetail(value)).toContain("$123456789012345678.000000001");
  });

  it("shows included allowance percent and reset date", () => {
    const value = account();
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("Included state: active");
    expect(detail).toContain("Used: 45.5%");
    expect(detail).toContain("Resets at: 2026-10-01");
    expect(display(value)).toContain("included active (45.5% used");
  });

  it("shows prepaid USD with fallback indicator", () => {
    const value = account();
    expect(display(value)).toContain("prepaid $123.45 (fallback)");
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("Prepaid balance: $123.45");
    expect(detail).toContain("Prepaid fallback: enabled");

    // Without fallback
    value.prepaid.fallbackEnabled = false;
    expect(display(value)).toContain("prepaid $123.45");
    expect(display(value)).not.toContain("(fallback)");
    expect(formatBalanceDetail(value)).toContain("Prepaid fallback: disabled");
  });

  it("reports unavailable prepaid balance as unavailable", () => {
    const value = account();
    value.prepaid.balanceUsd = null;
    expect(display(value)).toContain("prepaid unavailable");
  });

  it("shows admission eligibility and reason", () => {
    const value = account();
    value.admission = { eligible: false, reason: "prepaid_disabled" };
    const summary = display(value);
    expect(summary).toContain("not eligible: prepaid_disabled");
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("Admission: not eligible");
    expect(detail).toContain("Admission reason: prepaid_disabled");
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
    expect(detail).toContain("Admission: not eligible");
    expect(detail).toContain("Admission reason: debt");
  });

  it("does not fabricate included data when unavailable", () => {
    const value = account();
    value.included = { state: "unavailable", usedPercent: null, resetsAt: null };
    const summary = display(value);
    expect(summary).toContain("included: unavailable");
    expect(summary).not.toContain("resets");
  });

  it("shows plan info in detail", () => {
    const detail = formatBalanceDetail(account());
    expect(detail).toContain("Plan: Pro");
    expect(detail).toContain("Price: $39.00");

    const noPlan = account();
    noPlan.plan = { id: null, name: null, monthlyPriceUsd: null };
    expect(formatBalanceDetail(noPlan)).toContain("Plan: none");
  });

  it("returns unavailable for null account", () => {
    expect(hostedBalanceState(null).status).toBe("unavailable");
    expect(display(null)).toContain("unavailable");
  });
});