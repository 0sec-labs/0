// Credit nanos display for 0sec Cloud hosted inference.
//
// This module owns the pure formatting of server-authoritative CreditAccount
// data: nanos are formatted using BigInt/string operations only, and no
// balance is reconstructed, summed, or converted from supplier dollars.
//
// The CreditAccount type is defined locally until the Core package exports
// it. When @0sec/core provides CreditAccount, replace this block with:
//   import type { CreditAccount } from "@0sec/core";

// ---------------------------------------------------------------------------
// CreditAccount DTO — frozen schema, credits-v1

export type CreditNanos = string;
export type NullableCreditNanos = CreditNanos | null;

export interface CreditAccount {
  schemaVersion: "credits-v1";
  snapshotAt: string;
  policyVersion: string;
  scope: { orgId: string };
  state: "ready" | "disabled" | "unavailable" | "restricted";
  reason: string | null;
  free: {
    state: "unverified" | "ineligible" | "eligible_unclaimed" | "active" | "expired" | "revoked" | "unresolved";
    claimableCreditNanos: NullableCreditNanos;
    spendableCreditNanos: NullableCreditNanos;
    heldCreditNanos: NullableCreditNanos;
    resetAt: string | null;
  };
  subscription: {
    state: "none" | "active" | "inactive_verified" | "expired" | "revoked" | "unresolved";
    priceCents: 1500;
    periodStart: string | null;
    periodEnd: string | null;
    windows: Array<{
      kind: "monthly" | "weekly" | "five_hour";
      limitCreditNanos: NullableCreditNanos;
      settledCreditNanos: NullableCreditNanos;
      heldCreditNanos: NullableCreditNanos;
      availableCreditNanos: NullableCreditNanos;
      resetsAt: string;
    }>;
  };
  prepaid: {
    spendableCreditNanos: NullableCreditNanos;
    heldCreditNanos: NullableCreditNanos;
    settledDeficitCreditNanos: NullableCreditNanos;
    holdShortfallCreditNanos: NullableCreditNanos;
    consentEnabled: boolean;
  };
  purchase: {
    enabled: boolean;
    presets: Array<{ principalCents: number; creditNanos: CreditNanos }>;
    customMinCents: number;
    customMaxCents: number;
    stepCents: 100;
    currency: "usd";
  };
  admission: { eligible: boolean; reason: string | null };
}

// ---------------------------------------------------------------------------
// TUI lifecycle state (stable for chat-screen consumers)
// ---------------------------------------------------------------------------

export type HostedBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; display: string };

/**
 * Map a server CreditAccount (or null for unsupported/malformed HTTP200 data)
 * to a TUI lifecycle state. The chat-screen helper API and loading lifecycle
 * are stable: this function keeps its existing name and parameter shape.
 *
 * - null | undefined → unavailable (auth may still be valid, but credit data
 *   is unsupported, malformed, or legacy schema)
 * - state = disabled/unavailable/restricted → unavailable (authenticated but
 *   credits unavailable)
 * - state = ready → formatted primary credit source
 */
export function hostedBalanceState(
  account: CreditAccount | null | undefined,
): HostedBalanceState {
  if (!account) return { status: "unavailable" };
  if (account.state !== "ready") return { status: "unavailable" };

  // Pick the first meaningful balance source for the status bar.
  // Never sum across sources. The detail pane and `0sec balance` command
  // show the full breakdown.
  const free = account.free;
  if (
    free.state === "active" &&
    free.spendableCreditNanos !== null &&
    free.spendableCreditNanos !== "0"
  ) {
    return {
      status: "ready",
      display: `Free ${formatCreditNanosCompact(free.spendableCreditNanos)} nanos`,
    };
  }
  if (
    (free.state === "eligible_unclaimed" || free.state === "active") &&
    free.claimableCreditNanos !== null &&
    free.claimableCreditNanos !== "0"
  ) {
    return {
      status: "ready",
      display: `Free ${formatCreditNanosCompact(free.claimableCreditNanos)} nanos claimable`,
    };
  }

  const sub = account.subscription;
  if (sub.state === "active" && sub.windows.length > 0) {
    // Show the smallest window available as primary indication, since
    // that limit constrains admission.
    let minAvail: bigint | null = null;
    for (const w of sub.windows) {
      if (w.availableCreditNanos === null) continue;
      const a = BigInt(w.availableCreditNanos);
      if (minAvail === null || a < minAvail) minAvail = a;
    }
    if (minAvail !== null) {
      return {
        status: "ready",
        display: `Subscription ${formatCreditNanosCompact(minAvail.toString())} nanos available`,
      };
    }
  }

  const prepaid = account.prepaid;
  if (
    prepaid.spendableCreditNanos !== null &&
    prepaid.spendableCreditNanos !== "0"
  ) {
    return {
      status: "ready",
      display: `Prepaid ${formatCreditNanosCompact(prepaid.spendableCreditNanos)} nanos`,
    };
  }

  // All sources show zero or null. Still authenticated and known, so show
  // truthful zero rather than unavailable.
  return { status: "ready", display: "0 nanos" };
}

