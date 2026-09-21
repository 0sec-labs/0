import type { UsageAccount } from "@0/core"

export type HostedBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; display: string };

function usd(amount: string | null): string {
  return amount === null ? "unavailable" : `$${amount}`;
}

function included(account: UsageAccount): string {
  const { state, usedPercent } = account.included;
  if (state === "none") return "no included allowance";
  if (state === "unavailable" || usedPercent === null) return "included usage unavailable";
  return `${usedPercent}% used${state === "exhausted" ? " (exhausted)" : ""}`;
}

/** Keep unavailable balances distinct from zero; the server owns usage policy. */
export function hostedBalanceState(account: UsageAccount | null | undefined): HostedBalanceState {
  if (!account) return { status: "unavailable" };
  if (account.state !== "ready") {
    return { status: "ready", display: `${account.state}${account.reason ? `: ${account.reason}` : ""}` };
  }
  const parts = [included(account)];
  if (account.plan.name) parts.unshift(account.plan.name);
  parts.push(`API ${usd(account.prepaid.balanceUsd)} · fallback ${account.prepaid.fallbackEnabled ? "on" : "off"}`);
  if (!account.admission.eligible) parts.push(`not eligible${account.admission.reason ? `: ${account.admission.reason}` : ""}`);
  return { status: "ready", display: parts.join(" · ") };
}

export function formatHostedBalance(state: HostedBalanceState): string {
  if (state.status === "loading") return "Cloud: Loading…";
  if (state.status === "unavailable") return "Cloud: usage unavailable";
  return `Cloud: ${state.display}`;
}

/** Customer account details shared by the command and connection pane. */
export function formatBalanceDetail(account: UsageAccount | null): string {
  if (!account) return "  Usage unavailable (unsupported account data).\n";
  const lines: string[] = [];
  const add = (label: string, value: string) => lines.push(`  ${label}: ${value}`);
  add("Usage state", account.state);
  if (account.reason) add("Reason", account.reason);
  add("Plan", account.plan.name ?? "none");
  if (account.plan.monthlyPriceUsd !== null) add("Monthly price", usd(account.plan.monthlyPriceUsd));
  add("Included", included(account));
  add("Resets at", account.included.resetsAt ?? "not reported");
  add("Prepaid API balance", usd(account.prepaid.balanceUsd));
  add("Prepaid fallback", account.prepaid.fallbackEnabled ? "on" : "off");
  add("Billing management", account.canManageBilling ? "owner" : "owner required");
  add("Admission", account.admission.eligible ? "eligible" : "not eligible");
  if (account.admission.reason) add("Admission reason", account.admission.reason);
  add("As of", account.snapshotAt);
  return lines.join("\n") + "\n";
}
