# AWDL identity surface — no-sudo probe results (this Mac, macOS 26 / Darwin 25.2)

Run: `./probe.sh > probe_raw.txt 2>&1` (raw evidence in `probe_raw.txt`, 2026-10-14).
All commands below ran as the **logged-in user, no sudo**. Airportd decomp not yet in
`decomp/` (only bluetoothaudiod / findmydeviced / wifip2pd / wifivelocityd are) — this
is pure live observation, and it turned out to be enough for the campaign's AWDL leg.

## Summary table

| # | command | sudo-free? | reveals |
|---|---|---|---|
| P1 | `ifconfig awdl0` | YES | interface state, **randomized AWDL MAC**, link-local v6 derived from it |
| P2 | `netstat -I awdl0` | YES | cumulative in/out counters (168,573 rx / 17,085 tx pkts at probe time); `-w 1` deltas read 0 when idle |
| P3 | `dns-sd -B _airplay._tcp local.` | YES | AirPlay/AirDrop-reachable services, incl. peers reachable **over AWDL** |
| P4 | `log show --last 5m --predicate 'process == "airportd"'` | YES | AWDL REALTIME mode state, WoW-on-awdl0, BT-coex LQM stats — but **no peer MACs** |
| P5 | `log show --predicate 'process == "wifip2pd" AND eventMessage CONTAINS "peer presence"'` | YES | **THE FEED**: `Posted peer presence/absence for <peer MAC> on awdl0` — peer MACs, join/leave timestamps |
| P6 | `log stream --predicate 'process == "wifip2pd" AND eventMessage CONTAINS[c] "peer"'` | YES | same feed live (used by `awdl_collect.py`) |
| P7 | `cat /var/run/syslog` | NO (socket, `cat` → `Invalid argument`) | nothing; legacy socket only |
| P8 | `system_profiler SPAirPortDataType` | YES (slow ~20s) | awdl0 MAC, all supported channels (2+5 GHz) |

## P1 — the AWDL MAC is a separate, randomized, rotating identity

```
awdl0: ether e6:c7:c4:89:b5:c0     status: active
en0:   ether 52:17:35:fa:86:83
```

- awdl0's MAC differs from en0's; both have the locally-administered bit (0x02) set —
  en0's is also randomized here (Private Wi-Fi Address enabled), so the delta is not
  "random vs hardware" but "AWDL-specific ephemeral vs current Wi-Fi address".
- The AWDL MAC is drawn from the locally-administered pool and **rotates** (wifip2pd
  logs the rotation: `AWDLInterface<P2PController<AppleIO80211Driver>>[awdl0]<e6:c7:...>
  enabled AWDL after 0 retries`). `awdl_collect.py` polls it at 5s cadence and records
  every change as `awdl_mac_change` — this MAC is therefore a *session-scoped* tracking
  identifier at best, exactly like the BLE-side rotation FindMy analysis already covered.

## P2 — traffic counters

```
awdl0  1500  <Link#20>  e6:c7:c4:89:b5:c0   Ipkts 168573  Opkts 17085
```
Confirms awdl0 has carried substantial traffic since boot without any pairing.

## P3 — dns-sd: interface scoping reality

- `dns-sd -i awdl0 -B ...` — **accepted (`Using interface 20`) but silently empty**:
  interface-scoped browsing does not surface AWDL peers this way on this OS.
- `dns-sd -p2p -B ...` — works, browses the P2P/AWDL interface (index -3, results on
  `if 0`).
- `dns-sd -includeAWDL -B ...` — works; default browse already included the AWDL-synced
  entries, so the flag is additive-redundant today.
- Observed during probe: `MacBook Pro von Fabian` (a team Mac) appeared/disappeared on
  `if 14` (en0) across two browses — service-level churn visible passwordless.
- `_airdrop._tcp` browse returned nothing at probe moment (no AirDrop window open
  anywhere; AirDrop registrants only surface while a registrar is active).

## P4 — airportd is the wrong daemon for peers

`log show` passwordless works and is *loud* (723 lines/10m), but peer hits are XPC
noise; the AWDL-relevant content is mode/state only:

```
airportd: AWDL REALTIME is inactive, AIRPLAY is inactive, SIDECAR is inactive,
          ENSEMBLE is inactive, D2DMIGRATION is inactive
airportd: AWDL started
airportd: WoW: <airport[470]> WoW not supported on awdl0, skipping
```

## P5 — wifip2pd: the AWDL peer feed (headline result)

Passwordless, Default log level, per-peer with MACs:

```
wifip2pd: [com.apple.awdl:interface] Posted peer presence for a6:3d:c3:6f:16:c4 on awdl0
wifip2pd: [com.apple.awdl:interface] Posted peer absence  for da:fb:c0:7d:e1:19 on awdl0
```

**24h passive harvest on this bench: 528 distinct AWDL peer MACs, 4,577
presence/absence events** — all from neighbors' devices, no pairing, no interaction,
no sudo. Peer MACs are overwhelmingly locally-administered (02:/06:/0a:/0e:/12:/16:/1a:
prefix family = per-interface randomized addresses, same class as our own awdl0 MAC).

## P6 — live stream (collector input)

`log stream --predicate 'process == "wifip2pd" AND eventMessage CONTAINS[c] "peer"'`
runs passwordless and is what `awdl_collect.py` tails.

## P7 — /var/run/syslog

```
srw-rw-rw- 1 root daemon 0 ... /var/run/syslog      # listing OK
cat: /var/run/syslog: Invalid argument              # it's a socket, not a file
```
Dead end, correctly noted.

## P8 — system_profiler

Confirms awdl0 identity (same MAC as P1) and channel support (1–13, 36–165),
i.e. the full AWDL operating range, passwordless.

## Consequence for the campaign

The AWDL peer MAC stream is fully readable without privileges and without the decomp —
the correlation question ("does an AWDL peer presence co-occur with a BLE continuity
identity?") is answerable from live observation alone; only the *cryptographic binding*
(AWDL peer MAC → Apple identity fields inside the action frames) still needs the
airportd decomp when the queue delivers it.
