import type { CreditAccount } from "@0sec/core";

/** Loading belongs to the active chat identity; credit readiness belongs to the DTO. */
export type HostedBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; display: string };

/** Format nanocredits as exact credits (1 credit = 10^9 nanos), without Number. */
export function formatCreditNanos(nanos: string | null | undefined): string | null {
  if (typeof nanos !== "string" || !/^(0|[1-9]\d{0,29})$/.test(nanos)) return null;
  const digits = nanos.padStart(10, "0");
  const whole = digits.slice(0, -9);
  const fraction = digits.slice(-9).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function credits(nanos: string | null): string {
  const value = formatCreditNanos(nanos);
  return value === null ? "unavailable" : `${value} credits`;
}

/** Never pick a minimum, add overlapping windows, or turn missing amounts into zero. */
export function hostedBalanceState(account: CreditAccount | null | undefined): HostedBalanceState {
  if (!account) return { status: "unavailable" };
  if (account.state !== "ready") {
    return { status: "ready", display: `${account.state}${account.reason ? `: ${account.reason}` : ""}` };
  }
  const parts = [
    `free ${credits(account.free.spendableCreditNanos)}`,
    `claimable ${credits(account.free.claimableCreditNanos)}`,
  ];
  for (const window of account.subscription.windows) {
    parts.push(`${window.kind} ${credits(window.availableCreditNanos)}`);
  }
  parts.push(`prepaid ${credits(account.prepaid.spendableCreditNanos)}`);
  if (!account.admission.eligible) parts.push(`not eligible${account.admission.reason ? `: ${account.admission.reason}` : ""}`);
  return { status: "ready", display: parts.join(" · ") };
}

export function formatHostedBalance(state: HostedBalanceState): string {
  if (state.status === "loading") return "Cloud: Loading…";
  if (state.status === "unavailable") return "Cloud: credit data unavailable";
  return `Cloud: ${state.display}`;
}

/** Customer source breakdown shared by the command and connection detail pane. */
export function formatBalanceDetail(account: CreditAccount | null): string {
  if (!account) return "  Credit data unavailable (unsupported account data).\n";
  const lines: string[] = [];
  const add = (label: string, value: string) => lines.push(`  ${label}: ${value}`);
  add("Credit state", account.state);
  if (account.reason) add("Reason", account.reason);
  add("Admission", account.admission.eligible ? "eligible" : "not eligible");
  if (account.admission.reason) add("Admission reason", account.admission.reason);
  add("As of", account.snapshotAt);

  const { free, subscription, prepaid } = account;
  add("Free state", free.state);
  add("  Claimable", credits(free.claimableCreditNanos));
  add("  Spendable", credits(free.spendableCreditNanos));
  add("  Held", credits(free.heldCreditNanos));
  add("  Resets at", free.resetAt ?? "not reported");

  add("Subscription state", subscription.state);
  add("  Period", `${subscription.periodStart ?? "not reported"} → ${subscription.periodEnd ?? "not reported"}`);
  for (const window of subscription.windows) {
    add(`  ${window.kind} available`, credits(window.availableCreditNanos));
    add("    Limit", credits(window.limitCreditNanos));
    add("    Settled", credits(window.settledCreditNanos));
    add("    Held", credits(window.heldCreditNanos));
    add("    Resets at", window.resetsAt);
  }
  if (subscription.windows.length > 0) lines.push("  Subscription windows overlap; they are not additive.");

  add("Prepaid spendable", credits(prepaid.spendableCreditNanos));
  add("Prepaid held", credits(prepaid.heldCreditNanos));
  add("Prepaid settled deficit", credits(prepaid.settledDeficitCreditNanos));
  add("Prepaid hold shortfall", credits(prepaid.holdShortfallCreditNanos));
  add("Prepaid consent", prepaid.consentEnabled ? "enabled" : "disabled");
  return lines.join("\n") + "\n";
}
