# External attack-surface sweep — Mac wireless stack (macOS 26.2, arm64e)

Four parallel audits over the decompiled external-facing stack. Radio-reachable = any nearby device; network-reachable = any peer on LAN/AWDL.

## CONFIRMED findings

### 1. AirDrop contact hashes still 16-bit truncated — the PrivateDrop flaw is live in macOS 26
- **Class**: information disclosure / contact enumeration. **Reach**: radio (passive, any nearby scanner).
- `-[CBAdvertiser_airdropHash1..4]` @ 0x199312d18-0x199312d48 return `undefined2` (16-bit) at offsets +0x52..+0x58; mirrored in `-[CBDevice_airdropHash1..4]` @ 0x19936d344+; compared field-by-field in the discoverability matcher (CoreBluetooth.c:25799-25887); serialized into the discovery payload (CoreBluetooth.c:92977-93001).
- An off-device adversary enumerates the entire 2^16 hash space offline and learns whether a receiver would accept files from any given contact. Published as broken in USENIX Sec'21 — **confirmed still present** in this build's BLE layer. (Receiver HTTPS/mTLS path: sharingd not yet exported — open.)

### 2. findmydeviced XPC listener accepts every connection — no sender validation
- **Class**: missing XPC sender authorization. **Reach**: local processes (mach service), not radio.
- `FMDXPCManager::listener:shouldAcceptNewConnection:` @ 0x1000209fc (re_findmydeviced.c:26538-26630): no entitlement, audit-token, or code-signing check; unknown listeners still fall through and are accepted (return 1) with the full FMM protocol exported. Contrast: bluetoothaudiod/wifianalyticsd deny-by-default.

### 3. wifip2pd NAN follow-up length validation is mod-2^16
- **Class**: validation bypass (logic/DoS). **Reach**: Wi-Fi peers (NAN).
- `FUN_10005d53c` @ 0x10005d53c (re_wifip2pd.c:74860): compares a stored 16-bit payload length against the 64-bit Data count as `(uint)(ushort)len == (count & 0xffff)` — a peer sending a payload 65536 bytes larger than expected passes validation. Downstream slices are Swift-precondition-trapped, so no direct corruption; impact is oversized-payload feed to downstream parsing.

## RCE-candidate class (unproven, needs caller trace)

### 4. wifip2pd memmove with sign-check-only guard
- `FUN_100064188` @ 0x100064188 (re_wifip2pd.c:81384): `_memmove(ctx+0x28, param_1, param_2)` guarded only by `param_2 >= 0` — no destination-capacity check in the decompiled body. Swift closure trampoline; the allocating caller was not locatable in the stripped export. **If** any caller pairs a remote-derived count with a smaller destination, heap overflow. Radio-reachability unproven — the highest-value next trace.

## Latent (no live bug; single-point-of-failure patterns)

### 5. CoreBluetooth proximity-pairing TLV readers: zero internal bounds checks
- `-_parseProximityPairingStatus1/PID2/Color1/Misc1` @ 0x199379558-0x19937960c (CoreBluetooth.c:108205-108330): cursor-dereference readers with no ptr-vs-end validation inside; safety depends 100% on the four call sites pre-checking remaining length. All current call sites verified guarded (WxSetup/WxStatus/AirPodsMismatched/V2). One future refactor that drops a guard = advertisement-triggered OOB read. Radio-reachable surface by design.

### 6. CoreBluetooth NearbyInfoV2 decrypt: fixed 7-byte stack buffer, caller-pinned lengths
- `-[CBDevice_decryptNearbyInfoV2PayloadPtr:...]` @ 0x1993a1b6c (CoreBluetooth.c:139775+): clamps radio-derived key length to 7, `memcpy_chk` into 7-byte stack pair, then `_memcpy(param_7, &stack, param_4)` into caller slots only 1-4 bytes wide. Safe today only because all 3 callers pin the length (==1/==2/==5 checks). Also feeds `cclr_aes_init` with ≤56-bit key sizes.

## Verified-safe (documented answers)

- **GATT long-write reassembly** (`-[CBPeripheralManager_handleSetAttributeValues:]` @ 0x19935d7fc): remote centrals CAN issue multi-part ATT writes; offset-desync impossible (endOffset check), NSMutableData append-only reassembly, no raw buffer writes — **no memory-safety defect**.
- **FindMyCrypto decryptAndValidate** (CloudKit location reports): ECDSA→AES via Security framework, no manual pointer math.
- **FindMyCrypto has NO raw beacon parser** — encode-only; the radio-byte parse surface is CoreBluetooth.c (audited above).

