# LE Audio ASCS OOB-Read PoC (leaudio_poc)

Part of the Apple wireless campaign (Phase 2). Legal, self-contained PoC rig for the
ASCS codec-config heap OOB read found by static audit in Apple's `bluetoothaudiod`.

## Goal

Demonstrate, end-to-end and against a target we own, the attack chain of
**xpc_sweep_findings.md finding 2** (`audits/xpc_sweep_findings.md:17-21`):

1. A BLE central that is merely *paired* (any peer that can write a GATT
   characteristic) sends a crafted **Codec Configuration** command
   (ASCS opcode 0x01) to the ASE Control Point.
2. The command declares a codec-config TLV blob **longer than the bytes the ATT
   write actually carries** (or ends with a TLV whose declared length overruns the
   materialized buffer).
3. `bluetoothaudiod`'s parser walks the TLV chain up to the *declared* length,
   copying attacker-guided amounts into small fixed fields — reading **past the
   heap buffer** that backs the config data.
4. The OOB bytes land in parsed codec fields which are **echoed back to the
   writing central** as characteristic updates — a remote, read-only,
   echo-back information leak (plus a heap-metadata-dependent DoS).

## The bug, precisely (static evidence)

All references are to `research/wireless/decomp/re_bluetoothaudiod.c`
(decompilation of `/usr/libexec/bluetoothaudiod`, arm64e, macOS 25.2.0 host):

| Step | Where | What happens |
|---|---|---|
| Reach | `:35531` header, `:35586-35592` | `ASCSServerService::receivedWriteRequest:` @`100032d80` dispatches GATT writes on the ASE Control Point; **opcode 1 → `codecConfigRequest_`** (opcode 2 → QoS, 3 → enable, ...). |
| Entry | `:35721` header, `@10003344c` | `ASCSServerService::codecConfigRequest:` — reads `local_91` = ASE count (attacker byte), then per ASE: `local_94` ASE_ID, `local_95` target latency, `local_96` PHY, 5-byte `readUint40_` codec ID, and `local_97` = **codec-config length (attacker byte, ≤ 255)** read at `:35838`. |
| Materialize | `:35839-35842`, `readNumBytes_toData_` @`10002cf50` (`:31234-31261`) | Exactly `local_97` bytes are requested from the write stream into an `NSMutableData`. `readNumBytes_toData_` **appends only on a fully successful read** (`if (IVar1 == uVar2)`, `:31250-31252`) — a *truncated* write leaves the config data **empty** while the parser still runs to `local_97`. |
| Parse loop | `:35843-35885` | `while ((int)uVar12 < (int)(uint)local_97)` (`:35880`) indexes the config bytes at `data[idx+1]` (type, `:35846`) / `data[idx]` (length, used by types ≥ 3, `:35862`) / `data[idx+2]` (value) **with no bound against the buffer's real length**. Decompile wire order is `[len][type][value]`. |
| OOB copy (t3) | `:35863-35868` | type 3: `___memcpy_chk(&local_9c, data + idx + 2, bVar3, 4)` — **attacker length `bVar3`** (≤ 4 enforced only by `_chk` fortify) copied from an offset that can lie past the buffer end → channel-allocation mask. |
| OOB copy (t4) | `:35869-35875` | type 4: `___memcpy_chk(&local_9c, data + idx + 2, bVar3 - 1, 2)` — **length-1** bytes → octets-per-codec-frame. (`bVar3 == 0` → huge `n` → `__chk_fail` abort = DoS.) |
| Echo back | `:35906-35920` | `ServerCommonAudioProfile::updateValue_forCharacteristic_onSubscribedCentrals_` pushes the response (built via `DataOutputStream`) onto **`ASEControlPointCharacteristic`** — the parsed, OOB-influenced fields go back over the air to the writing central. |
| Enable gate | `:50579-50646` | Daemon entry gate: continues only if `os_feature_enabled_impl("Accessibility","LeAudio")`, **or** `developer_mode_status == 1` (sysctl `security.mac.amfi.developer_mode_status`) **and** `CFPreferences` `com.apple.bluetooth enableHALEAudio == true`. Otherwise logs *"LE Audio Feature not enabled exiting"* and `_exit(0)`. |

