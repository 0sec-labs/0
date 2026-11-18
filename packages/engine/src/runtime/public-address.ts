import { BlockList, isIP } from "node:net";

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["192.88.99.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
blockedIpv6.addSubnet("2001:db8::", 32, "ipv6");
blockedIpv6.addSubnet("2001::", 23, "ipv6");
blockedIpv6.addSubnet("2002::", 16, "ipv6");

/** True for a globally routable address: not private, loopback, link-local, reserved or documentation space. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blockedIpv4.check(address, "ipv4")
    : family === 6 && globalIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6");
}
