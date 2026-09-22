import type { CreditAccount } from "@0/core";

/** Loading belongs to the active chat identity; credit readiness belongs to the DTO. */
export type HostedBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; display: string };

function fmtUsd(usd: string | null): string {
  return usd === null ? "unavailable" : `$${usd}`;
}

/** Missing usage stays unavailable; prepaid is shown only when enabled. */
export function hostedBalanceState(account: CreditAccount | null | undefined): HostedBalanceState {
  if (!account) return { status: "unavailable" };
  const { included, prepaid } = account;
  const parts = [included.state !== "unavailable" && included.usedPercent !== null
    ? `${included.usedPercent}% used` : "unavailable"];
  if (included.state !== "unavailable" && included.resetsAt) {
    parts.push(`resets ${included.resetsAt.slice(0, 10)}`);
  }
  if (prepaid.fallbackEnabled) parts.push(`prepaid ${fmtUsd(prepaid.balanceUsd)}`);
  if (account.state !== "ready") {
    parts.push(`${account.state}${account.reason ? `: ${account.reason}` : ""}`);
  } else if (!account.admission.eligible) {
    parts.push("access blocked");
  }
  return { status: "ready", display: parts.join(" · ") };
}

export function formatHostedBalance(state: HostedBalanceState): string {
  if (state.status === "loading") return "Usage: Loading…";
  if (state.status === "unavailable") return "Usage: unavailable";
  return `Usage: ${state.display}`;
}

/** Shared human-readable usage view; the JSON account contract is unchanged. */
export function formatBalanceDetail(account: CreditAccount | null): string {
  if (!account) return "  Usage unavailable (unsupported account data).\n";
  const { included, prepaid } = account;
  const lines = [included.state !== "unavailable" && included.usedPercent !== null
    ? `  Usage: ${included.usedPercent}% used` : "  Usage: unavailable"];
  if (included.state !== "unavailable" && included.resetsAt) {
    lines.push(`  Resets: ${included.resetsAt}`);
  }
  if (prepaid.fallbackEnabled) lines.push(`  Prepaid balance: ${fmtUsd(prepaid.balanceUsd)}`);
  if (account.state !== "ready" || !account.admission.eligible) {
    lines.push(`  Access: ${account.state === "ready" ? "blocked" : account.state}`);
    const reason = account.admission.reason ?? account.reason;
    if (reason) lines.push(`  Reason: ${reason}`);
  }
  return lines.join("\n") + "\n";
}