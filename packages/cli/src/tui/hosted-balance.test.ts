import { describe, expect, it } from "vitest";
import type { CreditAccount } from "@0/core";
import { formatHostedBalance, hostedBalanceState, formatCreditNanos, formatBalanceDetail } from "./hosted-balance.js";

function account(): CreditAccount {
  return {
    schemaVersion: "credits-v1", snapshotAt: "2026-09-18T12:00:00.000Z", policyVersion: "credits-v1",
    scope: { orgId: "fixture-org" }, state: "ready", reason: null,
    free: { state: "active", claimableCreditNanos: "7000000000", spendableCreditNanos: "90000000000", heldCreditNanos: "1000000000", resetAt: null },
    subscription: { state: "none", priceCents: 1500, periodStart: null, periodEnd: null, windows: [] },
    prepaid: { spendableCreditNanos: "0", heldCreditNanos: "0", settledDeficitCreditNanos: "0", holdShortfallCreditNanos: "0", consentEnabled: false },
    purchase: { enabled: false, presets: [], customMinCents: 1000, customMaxCents: 100000, stepCents: 100, currency: "usd" },
    admission: { eligible: true, reason: null },
  };
}
const display = (value: CreditAccount | null) => formatHostedBalance(hostedBalanceState(value));

describe("exact credit presentation", () => {
  it("preserves the smallest unit and amounts beyond Number precision", () => {
    expect(formatCreditNanos("1")).toBe("0.000000001");
    expect(formatCreditNanos("123456789012345678")).toBe("123456789.012345678");
    expect(formatCreditNanos("999999999999999999999999999999")).toBe("999999999999999999999.999999999");
    expect(formatCreditNanos("1000000000")).toBe("1");
    expect(formatCreditNanos("0")).toBe("0");
    expect(formatCreditNanos(null)).toBeNull();
  });

  it("keeps claimable credits distinct from spendable funds", () => {
    const value = account();
    value.free.state = "eligible_unclaimed";
    value.free.spendableCreditNanos = "0";
    value.admission = { eligible: false, reason: "claim_required" };
    const detail = formatBalanceDetail(value);
    expect(detail).toMatch(/Claimable: 7 credits/);
    expect(detail).toMatch(/Spendable: 0 credits/);
    expect(detail).toContain("claim_required");
    expect(display(value)).toContain("claimable 7 credits");
    expect(display(value)).toContain("free 0 credits");
  });

  it("keeps overlapping windows and their reset times separate", () => {
    const value = account();
    value.subscription.state = "active";
    value.subscription.windows = [
      { kind: "monthly", limitCreditNanos: "9000000000", settledCreditNanos: "2000000000", heldCreditNanos: "0", availableCreditNanos: "7000000000", resetsAt: "2026-10-01T00:00:00.000Z" },
      { kind: "weekly", limitCreditNanos: "6000000000", settledCreditNanos: "3000000000", heldCreditNanos: "0", availableCreditNanos: "3000000000", resetsAt: "2026-09-21T00:00:00.000Z" },
      { kind: "five_hour", limitCreditNanos: null, settledCreditNanos: null, heldCreditNanos: null, availableCreditNanos: null, resetsAt: "2026-09-18T17:00:00.000Z" },
    ];
    const summary = display(value);
    expect(summary).toContain("monthly 7 credits");
    expect(summary).toContain("weekly 3 credits");
    expect(summary).toContain("five_hour unavailable");
    expect(summary).not.toContain("10 credits");
    const detail = formatBalanceDetail(value);
    for (const window of value.subscription.windows) expect(detail).toContain(window.resetsAt);
    expect(detail).toContain("monthly available: 7 credits");
    expect(detail).toContain("weekly available: 3 credits");
  });

  it("does not turn unresolved amounts into zero", () => {
    const value = account();
    value.free = { state: "unresolved", claimableCreditNanos: null, spendableCreditNanos: null, heldCreditNanos: null, resetAt: null };
    value.prepaid = { spendableCreditNanos: null, heldCreditNanos: null, settledDeficitCreditNanos: null, holdShortfallCreditNanos: null, consentEnabled: false };
    const summary = display(value);
    expect(summary).toContain("unavailable");
    expect(summary).not.toMatch(/\b0 credits/);
    value.free.spendableCreditNanos = "0";
    expect(display(value)).toContain("free 0 credits");
    expect(hostedBalanceState(null).status).toBe("unavailable");
  });

  it("preserves service restrictions and debt independently from consent", () => {
    const value = account();
    value.state = "restricted";
    value.reason = "debt";
    value.prepaid = { spendableCreditNanos: "123456789012345678", heldCreditNanos: "2000000000", settledDeficitCreditNanos: "3000000000", holdShortfallCreditNanos: "4000000000", consentEnabled: true };
    value.admission = { eligible: false, reason: "debt" };
    expect(display(value)).toContain("restricted: debt");
    const detail = formatBalanceDetail(value);
    expect(detail).toContain("123456789.012345678 credits");
    expect(detail).toContain("settled deficit: 3 credits");
    expect(detail).toContain("hold shortfall: 4 credits");
    expect(detail).toContain("Admission: not eligible");
    expect(detail).toContain("consent: enabled");
  });
});