// ---------------------------------------------------------------------------
// Status-bar rendering
// ---------------------------------------------------------------------------

/**
 * Render only for the active Cloud provider, never a pending selection or BYOK.
 */
export function formatHostedBalance(state: HostedBalanceState): string {
  if (state.status === "loading") return "Cloud: Loading\u2026";
  if (state.status !== "ready") return "Cloud: Unavailable";
  return `Cloud: ${state.display}`;
}

// ---------------------------------------------------------------------------
// Nano formatting
// ---------------------------------------------------------------------------

/**
 * Format a nano-credit string with thousands separators, using BigInt for
 * exact precision. Returns null for absent or unparseable input.
 */
export function formatCreditNanos(
  nanos: NullableCreditNanos | undefined,
): string | null {
  if (nanos === null || nanos === undefined) return null;
  try {
    const n = BigInt(nanos);
    const abs = n < 0n ? -n : n;
    const s = abs.toString();
    if (s.length <= 3) return n < 0n ? `-${s}` : s;
    const parts: string[] = [];
    for (let i = s.length; i > 0; i -= 3) {
      parts.unshift(s.substring(Math.max(0, i - 3), i));
    }
    return `${n < 0n ? "-" : ""}${parts.join(",")}`;
  } catch {
    return null;
  }
}

/**
 * Compact nano-credit format with unit suffix for short display.
 * Uses BigInt throughout for exact precision.
 */
export function formatCreditNanosCompact(nanos: string): string {
  try {
    const raw = BigInt(nanos);
    if (raw === 0n) return "0";
    const n = raw < 0n ? -raw : raw;

    if (n < 1_000_000n) return n.toString();

    let unit: string;
    let divisor: bigint;
    if (n < 1_000_000_000_000n) {
      unit = "B";
      divisor = 1_000_000_000n;
    } else {
      unit = "T";
      divisor = 1_000_000_000_000n;
    }

    // Scale by 100 for two fractional digits, integer-divide for exactness.
    const scaled = (n * 100n) / divisor;
    const intPart = scaled / 100n;
    const fracPart = scaled % 100n;

    if (fracPart === 0n) return `${intPart}${unit}`;
    const fracStr = fracPart.toString().padStart(2, "0").replace(/0+$/, "");
    return `${intPart}.${fracStr}${unit}`;
  } catch {
    return nanos;
  }
}

/**
 * Human-readable breakdown of credit sources for the `0sec balance` command.
 * Each source shown distinctly; no summation across sources.
 */
export function formatBalanceDetail(account: CreditAccount | null): string {
  if (!account) return "  Credit data unavailable.\n";

  const lines: string[] = [];
  const add = (label: string, value: string) =>
    lines.push(`  ${label}: ${value}`);

  if (account.state !== "ready") {
    add("State", account.state);
    if (account.reason) add("Reason", account.reason);
    return lines.join("\n") + "\n";
  }

  // Free
  const free = account.free;
  add("Free state", free.state);
  add("  Claimable", formatCreditNanos(free.claimableCreditNanos) ?? "unavailable");
  add("  Spendable", formatCreditNanos(free.spendableCreditNanos) ?? "unavailable");
  add("  Held",      formatCreditNanos(free.heldCreditNanos) ?? "unavailable");
  if (free.resetAt) add("  Resets at", free.resetAt);

  // Subscription
  const sub = account.subscription;
  add("Subscription state", sub.state);
  if (sub.state === "active" && sub.windows.length > 0) {
    for (const w of sub.windows) {
      const avail = formatCreditNanos(w.availableCreditNanos) ?? "unavailable";
      add(`  Window (${w.kind})`, `${avail} nanos available`);
    }
  }

  // Prepaid
  add(
    "Prepaid spendable",
    formatCreditNanos(account.prepaid.spendableCreditNanos) ?? "unavailable",
  );
  if (
    account.prepaid.settledDeficitCreditNanos !== null &&
    account.prepaid.settledDeficitCreditNanos !== "0"
  ) {
    add("Prepaid deficit", account.prepaid.settledDeficitCreditNanos);
  }

  return lines.join("\n") + "\n";
}