## Find My crypto chain (from FindMyCrypto.c — the real bodies)

- **Cross-rotation tracking from one beacon: NO.** `TokenSequence._next` is gated by the tag's SharedSecretKey (ratchet via `CCDeriveKey` update); an observer with one advertisement cannot derive future tokens.
- **But: anyone holding a tag's root public key can derive ALL bucket public keys.** Diversification is ANSI-X9.63 KDF with label ASCII `"diversify"` (9 bytes), 72-byte output, `CCECCryptorTwinDiversifyKey` — twin diversify applies the same public diversifier to the private scalar and public point; pub-side derivation needs no private key. Bucket index = pure UUID+Date arithmetic (no secret branching).
- **Advertisement layout recovered**: 28 bytes = P-224 x-coord + 6-byte MAC address + 1-byte hint; PublicKey = 57-byte uncompressed P-224 point.


## Crash-hunt addendum (LE Audio + event dispatcher + crypto chain)

### CONFIRMED CRASH BUG (High confidence): ASCS codec-config LTV parser stack overflow — `bluetoothaudiod`

`ASCSServerService::codecConfigRequest` @ 0x10003344c (re_bluetoothaudiod.c:35721, LTV loop :35843-35895):
- Radio-supplied LTV length byte `bVar3` (0-255) is `___memcpy_chk`'d into a **4-byte stack buffer**: `___memcpy_chk(&local_9c, src, bVar3, 4)` for type=3 (channel-allocation), `___memcpy_chk(dst, src, bVar3-1, 2)` for type=4 (octets-per-frame).
- Any length byte > 4 → `__chk_fail` → **deterministic SIGABRT of `bluetoothaudiod`** (root daemon). Without fortify, this is a classic 255-byte stack smash — RCE-shaped.
- **Reachability**: LE Central GATT write to the Mac's ASE Control Point (ASCS unicast server) → `peripheralManager:didReceiveWriteRequests:` → `codecConfigRequest`. A ~20-byte well-formed write triggers it. Prereq: LE Audio peripheral/server role active.

**Finding #2 (same function, HIGH on OOB, MEDIUM observability)** — declared-vs-actual length mismatch: loop bounded by the *declared* LTV length (≤255) while `readNumBytes:toData:` returns empty on short supply → up to 255 unguarded heap OOB reads from `IVar5[offset]`, memcpy'd from OOB → SIGSEGV at allocation boundary + **heap garbage flows into `setAudioChanAllocMask_`/`setOctetsPerCodecFrame_` state → leaks into later GATT reads/notifications**.

**Finding #3 (MEDIUM-HIGH)** — CSIS short-SIRK: characteristic <17 bytes → `getBytes:length:16` on empty NSMutableData → `NSRangeException` → daemon abort (or 16-byte heap OOB read cached/logged as `SirkInDevCache`). Reachable by any attacker GATT server posing as an earbud: the Mac *subscribes automatically during CSIS discovery*.

**Finding #4 (MEDIUM)** — CSIS encrypted-SIRK path: `pairingInfo[RemoteLTK]` nil → `bytes(nil)` → NULL deref `*plVar7` → SIGSEGV on links without LTK.

