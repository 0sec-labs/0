/**
 * The single place a remote MCP endpoint is judged. HTTPS only (plain http only to a literal loopback name, for local
 * servers), no URL credentials or fragment, and the name must resolve to public addresses only: a name that points at a
 * private, loopback, link-local or cloud-metadata address is refused, also when only one of several answers does.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Resolver = (hostname: string) => Promise<readonly string[]>;
export const systemResolver: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address);

const blocked = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) blocked.addSubnet(a, p, "ipv6");

/** True for an address an MCP endpoint must never reach, including an IPv4 address written as IPv4-mapped IPv6. */
export function isBlockedAddress(raw: string): boolean {
  const address = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const mapped = address.toLowerCase().match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  const hex = address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const v4 = mapped?.[1] ?? (hex ? `${parseInt(hex[1]!, 16) >> 8}.${parseInt(hex[1]!, 16) & 255}.${parseInt(hex[2]!, 16) >> 8}.${parseInt(hex[2]!, 16) & 255}` : null);
  const target = v4 ?? address; const family = isIP(target);
  return family === 0 ? true : blocked.check(target, family === 4 ? "ipv4" : "ipv6");
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws a plain sentence when the endpoint must not be used; returns the parsed URL otherwise. */
export async function checkRemoteEndpoint(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL; try { url = new URL(raw); } catch { throw new Error("MCP HTTP endpoint is not a valid URL"); }
  if (url.username || url.password || url.hash) throw new Error("MCP HTTP endpoint must not carry URL credentials or a fragment");
  if (url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname)) return url;
  if (url.protocol !== "https:") throw new Error("MCP HTTP endpoint requires HTTPS (plain HTTP only to localhost, 127.0.0.1 or [::1])");
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("MCP HTTP endpoint points at a local name; use http://localhost for a local server");
  const addresses = isIP(host.replace(/^\[|\]$/g, "")) ? [host] : await resolve(host).catch(() => { throw new Error(`MCP HTTP endpoint host ${host} could not be resolved`); });
  if (!addresses.length) throw new Error(`MCP HTTP endpoint host ${host} did not resolve to any address`);
  const bad = addresses.find(isBlockedAddress);
  if (bad !== undefined) throw new Error(`MCP HTTP endpoint host ${host} resolves to a private, loopback, link-local or metadata address and is refused`);
  return url;
}
