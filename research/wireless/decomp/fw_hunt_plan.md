# fw_hunt_plan.md — Parser-Bug Hunt Plan: BCM4387 WiFi Firmware (802.11 / NAN / AWDL)

**FwKickoff, 2026-10-14.**
Target image: `/usr/share/firmware/wifi/C-4387__s-C2/maldives.trx`
(BCM4387 "Maldives" TRX firmware, 1,761,333 bytes; ARM Cortex 32-bit LE; Ghidra imageBase 0;
analyzed previously with `GhidraFwStats.java` → `research/wireless/fw_stats.txt`: 4,159 functions).
Full decompile running → `decomp/fw_chip.log`, output C lands in `decomp/maldives.trx.c` +
`decomp/maldives.trx.functions.txt` (project `/tmp/ghidra-proj/fw_chip`).

All evidence below cites `fw_stats.txt:line` (function entrypoints/size and defined strings found
by the Ghidra stats pass). Unreferenced behavior is `[INFERENCE]` and labeled.

---

## 1. Why the largest functions first

The stats pass ranked every function by byte size; parse loops, IE/TLV walkers and iovar
dispatch tables are exactly the code Broadcom inlines into huge straight-line blobs (bounds
checks, switch dispatch, per-attribute copy loops). The 15 largest functions span
1,220–3,614 bytes each (`fw_stats.txt:2-16`) and are our ordered hunt list (§4).

## 2. Priority surfaces

### P0 — Information Element (IE) / TLV length & bounds handling
- Trigger string `SSIDinoweIE` at 0x1473f0 (`fw_stats.txt:50`) sits in the mgmt-frame parse
  region; SSID/IE handling in this firmware family has historically held off-by-one length
  checks (802.11 IE header: 1-byte tag + 1-byte len, next IE advanced by `len`, never checked
  against remaining frame length in first-cut code).
- `prune_wpa` at 0x1467ba (`fw_stats.txt:48`) — WPA IE prune path copies RSN/WPA IE contents
  with firmware-computed lengths; classic truncation/underflow candidate.
- `avoid-bssid` at 0x146714 and `pfn_add_bssid`/`pfnbest_bssid` at 0x14558c/0x1455e2
  (`fw_stats.txt:41,47`) — BSSID table population from Beacons/ProbeResp: indexed writes
  driven by attacker-controlled frame content. Check index bound vs table size.

**Hunt method:** in `decomp/maldives.trx.c`, grep each string address's xref, get the containing
function, and audit the `(ie_len < remaining)` / `memcpy(dst, ie+2, ie_len)` pattern pairs.
Every copy whose length comes from the frame without a pre-check against a stack/heap dst
size is a finding. Cite `fw_stats.txt` line + decompiled `file:line` for each.

### P1 — NAN dwell/config frame parsing
- `nan_dw_dwell_timer_2g` 0x1408f2, `nan_dw_dwell_timer_5g` 0x140908 (`fw_stats.txt:19-20`).
  NAN Discovery Window dwell config is settable via iovar; timers feed scheduler state
  machines that run concurrently with frame RX. NAN SDA/SDF service frames carry
  vendor-specific IEs parsed during dwell windows.
- `[INFERENCE]` Race surface: dwell-timer expiry mid-parse of a NAN frame buffer that the
  scheduler reclaims/rewrites. Look for timer callbacks that free/reuse the parse buffer.

### P1 — Beacon / ProbeResp TLV loops
- Same IE walker machinery as P0, but driven pre-association (scanning), i.e. reachable
  from any nearby AP without auth. The top-size functions in the 0x12xxxx–0x16xxxx range
  (§4 entries 1–10) are the likely mgmt-frame handlers given adjacency to the mgmt strings.
- Check for `while (tlv < end)` loops missing `len == 0` infinite-loop guards, and 16-bit
  total-length fields truncated to 8-bit accumulators.

### P2 — Off-channel / timer race surfaces (PNO / dwell / deadman)
- `deadman_state_machine` 0x144f35, `deadman_to` 0x190ae8 (`fw_stats.txt:39`, and string
  block) — watchdog timer interacting with scan/dwell completion callbacks.
