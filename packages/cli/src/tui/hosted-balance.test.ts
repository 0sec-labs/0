import { describe, expect, it } from "vitest";
import {
  formatHostedBalance,
  hostedBalanceState,
  formatCreditNanos,
  formatCreditNanosCompact,
  formatBalanceDetail,
  type CreditAccount,
} from "./hosted-balance.js";

// ── Fixtures (synthetic, matching frozen CreditAccount contract) ──

function freeActive(overrides?: Partial<CreditAccount["free"]>): CreditAccount["free"] {
  return {
    state: "active",
    claimableCreditNanos: "0",
    spendableCreditNanos: "90000000000",
    heldCreditNanos: "10000000000",
    resetAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function noSubscription(): CreditAccount["subscription"] {
  return {
    state: "none",
    priceCents: 1500 as const,
    periodStart: null,
    periodEnd: null,
    windows: [],
  };
}

function noPrepaid(): CreditAccount["prepaid"] {
  return {
    spendableCreditNanos: "0",
    heldCreditNanos: "0",
    settledDeficitCreditNanos: "0",
    holdShortfallCreditNanos: "0",
    consentEnabled: false,
  };
}

function readyAccount(overrides?: Partial<CreditAccount>): CreditAccount {
  return {
    schemaVersion: "credits-v1",
    snapshotAt: "2026-09-18T12:00:00.000Z",
    policyVersion: "credits-v1",
    scope: { orgId: "test-org" },
    state: "ready",
    reason: null,
    free: freeActive(),
    subscription: noSubscription(),
    prepaid: noPrepaid(),
    purchase: {
      enabled: true,
      presets: [
        { principalCents: 1000, creditNanos: "1000000000000" },
      ],
      customMinCents: 1000,
      customMaxCents: 100000,
      stepCents: 100 as const,
      currency: "usd" as const,
    },
    admission: { eligible: true, reason: null },
    ...overrides,
  };
}

const display = (value: CreditAccount | null | undefined) =>
  formatHostedBalance(hostedBalanceState(value));

// ── hostedBalanceState / formatHostedBalance ──

describe("hosted balance presentation", () => {
  it("distinguishes pending data from unavailable data and zero credit", () => {
    expect(formatHostedBalance({ status: "loading" })).toBe("Cloud: Loading\u2026");
    expect(display(null)).toBe("Cloud: Unavailable");
    expect(display(undefined)).toBe("Cloud: Unavailable");
    expect(display(readyAccount())).toBe("Cloud: Free 90B nanos");
  });

  it("shows free credits when free is active", () => {
    const acct = readyAccount();
    expect(display(acct)).toBe("Cloud: Free 90B nanos");
  });

  it("shows free claimable when eligible_unclaimed", () => {
    const acct = readyAccount({
      free: {
        state: "eligible_unclaimed",
        claimableCreditNanos: "50000000000",
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        resetAt: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(display(acct)).toBe("Cloud: Free 50B nanos claimable");
  });

  it("shows subscription window when subscription is active", () => {
    const acct = readyAccount({
      free: {
        state: "ineligible",
        claimableCreditNanos: "0",
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        resetAt: "2026-10-01T00:00:00.000Z",
      },
      subscription: {
        state: "active",
        priceCents: 1500 as const,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        windows: [
          {
            kind: "monthly",
            limitCreditNanos: "2000000000000",
            settledCreditNanos: "100000000000",
            heldCreditNanos: "50000000000",
            availableCreditNanos: "1850000000000",
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
          {
            kind: "weekly",
            limitCreditNanos: "1000000000000",
            settledCreditNanos: "100000000000",
            heldCreditNanos: "50000000000",
            availableCreditNanos: "850000000000",
            resetsAt: "2026-09-21T00:00:00.000Z",
          },
        ],
      },
    });
    // Shows the most constrained (smallest available) window
    expect(display(acct)).toBe("Cloud: Subscription 850B nanos available");
  });

  it("shows prepaid when no free or subscription balance", () => {
    const acct = readyAccount({
      free: {
        state: "ineligible",
        claimableCreditNanos: "0",
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        resetAt: "2026-10-01T00:00:00.000Z",
      },
      prepaid: {
        spendableCreditNanos: "50000000000000",
        heldCreditNanos: "0",
        settledDeficitCreditNanos: "0",
        holdShortfallCreditNanos: "0",
        consentEnabled: true,
      },
    });
    expect(display(acct)).toBe("Cloud: Prepaid 50T nanos");
  });

  it("shows truthful zero when all sources are zero", () => {
    const acct = readyAccount({
      free: {
        state: "expired",
        claimableCreditNanos: "0",
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        resetAt: null,
      },
      subscription: {
        state: "none",
        priceCents: 1500 as const,
        periodStart: null,
        periodEnd: null,
        windows: [],
      },
      prepaid: {
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        settledDeficitCreditNanos: "0",
        holdShortfallCreditNanos: "0",
        consentEnabled: false,
      },
    });
    expect(display(acct)).toBe("Cloud: 0 nanos");
  });

  it("keeps unavailable on disabled/unavailable/restricted state", () => {
    expect(display(readyAccount({ state: "disabled", reason: "policy_disabled" }))).toBe("Cloud: Unavailable");
    expect(display(readyAccount({ state: "unavailable", reason: "ledger_unavailable" }))).toBe("Cloud: Unavailable");
    expect(display(readyAccount({ state: "restricted", reason: "debt" }))).toBe("Cloud: Unavailable");
  });

  it("keeps unavailable for null (unsupported/malformed) accounts", () => {
    expect(display(null)).toBe("Cloud: Unavailable");
    expect(display(undefined)).toBe("Cloud: Unavailable");
  });
});

// ── formatCreditNanos ──

describe("formatCreditNanos", () => {
  it("formats small numbers exactly", () => {
    expect(formatCreditNanos("0")).toBe("0");
    expect(formatCreditNanos("1")).toBe("1");
    expect(formatCreditNanos("999")).toBe("999");
  });

  it("inserts thousands separators", () => {
    expect(formatCreditNanos("1000")).toBe("1,000");
    expect(formatCreditNanos("1000000")).toBe("1,000,000");
    expect(formatCreditNanos("90000000000")).toBe("90,000,000,000");
    expect(formatCreditNanos("123456789012345678")).toBe("123,456,789,012,345,678");
  });

  it("returns null for null or undefined", () => {
    expect(formatCreditNanos(null)).toBeNull();
    expect(formatCreditNanos(undefined)).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(formatCreditNanos("not-a-number")).toBeNull();
  });
});

// ── formatCreditNanosCompact ──

describe("formatCreditNanosCompact", () => {
  it("shows small values exactly", () => {
    expect(formatCreditNanosCompact("0")).toBe("0");
    expect(formatCreditNanosCompact("1")).toBe("1");
    expect(formatCreditNanosCompact("999999")).toBe("999999");
  });

  it("shows billions with B suffix", () => {
    expect(formatCreditNanosCompact("1000000000")).toBe("1B");
    expect(formatCreditNanosCompact("1500000000")).toBe("1.5B");
    expect(formatCreditNanosCompact("90000000000")).toBe("90B");
    expect(formatCreditNanosCompact("999999999999")).toBe("999.99B");
  });

  it("shows trillions with T suffix", () => {
    expect(formatCreditNanosCompact("1000000000000")).toBe("1T");
    expect(formatCreditNanosCompact("1500000000000")).toBe("1.5T");
    expect(formatCreditNanosCompact("50000000000000")).toBe("50T");
  });
});

// ── formatBalanceDetail ──

describe("formatBalanceDetail", () => {
  it("shows unavailable for null account", () => {
    expect(formatBalanceDetail(null)).toContain("Credit data unavailable");
  });

  it("shows state and reason when not ready", () => {
    const out = formatBalanceDetail(readyAccount({ state: "disabled", reason: "policy_disabled" }));
    expect(out).toContain("disabled");
    expect(out).toContain("policy_disabled");
  });

  it("shows free detail when ready", () => {
    const acct = readyAccount();
    const out = formatBalanceDetail(acct);
    expect(out).toContain("Free state");
    expect(out).toContain("active");
    expect(out).toContain("90,000,000,000");
  });

  it("shows subscription windows when active", () => {
    const acct = readyAccount({
      free: {
        state: "ineligible",
        claimableCreditNanos: "0",
        spendableCreditNanos: "0",
        heldCreditNanos: "0",
        resetAt: "2026-10-01T00:00:00.000Z",
      },
      subscription: {
        state: "active",
        priceCents: 1500 as const,
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        windows: [
          {
            kind: "monthly",
            limitCreditNanos: "2000000000000",
            settledCreditNanos: "100000000000",
            heldCreditNanos: "50000000000",
            availableCreditNanos: "1850000000000",
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      },
    });
    const out = formatBalanceDetail(acct);
    expect(out).toContain("Subscription state");
    expect(out).toContain("Window (monthly)");
    expect(out).toContain("1,850,000,000,000");
  });

  it("shows prepaid spendable", () => {
    const acct = readyAccount({
      prepaid: {
        spendableCreditNanos: "50000000000000",
        heldCreditNanos: "0",
        settledDeficitCreditNanos: "0",
        holdShortfallCreditNanos: "0",
        consentEnabled: true,
      },
    });
    const out = formatBalanceDetail(acct);
    expect(out).toContain("50,000,000,000,000");
  });

  it("shows prepaid deficit when non-zero", () => {
    const acct = readyAccount({
      prepaid: {
        spendableCreditNanos: "50000000000000",
        heldCreditNanos: "0",
        settledDeficitCreditNanos: "1000000000",
        holdShortfallCreditNanos: "0",
        consentEnabled: true,
      },
    });
    const out = formatBalanceDetail(acct);
    expect(out).toContain("Prepaid deficit");
    expect(out).toContain("1000000000");
  });

  it("never reconstructs a percentage or supplier cost", () => {
    const acct = readyAccount();
    const out = formatBalanceDetail(acct);
    expect(out).not.toContain("percent");
    expect(out).not.toContain("USD");
    expect(out).not.toContain("supplier");
    expect(out).not.toContain("remainingPercent");
  });
});