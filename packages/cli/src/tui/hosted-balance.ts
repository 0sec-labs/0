import type { CreditAccount } from "@0/core";

/** Loading belongs to the active chat identity; credit readiness belongs to the DTO. */
export type HostedBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; display: string };

function fmtUsd(usd: string | null): string {
  return usd === null ? "unavailable" : `$${usd}`;
}

/** Never pick a minimum, add overlapping windows, or turn missing amounts into zero. */
export function hostedBalanceState(account: CreditAccount | null | undefined): HostedBalanceState {
  if (!account) return { status: "unavailable" };
  if (account.state !== "ready") {
    return { status: "ready", display: `${account.state}${account.reason ? `: ${account.reason}` : ""}` };
  }
  const parts: string[] = [];

  const inc = account.included;
  if (inc.state === "unavailable") {
    parts.push("included: unavailable");
  } else {
    const pct = inc.usedPercent !== null ? `${inc.usedPercent}%` : "—";
    const reset = inc.resetsAt ? `resets ${inc.resetsAt.slice(0, 10)}` : "";
    parts.push(`included ${inc.state} (${pct} used${reset ? `, ${reset}` : ""})`);
  }

  const pre = account.prepaid;
  parts.push(`prepaid ${fmtUsd(pre.balanceUsd)}${pre.fallbackEnabled ? " (fallback)" : ""}`);

  if (!account.admission.eligible) {
    parts.push(`not eligible${account.admission.reason ? `: ${account.admission.reason}` : ""}`);
  }

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

  const plan = account.plan;
  if (plan.id) {
    add("Plan", plan.name ?? plan.id);
    if (plan.monthlyPriceUsd) add("  Price", fmtUsd(plan.monthlyPriceUsd));
  } else {
    add("Plan", "none");
  }

  const inc = account.included;
  add("Included state", inc.state);
  if (inc.usedPercent !== null) add("  Used", `${inc.usedPercent}%`);
  add("  Resets at", inc.resetsAt ?? "not reported");

  const pre = account.prepaid;
  add("Prepaid balance", fmtUsd(pre.balanceUsd));
  add("Prepaid fallback", pre.fallbackEnabled ? "enabled" : "disabled");

  add("Can manage billing", account.canManageBilling ? "yes" : "no");

  return lines.join("\n") + "\n";
}