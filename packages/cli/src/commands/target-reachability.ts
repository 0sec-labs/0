import { connect } from "node:net";

/** Why a scan target did not answer, in words a person can act on; undefined when the failure is not about reaching it. */
export function describeUnreachable(url: string, error: unknown): string | undefined {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Could not find the host in ${url}. Check the address for a typo, and your network or DNS.`;
  if (code === "ECONNREFUSED") return `${url} refused the connection. Check that the server is running and the port is right.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${url} cannot be reached from this computer. Check your network or VPN.`;
  if (code === "ETIMEDOUT" || code === "TIMEOUT") return `${url} did not answer in time. Check that it is up and that nothing blocks this computer.`;
  return undefined;
}

type Connect = (host: string, port: number, timeoutMs: number) => Promise<void>;

const tcpConnect: Connect = (host, port, timeoutMs) => new Promise((resolve, reject) => {
  const socket = connect({ host, port });
  socket.setTimeout(timeoutMs);
  socket.once("connect", () => { socket.destroy(); resolve(); });
  socket.once("timeout", () => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })); });
  socket.once("error", (error) => { socket.destroy(); reject(error); });
});

/**
 * Stop before spending anything on a web target that does not answer. Opens a TCP connection and nothing else, so the
 * target sees no request and a server that answers anything (including 401 or 404) counts as reachable. A failure it
 * cannot classify never blocks the scan.
 */
export async function assertTargetReachable(url: string, options: { connectImpl?: Connect; timeoutMs?: number } = {}): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  try {
    await (options.connectImpl ?? tcpConnect)(host, port, options.timeoutMs ?? 10_000);
  } catch (error) {
    const reason = describeUnreachable(url, error);
    if (reason) throw new Error(`${reason} No scan was started.`);
  }
}
