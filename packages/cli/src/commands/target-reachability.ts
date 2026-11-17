/** Why a scan target did not answer, in words a person can act on; undefined when it is reachable or when the failure is not about reaching it (for example a certificate the scan may be meant to ignore). */
export function describeUnreachable(url: string, error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  const name = (error as { name?: string } | undefined)?.name;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Could not find the host in ${url}. Check the address for a typo, and your network or DNS.`;
  if (code === "ECONNREFUSED") return `${url} refused the connection. Check that the server is running and the port is right.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${url} cannot be reached from this computer. Check your network or VPN.`;
  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `${url} did not answer in time. Check that it is up and that nothing blocks this computer.`;
  return undefined;
}

/**
 * Stop before spending anything on a target that does not answer. Any HTTP answer, including an error status, counts as
 * reachable: the scan is allowed to test pages that return 401 or 404. Never blocks on failures it cannot classify.
 */
export async function assertTargetReachable(url: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    const reason = describeUnreachable(url, error);
    if (reason) throw new Error(`${reason} No scan was started.`);
  }
}