### NEGATIVE RESULTS (equally important)
- **wifip2pd event dispatcher**: all 224 cases mapped; every decode wrapper (`FUN_10005e2c0`..`FUN_10005f340`) validates Swift Data count vs compile-time struct size; all memcpy sizes are compile-time constants into fixed stack structs. No driver-supplied length reaches any memcpy. Only finding: a **trust boundary** (userspace trusts kernel-claimed length — needs a kernel bug to matter) + a 0x30 stride-loop DoS trap. Clean.
- **FindMyCrypto chain**: ECDSA→AES decrypt fully checked (attacker lengths → clean CryptoError throws); KDF degenerate inputs throw; `P256PrivateKey.random` hard 32-byte check, no weak fallback; NearOwner encode never takes radio lengths. Clean.
- **RCE candidate FUN_100064188**: refuted (Swift stdlib withUTF8 thunk; all 17 call sites validate count<0x100 into 256-byte buffers).
- **NAN mod-2^16 bypass**: refuted (compiler artifact behind hard bounds check) + unreachable (no NAN on Mac drivers — confirmed via 6h log sweep: only DRIVER_AVAILABLE events).
| # | Finding | External? | Exploitable? |
|---|---|---|---|
| A | ASCS codec-config LTV: `___memcpy_chk` radio-length into 4-byte stack local → SIGABRT + heap-OOB-read-to-state | Bonded/encrypted peer only; LE Audio server role non-default | ✅ CONFIRMED (gated) |
| B | PACS accumulator mod-256 infinite loop → 100% CPU hang | Bonded peer, notification-driven | ✅ CONFIRMED (gated) |
| C | CSIS short-SIRK → `getBytes:length:` → NSRangeException crash | Bonded peer | ✅ CONFIRMED (gated) |
| D | wifip2pd trust boundary (userspace trusts kernel-claimed length) | Needs kernel bug | Latent |
| 1 | 2-byte AirDrop contact hashes | Radio, passive | ✅ CONFIRMED |
| 5/6 | CoreBluetooth proximity/decrypt latent patterns | Radio, if guards regress | Latent |

## Reachability closure (bluetoothaudiod ASCS bug)

**Three gates, all verified from source:**
1. **Feature gate**: LE Audio/hearing-aid feature must be enabled (non-default; on stock Macs the daemon `exit(0)`s before publishing ASCS — confirmed by 24h log sweep: bluetoothaudiod never launched on this Mac).
2. **Role gate**: daemon must run `leAudioRole=server` — only then is ASCS published (per `ServerCommonAudioProfile::addService` chain).
3. **Encryption gate**: ASE Control Point `permissions=0x22` (WriteEncrypted|WriteWithoutResponse) — enforced by bluetoothd's GATT server *pre-callback* (CoreBluetooth maps the ATT errors; framework and daemon add no link check of their own). Unbonded attacker cannot reach the parser at all.

**Net: not a zero-interaction drive-by. Real but gated** — reachable by any bonded peer (Just-Works pairing suffices; encryption w/o MITM) on a LeAudio-enabled machine. Severity: crash + ≤4-byte heap OOB read into GATT-observable state, root daemon. Bounty-class: report as such.

## Pattern sweep results (the full method)

- **ASCS server, every other opcode** (qos/enable/startReady/disable/stopReady/updateMetadata/release/release — :35580-35628 dispatch): CLEAN. DataInputStream-only, fixed-width reads, no raw-pointer LTV loops. codecConfigRequest is the *only* instance of the bug pattern in the server.
- **Client-side parsers** (handleASEUpdate/handleCodecConfigured/handleQoS/handleEnabling, PACS/TBS/MCS): CLEAN — every read bounds-checked stream reads; declared-vs-actual mismatches cause misparse only, never OOB.
- **CoreBluetooth framework**: entire manufacturer-data parser surface swept (17 TLV types + sub-parsers): the dispatcher validates EVERY element pre-dispatch (`length & 0x1f` bounds-checked vs remaining buffer — exactly the check bluetoothaudiod's LTV loop lacks). One memcpy in the whole surface, pre-clamped. SAFE.
- **`readNumBytes:toData:`** itself is self-clamping (dynamic alloca capped by actual stream data); the bug is purely the *unchecked raw-pointer walk after the safe read* + the unclamped memcpy length.
- **Negative results**: wifip2pd 224-case dispatcher clean (all memcpy sizes compile-time constants); FindMyCrypto chain clean; wifivelocityd/wifianalyticsd/findmydeviced no raw-length memcpy sites.
|---|---|---|---|
| 1 | 2-byte AirDrop hashes | Radio, passive | Yes — contact enumeration (the published flaw, confirmed current) |
| 3 | NAN length mod-2^16 bypass | Wi-Fi peers | Yes — validation bypass/DoS-class |
| 4 | wifip2pd memmove | If radio-reachable caller exists | Unknown — needs caller trace (next step) |
| 2 | findmydeviced open XPC | Local only | Post-compromise escalation |
| 5/6 | CoreBluetooth latent OOBs | Radio, if guard regressed | Latent |

**Next steps**: (a) trace callers of FUN_100064188 (the one genuine RCE candidate); (b) export sharingd (receiver mTLS /Discover + hash construction) — the last unlanded external surface; (c) airportd export (running) for AWDL action-frame parsing.
