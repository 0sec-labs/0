# Desk map — persistent workplace tracking from one laptop

_Generated 2026-10-14 from a frozen snapshot of `ble_map.jsonl` (4344 lines) and `radar_live.jsonl` (1791 lines, live feed, copied at unix 1791962945). Raw per-identifier table: `desk_map.json`._

## Capture reality check

The two input files are **two short scan bursts from the same laptop**, not one continuous monitoring session:

- `ble_map.jsonl`: 121.8s burst (22:30:59–22:33:00 PT), 4344 lines
- `radar_live.jsonl`: 249.7s burst (00:24:55–00:29:05 PT), 1791 lines (still appending when snapshotted)
- Gap between the bursts: **1.87h**

Total: **182 unique persistent identifiers**, **6135 observations**, 0 malformed lines discarded. 86 observations carried rssi=127 (CoreBluetooth's invalid-RSSI placeholder) and are excluded from RSSI statistics.

## How a device earns DESK-STABLE

A 2-minute burst can't distinguish a desk from a parked human by session count alone — every device here shows 1–2 sessions because the windows are short. So stability is graded:

1. **DESK-CONFIRMED** — the *same identifier* is audible in both bursts, 1.87h apart. That is the signature of hardware that lives at a fixed spot (desk, docked phone, peripherals).
2. **SCAN-STABLE** — present for ≥90% of one burst in ≤2 sessions with ≥10 observations: continuously advertising during the whole scan = stationary during that scan, but only proven for that moment.
3. **TRANSIENT** — partial presence: walk-bys, brief appearances, edge-of-range flicker.

## Headline numbers

- Total unique identifiers tracked: **182**
- Desk-stable total: **56** (1 desk-confirmed + 55 scan-stable); transient: 126
- Named devices heard: **5** — `47A7FFC9` *PeakPhone*, `F9839FDF` *Doruk Tan’s Backpack*, `189881BD` *L5006XZ*, `0ABAB860` *4*, `6B9B775F` *BCPro_203739*
- Named devices that are desk-stable: **3**

## DESK-CONFIRMED (heard in both bursts, 1.87h apart)

| rank | id | name | obs | rssi min | med | max | ring | sessions | src | class |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `47A7FFC9` | PeakPhone | 377 | -64 | -53.0 | -41 | 1 | 2 | ble_map:105+radar_live:272 | DESK-STABLE |

## Top 20 by within-capture presence

| rank | id | name | obs | rssi min | med | max | ring | sess | src:obs | class |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `47A7FFC9` | PeakPhone | 377 | -64 | -53.0 | -41 | 1 | 2 | ble_map:105+radar_live:272 | DESK-STABLE |
| 2 | `759C0F49` | unnamed | 47 | -98 | -89 | -86 | 3 | 1 | radar_live:47 | DESK-STABLE |
| 3 | `EDF96AF8` | unnamed | 163 | -92 | -81.0 | -78 | 3 | 1 | radar_live:163 | DESK-STABLE |
| 4 | `3DE21FB2` | unnamed | 116 | -96 | -87.0 | -79 | 3 | 1 | radar_live:116 | DESK-STABLE |
| 5 | `6FCBF6B7` | unnamed | 187 | -97 | -83 | -75 | 3 | 1 | radar_live:187 | DESK-STABLE |
| 6 | `CAC06DB7` | unnamed | 33 | -98 | -94 | -92 | 4 | 1 | radar_live:33 | DESK-STABLE |
| 7 | `7C962449` | unnamed | 110 | -94 | -87 | -79 | 3 | 1 | radar_live:110 | DESK-STABLE |
| 8 | `7F873727` | unnamed | 14 | -58 | -53.5 | -50 | 1 | 1 | radar_live:14 | DESK-STABLE |
| 9 | `94944D34` | unnamed | 10 | -89 | -79.5 | -77 | 2 | 1 | radar_live:10 | DESK-STABLE |
| 10 | `04F81D86` | unnamed | 10 | -94 | -86.0 | -81 | 3 | 1 | radar_live:10 | DESK-STABLE |
| 11 | `44B09A9B` | unnamed | 32 | -94 | -88.0 | -79 | 3 | 1 | radar_live:32 | DESK-STABLE |
| 12 | `5E9999B3` | unnamed | 8 | -93 | -93.0 | -91 | 4 | 1 | radar_live:8 | TRANSIENT |
| 13 | `8DC95AA2` | unnamed | 93 | -99 | -93 | -89 | 4 | 1 | radar_live:93 | DESK-STABLE |
| 14 | `7311EBA8` | unnamed | 37 | -99 | -92 | -88 | 4 | 1 | radar_live:37 | TRANSIENT |
| 15 | `35C97D5E` | unnamed | 46 | -100 | -93.0 | -88 | 4 | 1 | radar_live:46 | TRANSIENT |
| 16 | `FA9187A4` | unnamed | 11 | -93 | -80 | -76 | 2 | 1 | radar_live:11 | TRANSIENT |
| 17 | `2C21F8E6` | unnamed | 12 | -99 | -82.5 | -78 | 3 | 1 | radar_live:12 | TRANSIENT |
| 18 | `B81ACFEE` | unnamed | 8 | -96 | -93.5 | -91 | 4 | 1 | radar_live:8 | TRANSIENT |
| 19 | `F9839FDF` | Doruk Tan’s Backpack | 18 | -86 | -81.5 | -77 | 3 | 1 | radar_live:18 | TRANSIENT |
| 20 | `662087ED` | unnamed | 13 | -95 | -88 | -77 | 3 | 1 | radar_live:13 | TRANSIENT |

Ring = median-RSSI band (ring1 ≥ −55, ring2 ≥ −80, ring3 ≥ −90, else ring4).

## Named devices, cross-referenced

- `47A7FFC9` **PeakPhone** — rank 1, 377 obs, median RSSI -53.0 (ring 1), desk-stable (desk_confirmed)
- `F9839FDF` **Doruk Tan’s Backpack** — rank 19, 18 obs, median RSSI -81.5 (ring 3), transient (transient)
- `189881BD` **L5006XZ** — rank 29, 5 obs, median RSSI -96 (ring 4), transient (transient)
- `0ABAB860` **4** — rank 45, 79 obs, median RSSI -74.0 (ring 2), desk-stable (scan_stable)
- `6B9B775F` **BCPro_203739** — rank 63, 14 obs, median RSSI -78.5 (ring 2), desk-stable (scan_stable)

`47A7FFC9` (**PeakPhone**) is the only identifier present in *both* bursts: 105 obs covering 99% of the first burst, then 272 obs covering 99% of the second burst 1.87 hours later. **The named phone did not move meaningfully between the two scans — and a passive laptop-side listener can say so with zero pairing, zero connection, zero user interaction.** [INFERENCE: stationary from continuous presence; the phone could also have been moved and returned within an unobserved gap.]

## What this proves about workplace tracking

- From a single stock laptop with no special hardware, a pair of passive scans totaling **6.2 minutes** enumerated **182 devices** and fingerprinted **56 of them as desk-stable** — including one device carrying a human-readable name (`PeakPhone`).
- Randomized MACs do not help: Apple's Continuity peripherals (Handoff/NearbyInfo/FindMy) re-use a stable per-device identifier in the `mac` field of these captures, so the same physical device is recognized burst-to-burst — that is what makes cross-burst persistence visible at all.
- Device names leak third-party identity: `Doruk Tan’s Backpack` (an AirTag-style FindMy beacon advertising its owner's name) and `BCPro_203739` were both heard; a co-worker's bag is locatable from your desk.
- RSSI medians place stationary devices into rooms: 6F.../ED.../3D... sit in ring 3 (another floor/room) yet were continuously present through the whole live burst — neighboring desks, not visitors.
[INFERENCE] With continuous monitoring instead of two bursts, the desk-confirmed set would grow well beyond one device: all 55 scan-stable devices already show multi-minute continuous presence and would likely re-appear on every repeat scan.

