#!/bin/bash
# AWDL identity-surface probe — NO-SUDO observation of what AWDL exposes on a stock Mac.
# Every command here runs as the logged-in user. Record: does it work, and what does it reveal?
# Usage: ./probe.sh > probe_output.txt 2>&1
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

hdr() { echo; echo "=============================================================="; echo "## $1"; echo "=============================================================="; }

hdr "P1. ifconfig awdl0 — interface state + randomized AWDL MAC"
# WORKS NO-SUDO. Reveals: awdl0 MAC (locally-administered, randomized, ROTATES) vs en0 MAC.
ifconfig awdl0
echo "--- en0 for comparison:"
ifconfig en0 | head -4
AWDL_MAC=$(ifconfig awdl0 | awk '/ether/{print $2}')
EN0_MAC=$(ifconfig en0  | awk '/ether/{print $2}')
echo "awdl0 MAC = $AWDL_MAC   en0 MAC = $EN0_MAC"
echo "locally-administered bit (0x02 of first octet) set on awdl0 MAC? $(python3 -c "print(bool(int('${AWDL_MAC%%:*}',16) & 2))")  (en0: $(python3 -c "print(bool(int('${EN0_MAC%%:*}',16) & 2))") = hardware/universal)"
echo "DELTA note: AWDL uses a per-interface randomized MAC that is NOT the hardware Wi-Fi MAC and rotates over time; track with awdl_collect.py."

hdr "P2. netstat -I awdl0 — traffic counters (proof awdl0 is carrying traffic)"
# WORKS NO-SUDO. Reveals cumulative in/out packet counters on awdl0.
netstat -I awdl0
echo "--- 3s sampled deltas (typically zero when no AWDL session is active):"
netstat -I awdl0 -w 1 3 2>&1 | head -5

hdr "P3. dns-sd browse — mDNS service discovery incl. AWDL-reachable peers"
# WORKS NO-SUDO. dns-sd -i <if> is NOT honored for browsing (silently no results) on this
# macOS; interface scoping happens via mDNSResponder flags instead.
echo "--- default browse _airplay._tcp (10s): AWDL peers surface on en0's index when synced"
dns-sd -t 10 -B _airplay._tcp local. 2>&1
echo "--- -includeAWDL browse _airplay._tcp (10s): explicit AWDL inclusion (same surface)"
dns-sd -t 10 -includeAWDL -B _airplay._tcp local. 2>&1
echo "--- -p2p browse _airplay._tcp (10s): P2P/AWDL interface index -3 view"
dns-sd -t 10 -p2p -B _airplay._tcp local. 2>&1
echo "--- -i awdl0 browse (10s): UNSUPPORTED — silently empty"
dns-sd -t 10 -i awdl0 -B _airplay._tcp local. 2>&1
echo "--- _airdrop._tcp browse (10s): AirDrop registrants"
dns-sd -t 10 -includeAWDL -B _airdrop._tcp local. 2>&1

hdr "P4. log show airportd — WiFi-manager view (passwordless)"
# WORKS NO-SUDO. Reveals AWDL REALTIME mode state, WoW on awdl0, LQM w/ BT-coex stats.
log show --last 5m --predicate 'process == "airportd"' 2>&1 | grep -iv "^Timestamp" | head -15

hdr "P5. log show wifip2pd — THE AWDL PEER FEED (passwordless)"
# WORKS NO-SUDO. Reveals per-peer presence/absence with peer MACs on awdl0.
# This is the primary AWDL event source for the collector (airportd does NOT log peer MACs).
log show --last 10m --predicate 'process == "wifip2pd" AND eventMessage CONTAINS[c] "peer presence"' 2>&1 | grep -v "^Timestamp" | head -15
echo "--- last 24h distinct AWDL peer MACs observed:"
log show --last 24h --predicate 'process == "wifip2pd" AND eventMessage CONTAINS "peer presence"' 2>&1 \
  | grep -oE 'presence for [0-9a-f:]{17}' | awk '{print $3}' | sort -u
echo "--- last 24h AWDL enable events (own randomized MAC rotates here):"
log show --last 24h --predicate 'process == "wifip2pd" AND eventMessage CONTAINS "AWDLInterface"' 2>&1 | head -5

hdr "P6. log stream — live follow (passwordless, used by awdl_collect.py)"
( log stream --style syslog --predicate 'process == "wifip2pd" AND eventMessage CONTAINS[c] "peer"' 2>&1 & p=$!; sleep 6; kill $p ) | head -5

hdr "P7. /var/run/syslog — legacy socket"
# EXISTS but not a readable file: ls works, cat fails ('No such device') — it's a socket.
ls -la /var/run/syslog* 2>&1
cat /var/run/syslog 2>&1 | head -2

hdr "P8. system_profiler SPAirPortDataType — AWDL status + PHY info (passwordless)"
# WORKS NO-SUDO but slow (~20s); prints awdl0 status and supported channels.
system_profiler SPAirPortDataType 2>/dev/null | sed -n '/awdl0/,/^$/p' | head -20 & p=$!; sleep 45; kill $p 2>/dev/null; wait $p 2>/dev/null

hdr "DONE"
