import { describe, expect, it } from "vitest";
import type { UsageAccount } from "@0sec/core";
import { formatHostedBalance, hostedBalanceState, formatBalanceDetail } from "./hosted-balance.js";

function account(): UsageAccount {
  return {
    schemaVersion: "usage-v2", snapshotAt: "2026-09-18T12:00:00.000Z",
    scope: { orgId: "fixture-org" }, state: "ready", reason: null,
    plan: { id: "pro", name: "Pro", monthlyPriceUsd: "39.00" },
    included: { state: "active", usedPercent: 25, resetsAt: "2026-10-18T12:00:00.000Z" },
    prepaid: { balanceUsd: "123456789.012345678", fallbackEnabled: false },
    canManageBilling: true,
    admission: { eligible: true, reason: null },
  };
}
const display = (value: UsageAccount | null) => formatHostedBalance(hostedBalanceState(value));

describe("usage presentation", () => {
  it("keeps missing usage and money distinct from zero", () => {
    const value = account();
    value.included = { state: "unavailable", usedPercent: null, resetsAt: null };
    value.prepaid.balanceUsd = null;
    expect(display(value)).not.toMatch(/\$0|\b0%/);
    value.included = { state: "active", usedPercent: 0, resetsAt: null };
    value.prepaid.balanceUsd = "0";
    expect(display(value)).toContain("0%");
    expect(display(value)).toContain("$0");
    expect(hostedBalanceState(null).status).toBe("unavailable");
  });

  it("does not hide exhausted allowance behind an unused prepaid balance", () => {
    const value = account();
    value.included = { ...value.included, state: "exhausted", usedPercent: 100 };
    value.admission = { eligible: false, reason: "prepaid_disabled" };
    const summary = display(value);
    expect(summary).toContain("100%");
    expect(summary).toContain("prepaid_disabled");
    expect(summary).toContain("$123456789.012345678");
    expect(formatBalanceDetail(value)).toContain(value.included.resetsAt);
  });

  it("surfaces restrictions rather than presenting balances as spendable", () => {
    const value = account();
    value.state = "restricted";
    value.reason = "billing_hold";
    value.admission = { eligible: false, reason: "billing_hold" };
    expect(display(value)).toContain("billing_hold");
    expect(display(value)).not.toContain("$123456789.012345678");
  });
});