GATT surface (UUIDs present in the CoreBluetooth decompilation string table,
`decomp/CoreBluetooth.c:60487-60579`): service **0x184B** Common Audio Service,
characteristics **0x2B84** Sink ASE, **0x2B85** Source ASE,
**0x2B86** ASE Control Point.

## What is in this directory

| File | Role |
|---|---|
| `victim_peripheral.swift` | `CBPeripheralManager` simulating the vulnerable ASCS server. Advertises 0x184B, exposes 0x2B84/0x2B85/0x2B86, implements the **same buggy parser** extracted from the decompile. The config buffer is `malloc`'d and a **canary allocation** filled with a known magic (`CA FE BA BE ...`) is groomed adjacent on the heap, so an OOB read demonstrably crosses a heap-object boundary. Parsed fields — including OOB-derived ones — are echoed back via characteristic updates. `--parse <hex>...` runs the same parser/heap/echo chain direct-fed with attacker payloads (BLE transport bypassed). |
| `attack.swift` | `CBCentralManager` scanning for 0x184B, connecting, discovering 0x2B86, writing the crafted codec-config payloads (mirroring the decompile's `local_97`/`bVar3` relationship), subscribing to 0x2B84/0x2B85/0x2B86 notifications, printing every echoed config and searching for the canary magic. `--print-payloads` emits the canonical payload hex used by the victim's `--parse`. |
| `scanall.swift` | Diagnostic-only unfiltered passive scanner used for the A/B loopback evidence (§4.2 of `static_evidence.md`). |
| `static_evidence.md` | Every attack parameter mapped to decompiled lines + runtime-gate checklist (why `bluetoothaudiod` is not running on this Mac) + the full loopback blocker report and selftest transcript. |
| `selftest_output.txt` | Raw output of the passing direct-feed selftest. |

Build:

```
swiftc -O -o victim_peripheral victim_peripheral.swift
swiftc -O -o attack attack.swift
```

Run over BLE (two processes; needs a real remote peer — see caveats):

```
./victim_peripheral          # terminal 1 (or background)
./attack                     # terminal 2
```

Direct-feed selftest (no BLE needed — proven path used for this phase's verification):

```
P=$(./attack --print-payloads)
./victim_peripheral --parse "$(sed -n 1p <<<"$P")" "$(sed -n 2p <<<"$P")"
# → SELFTEST VERDICT: PASSED — canary magic crossed the heap boundary ...
```

## SAFETY SCOPE (non-negotiable)

- The victim is **our own virtual peripheral running on our own Mac**. It exists
  precisely so the attack always has a legal, always-attackable target.
- The attack tool **never scans-and-attacks third-party peripherals**. It filters
  advertisements to the local victim's local-name marker and 0x184B service, and
  only ever connects to a device advertising our victim marker
  (`LEAUDIO-POC-VICTIM`). Any third-party capture elsewhere in the campaign is
  passive receive-only.
- Nothing here writes to, connects to, or otherwise interacts with hardware we do
  not own and control (lab Macs, team phones).

## Known runtime caveats (all measured, details in `static_evidence.md` §4)

- Same-process loopback is skipped by design (CoreBluetooth will not connect a
  central to a peripheral in the same process).
- Two processes on the **same Mac**: this macOS build does not route a local
  peripheral's advertisements to the local central — A/B scan evidence in
  `static_evidence.md` §4.2. Same-Mac BLE loopback is platform-blocked.
- Two **team Macs** over ssh: works until CoreBluetooth init, then both lab Macs
  (cembook, feza-macbook-air) report `unauthorized` — `kTCCServiceBluetooth` cannot
  be granted remotely (`tccd`-only TCC.db writes; a system LaunchDaemon is also
  denied). Unblock path documented in §4.3.
- Until a TCC-granted remote peer exists, the full bug chain is proven by the
  direct-feed selftest (§5 of `static_evidence.md`): crafted payloads from
  `attack --print-payloads` drive the victim's real parser/heap/canary/echo chain;
  **both** payloads leak the canary magic cross-boundary into the echoed bytes.
- `bluetoothaudiod` itself does not run on this Mac (the enable gate exits — see
  `static_evidence.md` §3), so the rig simulates the vulnerable server rather than
  attacking the real daemon. Attacking the real daemon on our own Macs would
  additionally require enabling LE Audio (dev mode + `defaults write
  com.apple.bluetooth enableHALEAudio -bool true`), which is out of scope for
  this phase.
