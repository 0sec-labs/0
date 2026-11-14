/** "OpenAI (Work key)": the provider plus the account's label, so one of several accounts can be told apart. */
export function accountDisplayName(provider: string, label: string | undefined, accountId: string | undefined): string {
  const name = (label ?? "").trim() || accountId || "";
  return name && name.toLowerCase() !== provider.toLowerCase() ? `${provider} (${name})` : provider;
}

/** What disconnecting removes, in plain words. `others` is the number of accounts saved for the provider, including this one. */
export function disconnectCopy(providerId: string, name: string, hostName: string, others: number): string {
  if (providerId === "chatgpt-plan") return `This signs out ${name} on ${hostName}: its saved tokens are cleared and 0 tries to revoke the refresh token. Its label, order and model switches are removed too.`;
  const rest = others > 1 ? ` ${others - 1 === 1 ? "Your other account for this provider stays connected." : "Your other accounts for this provider stay connected."}` : "";
  return `This removes ${name} from ${hostName}: its saved credentials, its place in the order and its model on/off switches. The key itself is not revoked with the provider.${rest}`;
}

/** Account id for an extra API-key account: a slug of the label plus a suffix, unique among the saved ones. */
export function newAccountId(label: string, existing: readonly string[]): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account";
  if (!existing.includes(slug) && slug !== "default") return slug;
  for (let n = 2; ; n++) { const candidate = `${slug}-${n}`; if (!existing.includes(candidate)) return candidate; }
}