- `awdl_psf_dwell` 0x145cc0, `awdl_doiovar_patch` 0x145c64 (`fw_stats.txt:45`) — AWDL is
  Apple-adjacent (our AirDrop/OWT work targets the ecosystem); psf (periodic sync frame)
  dwell logic racing channel switches is the highest-value AWDL surface.
- `trig_log_events` 0x1456d5 (`fw_stats.txt:43`) — event-log ring writes from ISR vs
  process context; check index wraparound handling.

## 3. Non-parsed but noted (context only, not primary hunt targets)
- H2D/D2H DMA error paths (0x140a49, 0x140a8c) and `pciedev_process_reqst_packet: count=%d`
  0x140b80 (`fw_stats.txt:23-24`) — host↔chip protocol packet with a count field; secondary
  if time remains.
- `DS_EVENT_*` state events 0x140c6b–0x140cf9 (`fw_stats.txt:25-30`) — device-sleep FSM;
  only if a race hypothesis needs it.

## 4. Ordered hunt list — top functions from fw_stats.txt (largest first)

| # | Entry point | Size (bytes) | Likely role `[INFERENCE]` | Priority |
|---|-------------|-------------:|---------------------------|----------|
| 1 | `FUN_001325b0` | 3614 | mgmt-frame / IE parse mega-blob (adjacent to SSID/IE strings) | P0 |
| 2 | `FUN_00131570` | 3438 | mgmt-frame parse companion (same region as #1) | P0 |
| 3 | `FUN_0012dca2` | 3226 | frame construction / iovar handler | P0/P1 |
| 4 | `FUN_001591e0` | 2962 | scan/parse loop | P1 |
| 5 | `FUN_000572b4` | 2520 | host-interface (PCIe/H2D) or RX path | P2 |
| 6 | `FUN_00137e7c` | 2158 | NAN scheduler/dwell state machine | P1 |
| 7 | `FUN_0015a614` | 2128 | TLV/IE secondary walker | P0/P1 |
| 8 | `FUN_00136468` | 1826 | BSS-list management (bssid strings nearby) | P0 |
| 9 | `FUN_00130478` | 1792 | mgmt TX / probe builder | P1 |
| 10 | `FUN_001688fc` | 1752 | timer/deadman interaction | P2 |
| 11 | `FUN_0012c62c` | 1710 | iovar dispatch table | P1 |
| 12 | `FUN_00161690` | 1434 | event/ring handling | P2 |
| 13 | `FUN_00055a04` | 1428 | DMA descriptor path | P2 |
| 14 | `FUN_0008ffbc` | 1222 | WPA/RSN prune helper cluster | P0 |
| 15 | `FUN_000b0088` | 1220 | AWDL psf/dwell helper cluster | P1/P2 |

Rationale for "likely role": string-xref proximity inside the 0x12xxxx–0x16xxxx code region
(`fw_stats.txt:19-50` strings all land at 0x140000–0x1473ff, inside/near these functions'
address spans) — to be confirmed from `decomp/maldives.trx.functions.txt` call graph once
the decompile lands. **Every role label is `[INFERENCE]` until each function's decompiled C
is checked against the string xrefs.**

## 5. Execution order
1. Wait for `decomp/maldives.trx.c` (full decompile, launched via `fw-chip-decomp`).
2. Grep string addresses (0x1473f0, 0x1467ba, 0x14558c, 0x1408f2/0x140908, 0x145cc0) in the
   `.c` file → map each to its containing `==== name @ addr` block.
3. Walk hunt list #1–#15 in order; for each: locate IE/TLV length arithmetic, copy loops,
   index writes; note `file:line` of the decompiled C for every candidate bug.
4. Write findings into `audits/` (per assignment ownership: only FMCAudit touches
   `audits/findmy_rotation.md`; new findings go through the main agent for placement).

## 6. Constraints honored
- Ghidra concurrency ≤ 2: launcher waits for zero running `analyzeHeadless` before start
  (single job, so ≤ 2 with queue2.sh's sequential chain).
- Own project dir `/tmp/ghidra-proj/fw_chip` — no lock contention with `q_*` projects.
- No commits of large artifacts; decomp C outputs stay untracked in `decomp/`.
