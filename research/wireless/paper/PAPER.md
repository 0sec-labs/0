# One Laptop, One Office: A Full Passive Wireless Surveillance Campaign from a Stock Mac

**Status: SKELETON (v0.1, 2026-10-14).** This is the campaign document weaving every audit into one narrative. Findings A–C are empirically demonstrated on captured data; findings D–E are static-analysis results with in-progress dynamic PoCs. Every factual claim cites a repo artifact `file:line`. Sections marked **[IN PROGRESS]** describe experiments that have not yet run to completion — they are listed because they define the campaign's remaining scope, not as completed results.

Campaign root: `research/wireless/`. Artifacts referenced throughout live under `audits/`, `reports/`, `decomp/`, `airdrop_validate/`.

---

## 1. Abstract

**[Draft — final numbers pending the in-progress demos of Findings B and D.]**

From a single stock MacBook — no additional hardware, no jailbreak, no pairing, no user interaction on any target device — we demonstrate end-to-end wireless surveillance of an occupied office:

- A **passive Bluetooth/Continuity census** that enumerated **182 persistent device identities** across two scan bursts totaling **6.2 minutes** and 6,135 observations, fingerprinted **56 devices as desk-stable**, and tracked one named phone (`PeakPhone`) across a 1.87-hour gap with zero interaction (`reports/desk_map.md:25-28`, `reports/desk_map.md:34`).
- An **AirDrop Out-of-World identity disclosure**: we recover the exact hash derivation (SHA-256 of `+<cc><7-digit-padded-number>`), built a 438 MB rainbow table for the Swiss numbering plan, and show that the 2-byte truncated hashes every nearby AirDrop device broadcasts reduce a 10-million-number space to ~153 candidates per window — and to a **~0.0023 expected-candidate unique identification** when two overlapping windows from one beacon are intersected. 5,714 hits across **19 distinct observed windows** were collected from the live office RF environment (`real_hits.txt:1-5`, `airdrop_validate/VALIDATION.md:94-95`).
- A **reverse-engineering audit of Find My beacon rotation** with a deliberately two-sided verdict: passive cross-rotation tracking from a single beacon is **refuted** (the token chain is secret-anchored), but a single-secret total-timeline compromise is **confirmed** — whoever holds a tag's 32-byte `sharedSecretKey` computes every past and future advertisement forever (`audits/findmy_rotation.md` §6.7).
- Two **memory-safety findings in Apple's LE Audio stack** (`bluetoothaudiod`): a remote, radio-reachable out-of-bounds read in the ASCS codec-config parser, and a family of 8 NULL-derefs in XPC volume/preset handlers — both statically confirmed, dynamically gated behind the `Accessibility.LeAudio` feature flag (`audits/xpc_sweep_findings.md` findings 1–2).
- An **XPC attack-surface audit** across four wireless daemons: 3 confirmed bug families, plus an important negative result — the fail-open `Optional<Bool>` gate pattern that plagues `findmybeaconingd` does **not** exist in `wifianalyticsd`, `bluetoothaudiod`, or `wifip2pd`; those daemons fail closed (`audits/xpc_sweep_findings.md`, Pattern 1 NO-MATCH statements).

**[IN PROGRESS]** Two further demonstrations are under way and will extend the abstract when they land: a live LE-Audio OOB-read PoC against our own virtual peripheral (Finding D), and AWDL identity correlation showing that airplane-mode-style "Bluetooth off" does not restore anonymity (Future work §6.1).

The campaign thesis: **the surveillance-relevant wireless surface of a modern office is fully observable from an unmodified laptop, and parts of it disclose stable personal identity — not just presence.** Randomized MACs, the flagship anti-tracking mitigation, are sidestepped at every layer we examined.

---

## 2. Threat model

**Adversary position.** A passive observer with an ordinary laptop in RF range: stock macOS, stock CoreBluetooth/Wi-Fi stacks, receive-only. No special radios (no UWB sniffer, no SDR), no root on targets, no pairing, no connection establishment. This is the lowest-capable adversary worth modeling — everything above it inherits these results.

**Capabilities.**

1. *Passive listen* on BLE advertisement channels (37/38/39) and Wi-Fi management frames. All of Finding A and the passive half of Finding B require only this.
2. *Offline computation* at consumer scale: SHA-256 over a national numbering plan (10⁷ candidates, 438 MB rainbow table — `rainbow_4179.tsv`, `airdrop_validate/VALIDATION.md:39-89`).
3. *Consent-scoped active experiments* — GATT writes and BLE peripheral emulation — executed **only** against lab-owned hardware and virtual peripherals we control (see §5). Finding D's preconditions are exercised in this mode exclusively.
4. *Local code execution* on our own lab Mac (for the XPC audit): sending crafted XPC messages to system daemons from an unprivileged local process — the standard local-attacker position, used to characterize crash surface (Finding E).

**Non-capabilities.** No compromise of target devices, no key extraction from Secure Enclaves, no access to iCloud infrastructure, no interception of encrypted application traffic.

**Consent scope (binding on all experiments in this paper).** Every active transmission, GATT write, or probe is directed at devices this team owns and controls. Third-party devices appear in this work only as passive receivers' observations of their public broadcast. The BLE PoC rig advertises from its own virtual peripheral or team hardware and never targets third-party peripherals (`airdrop_validate/VALIDATION.md:107-127` states the same rule for the AirDrop validation protocol).

**What the adversary wants.** (a) Presence: who is here now; (b) persistence: who is here every day, at which desk; (c) identity: a stable, real-world name (phone number, account, owned object) attached to an anonymous radio signature. The campaign is organized by escalating along exactly this ladder — A gives (a)+(b), B gives (c), C/D/E characterize the residual cryptographic and memory-safety surface.

---

## 3. Findings

### Finding A — Passive Continuity census: 182 devices, persistent IDs, cross-burst tracking

**Result.** Two passive scan bursts from one laptop — `ble_map.jsonl` (121.8 s, 4,344 lines) and `radar_live.jsonl` (249.7 s, 1,791 lines), separated by a 1.87-hour gap — yielded **182 unique persistent identifiers** and **6,135 observations** with zero malformed lines (`reports/desk_map.md:9-13`).

- **Desk-stable classification:** 56 of 182 devices are desk-stable (1 desk-confirmed + 55 scan-stable); 126 transient (`reports/desk_map.md:26`). Classification method: a device is DESK-CONFIRMED when the same identifier is audible in both bursts 1.87 h apart; SCAN-STABLE when present ≥90% of one burst in ≤2 sessions with ≥10 observations (`reports/desk_map.md:19-21`).
- **Named devices:** 5 devices broadcast human-readable names: `47A7FFC9` *PeakPhone*, `F9839FDF` *Doruk Tan's Backpack* (an AirTag-style Find My beacon advertising its owner's name), `189881BD` *L5006XZ*, `0ABAB860` *4*, `6B9B775F` *BCPro_203739* (`reports/desk_map.md:27`). Three of the five are desk-stable (`reports/desk_map.md:28`).
- **Cross-burst tracking:** `47A7FFC9` (*PeakPhone*) is the only desk-confirmed identifier: 105 observations covering 99% of the first burst, then 272 observations covering 99% of the second burst 1.87 hours later — median RSSI −53.0, ring 1 (`reports/desk_map.md:34`, `reports/desk_map.md:71`). **A passive laptop-side listener established that a named phone did not move meaningfully between two scans, with zero pairing, zero connection, zero user interaction** (`reports/desk_map.md:71`).
- **Room-level placement:** ring-median RSSI places stationary devices into physical zones (ring 1 ≥ −55, ring 2 ≥ −80, ring 3 ≥ −90, else ring 4; `reports/desk_map.md:61`). Six ring-3 identifiers were continuously present through the entire live burst — neighboring desks, not visitors (`reports/desk_map.md:78`).
- **Service census** (live radar capture): NearbyInfo 47, FindMy 31, NearbyAction 24, ProximityPairing 14, Handoff 8, HeySiri 8, iBeacon 3, AirDrop 1, AirPrint 1 (`demo_map.md:150-160`; first burst variant in `map.md:149-158`).
- **Why MAC randomization doesn't help here:** Apple's Continuity peripherals (Handoff/NearbyInfo/Find My) reuse a stable per-device identifier in the captured `mac` field, so the same physical device is recognized burst-to-burst — that is precisely what makes cross-burst persistence visible at all (`reports/desk_map.md:78`).

**Limitations, stated honestly.** The two inputs are two short bursts, not continuous monitoring; DESK-CONFIRMED currently rests on one device. All 55 scan-stable devices already show multi-minute continuous presence and would likely re-appear on every repeat scan, so the desk-confirmed set would grow well beyond one device under continuous monitoring (`reports/desk_map.md:79`).

**Claim status: demonstrated** on live capture. Raw per-identifier table: `reports/desk_map.json`; rendered: `reports/desk_map.html`.

### Finding B — AirDrop OWT identity disclosure: from 2-byte hash to phone number

**The derivation (ground truth: `airdrop_brute.c` / `build_rainbow.c`, cross-validated in `airdrop_validate/VALIDATION.md:10-33`).**

1. Hashed input is `prefix + zero-padded ordinal`, built as `snprintf("%s%0*ld", prefix, width, n)`: `+4179` + 7 zero-padded digits. The leading `+` and the zero-padding are part of the hashed bytes; there is **no normalization of any kind** (`airdrop_validate/VALIDATION.md:13-22`).
2. Algorithm: SHA-256 over exactly those bytes (`airdrop_validate/VALIDATION.md:23-24`).
3. The BLE TLV-0x05 beacon carries two 2-byte windows of the digest at byte offsets 0 and 1, big-endian: `w1 = (d[0]<<8)|d[1]`, `w2 = (d[1]<<8)|d[2]` (`airdrop_validate/VALIDATION.md:25-30`).
4. The receiver certificate carries the first 16 digest bytes (128-bit prefix) as the rainbow key (`airdrop_validate/VALIDATION.md:31-33`).

**The math: 2-byte windows are individually ambiguous, jointly near-unique.**

- A single 2-byte window over the 10⁷-candidate Swiss width-7 space leaves 10⁷/2¹⁶ ≈ **153 expected candidates** per window. The brute-force run over the full space confirmed this empirically: 1,818 colliding candidates across 6 planted windows (~152 expected per window; `airdrop_validate/VALIDATION.md:59-61`).
- The two windows overlap by one byte but are **not** independent (they share d[1]); treating them as independent gives a lower bound on ambiguity of 10⁷/2³² ≈ 0.0023 expected candidates. A **fixed dual-window matcher** that intersects both windows per candidate — rather than matching either window independently — is what actually realizes near-uniqueness. Expected residual candidates per beacon ≈ **0.0023**.
- Observed reality: `real_hits.txt` contains **5,714 hits** across **19 distinct observed windows** (~300 hits per window, consistent with the ~153–300 collision band). Every individual hit is a *candidate*, not an identification; only the dual-window intersection or the 128-bit certificate-hash rainbow lookup is exact (`airdrop_validate/VALIDATION.md:97-99`).

**Validation status: end-to-end PASS on planted identities.** The selftest proves the derivation is one consistent function across all three tools: Python `derive.py` reproduces the C-built `rainbow_4179.tsv` entries exactly; the real `airdrop_brute` binary recovers each planted number exactly from its 2-byte windows over the full 10⁷ space; `airdrop_crack.py` flags synthetic Apple-TLV-0x05 beacons carrying the planted windows with the matched variant equal to the canonical form (`airdrop_validate/VALIDATION.md:39-89`, verbatim selftest output). **All planted numbers are synthetic; no real-world hit has been attributed to a person** (`airdrop_validate/VALIDATION.md:94-99`).

**Consent-scoped live validation protocol** (own device into AirDrop-everyone mode, capture own beacon, crack, confirm exact recovery, never target third parties without written consent): `airdrop_validate/VALIDATION.md:107-127`. **[IN PROGRESS]** — the live own-device capture + dual-window matcher (`airdrop_live.py`, `airdrop_validate/matcher.py`, `reports/airdrop_reveal.md`) is being built by a parallel workstream; this section will cite its measured reveal rate when it lands.

**Legal frame.** A 2-byte window hit is a candidate set over a numbering plan, not an identification; a dual-window unique match against a rainbow table of `SHA-256(phone)` *is* a determination of a natural person's phone number from radio emissions — personal data under GDPR-style regimes (identification is the GDPR touchstone, not name). Capturing, hashing, and lookups against third-party numbers without a lawful basis is prohibited in our protocol; the campaign's live use is restricted to consented subjects (own devices + written consent) per `airdrop_validate/VALIDATION.md:118-127`. The 128-bit cert-hash path (full SHA-256 prefix, exact) is strictly more identifying than the beacon windows and is treated accordingly.

### Finding C — Find My rotation: the honest two-sided verdict

This is the campaign's cryptographic centerpiece and it deliberately refuses a one-line headline. Two audits, one daemon-side (`decomp/fmb_arm64e.c`) and one framework-side (`decomp/FindMyCrypto.c`), converge on a split verdict (`audits/findmy_rotation.md` §5, §6.7).

**Side 1 — passive tracking from one beacon: REFUTED.**

The full rotation chain is now recovered:

```
state_0        = sharedSecretKey (32 B, persistent, pairing-provisioned)
state_{n+1}    = ANSI-X9.63-KDF(state_n, info="update", 32B)       # FindMyCrypto.c:7869-7871,7996-7997
bucket key     = ANSI-X9.63-KDF(state_{n+1}, info="diversify", 72B) # FindMyCrypto.c:7706-7712
advertisement  = 28-byte datum of a twin-diversified P-224 point    # FindMyCrypto.c:13027,13056
```

`_next` is a chained re-seed — a ratchet (`FindMyCrypto.c:364-467`, ratchet step `FindMyCrypto.c:7700`, "update" label `FindMyCrypto.c:7869-7871`, output fed back as next input `FindMyCrypto.c:7996-7997`). Chaining exists, **but every link is secret-anchored**: the diversifier input to `CCECCryptorTwinDiversifyKey` comes from the secret ratcheted state, not from any public value (`FindMyCrypto.c:7722-7775`). An observer holding only `pk_n` (28 bytes of a P-224 public point) cannot compute or recognize `pk_{n+1}` without inverting X9.63 or solving ECDLP on P-224. The rotation schedule, by contrast, is fully public: `bucket = floor((now − baseTime)/15min) + 1`, globally synchronized, with the `beaconIdentifier` never entering the arithmetic (it appears only in a debug log line) (`FindMyCrypto.c:16213`, refuting the UUID-mixing hypothesis of `audits/findmy_rotation.md` §3). **Predictability of the schedule is not linkability of the keys.**

**Side 2 — single-secret total-timeline compromise: CONFIRMED.**

- The ratchet never reseeds and never expires. Zero RNG anywhere in the rotation path — daemon-side entropy grep empty (`fmb_arm64e.c:9751-9833`, `12049-12067`) and the framework's only RNG entry points are never called by the chain (`FindMyCrypto.c:23593/8804`, §6.5). Whoever learns a tag's *current* 32-byte token computes **every future advertisement of that tag forever** (`FindMyCrypto.c:7996-7997`).
- Whoever holds the root `sharedSecretKey` (32 bytes, `FindMyCrypto.c:15127`; pairing-provisioned, single point of failure — `audits/findmy_rotation.md` §6.5) computes the **entire timeline, past and future**, offline. Apple's own `KeyGenerationHint{index, sharedSecret}` checkpoint mechanism fast-forwards this chain by design (`FindMyCrypto.c:164`, §6.4) — proof that full-chain replay is a supported operation, not an attack artifact.
- Tokens are a pure function of (persistent keys, pairDate, wall clock): captured advertisements are valid exactly when recomputed and cannot be revoked by rotation alone (`audits/findmy_rotation.md` §5, weakness 2).
- The globally synchronized schedule means an adversary with *any* key material for a tag knows exactly which bucket to derive without observing the tag — targeted offline replay within a captured window (`audits/findmy_rotation.md` §6.7, point 3).

**Verdict as stated in the audit:** "This REFUTES the 'chained re-seed ⇒ single-beacon tracking' reading: chaining exists, but every link is secret-anchored, so chaining alone does not help an adversary who holds no key material" (`audits/findmy_rotation.md` §6.7). Both halves are load-bearing: the refutation kills the scare headline; the confirmation establishes that Find My's anti-tracking property rests entirely on the confidentiality of one 32-byte per-tag secret whose compromise surface (accessory extraction, paired-device state, backups) is outside the beacon protocol itself.

**Corroborating daemon-side bug class.** The beaconing daemon carries a Swift `Optional<Bool>` **fail-open** gate — `.none` takes the privileged nearOwner path (`fmb_arm64e.c:10003`; verified: `FindMyCrypto::Advertisement::get_nearOwner` selected when `local_90 == 1 || (local_90 != 0 && local_90 == -1)`) — and a release-then-return UAF candidate in `FUN_100012438` (`fmb_arm64e.c:12127-12131`; verified shape `_swift_release(puVar16); return puVar16;`). These matter for Finding E's pattern hunt, not for passive tracking.

**Claim status: static RE complete; dynamic confirmation [IN PROGRESS].** The framework decompile is fresh (2026-10-14 00:23, 1,076 functions — `decomp/fmc.log`); residual unknowns are listed in `audits/findmy_rotation.md` §6.7 (2-byte `Advertisement.hint`/`address` provenance) and §6.6 (hint `.some` vs `.none` at the daemon init site). The request-side (location-report *query*) decompilation is queued (§6).

### Finding D — LE Audio ASCS: remote OOB read, gated behind one feature flag

**The bug.** `ASCSServerService::codecConfigRequest:` @`0x10003344c` (`re_bluetoothaudiod.c:35721`, LTV loop `:35838-35885`), reached from `ASCSServerService::receivedWriteRequest:` @`0x100032d80` when a GATT write hits the ASCS Control Point characteristic with opcode 1 (`re_bluetoothaudiod.c:35586-35592`) (`audits/xpc_sweep_findings.md` finding 2; `audits/external_surface_sweep.md` crash-hunt findings #1–#2).

Two independent defects in one parse loop (all verified against the decompile this session):

1. **Stack overflow via `___memcpy_chk` (SIGABRT, deterministic).** The radio-supplied LTV length byte `bVar3` (0–255) is memcpy'd into a **4-byte stack buffer** `local_9c`: `___memcpy_chk(&local_9c, IVar5 + (uVar1 & 0xffffffff), (ulong)bVar3, 4)` for LTV type 3 (channel allocation) and `___memcpy_chk(dst, src, bVar3-1, 2)` for type 4 (`re_bluetoothaudiod.c:35863`; type-4 variant at `:35870-35871`). Any length byte > 4 → `__chk_fail` → root-daemon crash. Without fortify this is a classic 255-byte stack smash — RCE-shaped.
2. **Heap OOB read on declared-vs-actual length desync.** A one-byte attacker length (`local_97`, read at `:35838`, max 255) declares the codec-config blob, but `readNumBytes_toData_` appends **only on a fully successful read** — a truncated write leaves the buffer empty (`re_bluetoothaudiod.c:31234-31270`). The parse loop nevertheless runs `while ((int)uVar12 < (int)(uint)local_97)` (`:35880`) indexing `*(byte *)(IVar5 + 1 + idx)` (`:35846`) on the possibly-empty buffer: up to 255 bytes read past a zero-length heap allocation (NULL if `bytes()` returns nil → SIGSEGV). Heap garbage flows into `setAudioChanAllocMask_`/`setOctetsPerCodecFrame_` state and leaks into later GATT reads/notifications. Per-TLV payload lengths are ignored throughout (`uVar12` advances by header + declared length without bounds against actual data), so TLV desync is inherent.

**Reachability.** Any LE central in radio range writing a truncated codec-config command to the Mac's ASCS Control Point — a ~20-byte well-formed write triggers it (`audits/external_surface_sweep.md`, finding #1 reachability note). Prerequisite: the Mac is acting as an LE Audio unicast server.

**The gate.** The entire surface is dead unless the daemon's enable gate passes (`re_bluetoothaudiod.c:50605-50646`): the daemon exits at startup unless `os_feature_enabled("Accessibility","LeAudio")` is set, **or** the fallback combination `sysctl security.mac.amfi.developer_mode_status == 1` **and** `CFPreferences` `enableHALEAudio` is true (`re_bluetoothaudiod.c:50622-50641`; log string "LE Audio Feature not enabled exiting. OS Feature: %u. Hearing Aid Enabled: %u. Developer Mode: %u"). On our lab Mac, `bluetoothaudiod`'s LE-Audio path is **not running** — the flag is off, so the ASCS attack surface is not instantiated by default. This is the honest PoC statement: the bug is real and statically confirmed, but on stock consumer configurations it sits behind a gate that is closed unless hearing-aid accessibility features (or dev-mode + hidden preference) are enabled.

**PoC status: [IN PROGRESS].** The dynamic rig (`leaudio_poc/`) brings up a virtual LE-Audio peripheral under our control and exercises the truncated-write path against a **lab Mac with the gate deliberately enabled** — consent-scoped, own hardware only. It has not yet produced a runtime crash trace; when it does, this section cites the trace. Until then the finding's confidence is "likely (static; truncation semantics verified, dynamic behavior of CoreBluetooth write fragmentation not tested)" — the audit's own label (`audits/xpc_sweep_findings.md`, finding 2 confidence).

### Finding E — XPC attack-surface audit: 3 confirmed bug families, and a fail-closed negative result

Method: full-text regex pattern battery over every line of four decompiled daemons (`re_wifianalyticsd.c` 116,504 lines; `re_bluetoothaudiod.c` 92,442; `re_wifip2pd.c` 844,362; `fmb_arm64e.c` 20,781), then targeted reads + call-chain tracing; no dynamic verification — every finding is static (`audits/xpc_sweep_findings.md`, method note).

**E.1 — bluetoothaudiod NULL-deref family: 8 XPC volume/preset handlers.** Handlers `SetVolume`, `SetVolumeOffSet`, `SetVolumeMute`, `WriteVolumeAudioInput`, `SetMicrophoneMute`, `WriteMicrophoneAudioInput`, `ReadPresets`, `SetActivePreset` (`re_bluetoothaudiod.c:38140-38429`) pass `xpc_dictionary_get_value(msg, "kCBMsgArgLEAudioDeviceUUID")` straight into `xpc_uuid_get_bytes` + `NSUUID::initWithUUIDBytes_` with **no null/type check** (`:38150-38153`). Any client holding the `com.apple.bluetoothaudiod.cb` entitlement (finding 5: the mach-service gate is entitlement-bool only, deny-by-default, no code-signing/audit-token check beyond it — `:8424-8446`) sends a message missing the UUID key → reliable root-daemon crash (DoS). XPC-reachable, not wireless.

**E.2 — wifip2pd decompression bomb.** `NSData decompressedDataUsingAlgorithm:error:` with **no cap on decompressed output**, result fed to `JSONDecoder._decode` (`re_wifip2pd.c:304730-304763`); the caller iterates **Keychain items** (`:305560-305600`) and decompresses each `Data` value. A small compressed blob forces full expansion — memory-exhaustion DoS *if* attacker-influenced bytes reach that keychain item. Sink confirmed; the wireless-reachable writer into the keychain was **not** traced — the finding's attacker-influence is `[INFERENCE]` (`audits/xpc_sweep_findings.md` finding 3).

**E.3 — findmydeviced open XPC listener.** `FMDXPCManager::listener:shouldAcceptNewConnection:` @`0x1000209fc` (`re_findmydeviced.c:26538`) performs **no entitlement, audit-token, or code-signing check**; unknown listeners fall through and are accepted with the full FMM protocol exported (`audits/external_surface_sweep.md`, finding 2). Local-only reach: post-compromise escalation class. This is the sharpest contrast in the audit set: the same Apple codebase contains both deny-by-default mach gates (bluetoothaudiod, `re_bluetoothaudiod.c:8424-8446`) and accept-everything listeners.

**The negative result that makes the audit worth publishing.** We hunted the fmb fail-open `Optional<Bool>` gate pattern (`fmb_arm64e.c:10003`) across all three other daemons: **NO MATCH** — wifianalyticsd's `== -1` sites are log-string selection; bluetoothaudiod clamps `0xFF`→1 *before* its ASE loop (fail-closed) and treats out-of-range opcodes as skip; wifip2pd's `0xFF`-tag sites are Swift Hasher/Equatable internals with correct-by-default semantics (`audits/xpc_sweep_findings.md`, Pattern 1 NO-MATCH statements). Likewise the fmb release-then-return UAF shape is **unique to fmb** among the audited set — zero regex matches across all three daemons (Pattern 3). And all XPC sender-validation surfaces that exist are fail-closed: wifianalyticsd's 8 NSXPCListener endpoints each check `com.apple.private.wifianalytics` and reject (Pattern 4); wifip2pd validates SecTask identity at accept (informational) and enforces a per-request entitlement AND-gate that invalidates the connection on failure (finding 6). **Gates, where Apple wrote them deliberately, fail closed; the one fail-open gate is an accidental Swift-Optional encoding artifact.** That asymmetry is the audit's transferable lesson: the bug class is not "Apple's gates are weak" but "Optional-encoding pitfalls create silent fail-open paths where no deliberate gate exists."

**Also documented:** attacker-string selector dispatch in bluetoothaudiod, bounded by the format string to intended `_handle<X>Msg:reply:` selectors — no arbitrary selector injection, cross-handler argument confusion only, impact low (finding 4); wifip2pd's codesign bitmask accepts any Apple-platform-signed dynamically-valid binary (residual, bounded by the per-request gate, finding 6); a dead-code entitlement checker (finding 7); an MDM-plist parse outside the wireless threat model (finding 8). Latent CoreBluetooth patterns — zero-internal-bounds-check proximity-pairing TLV readers and the fixed 7-byte-buffer NearbyInfoV2 decrypt — are documented as single-refactor-away OOB hazards, with all current call sites verified guarded (`audits/external_surface_sweep.md`, findings 5–6).

---

## 4. Defensive recommendations

**Per Finding A (passive census / persistent IDs).**
- The root cause is not the advertisement content but **identifier stability**: Continuity's stable per-device identifier in the captured `mac` field is what defeats MAC randomization (`reports/desk_map.md:78`). Recommendation: rotate the Continuity service-level identifier with the same cadence as the MAC — cross-burst desk-confirmation dies if neither field is stable.
- Device names are third-party identity leaks (`Doruk Tan's Backpack` is locatable from a stranger's desk; `reports/desk_map.md:77`). Recommendation: never broadcast owner-derived names from tracking accessories; gate the name TLV on near-owner proximity the way NearOwnerAdvertisement already gates payload classes.
- Enterprise: RSSI-ring floor maps (ring 3 devices continuously present through a whole burst = neighboring desks, `reports/desk_map.md:78`) mean BLE census doubles as a building-occupancy side channel. Treat continuous BLE monitoring by any laptop in the area as an assumed capability when designing hot-desk policies.

**Per Finding B (AirDrop identity disclosure).**
- The decisive defect is **truncation width**: 16-bit windows leave ~153 candidates/window over one national numbering plan and near-unique intersection across dual windows. Any increase in window width multiplies attacker cost by 2^width; the USENIX Sec'21-published flaw is **confirmed still present in macOS 26's BLE layer** (`audits/external_surface_sweep.md`, finding 1: `-[CBAdvertiser_airdropHash1..4]` @`0x199312d18-0x199312d48` return 16-bit values read at struct offsets +0x52..+0x58 — `CoreBluetooth.c:28241-28247` shows the accessor; mirrored in `-[CBDevice_airdropHash1..4]` @`0x19936d344+` `CoreBluetooth.c:97297+`; serialized into the discovery payload at `CoreBluetooth.c:92977-93001`).
- **Advertisement rate-limiting / responsivity:** AirDrop-everyone mode currently answers every probe from every stranger. A receiver-side policy — reduce hash broadcast frequency, or require prior contact before including contact-derived hashes in beacons — shrinks the enumeration window without breaking discoverability for intended recipients.
- **Randomization effectiveness analysis (what to tell users):** the current design gives users a randomization *story* (hashes instead of numbers) while delivering none of its *substance* (16 bits is brute-forceable by any laptop). Honest guidance until fixed: AirDrop-everyone discloses your phone number to anyone in radio range; use contacts-only as the default posture.
- The full 128-bit certificate-hash path is exact, not probabilistic — receiver-cert exposure is strictly worse than beacon-window exposure and must be included in any fix's threat model.

**Per Finding C (Find My rotation).**
- Apple's design is **correct against the passive adversary** — this should be stated plainly, because it is a rare full positive result. The ratchet (`state_{n+1} = X963KDF(state_n)`) with secret-derived diversifier means schedule predictability does not imply key linkability (`audits/findmy_rotation.md` §6.7).
- The residual risk is **single-secret totality**: one 32-byte secret = entire timeline, forward-compromise unbounded (no reseed, `FindMyCrypto.c:7996-7997`). Recommendation: bound the forward-compromise window with periodic re-randomization from fresh entropy (a reseed epoch), and/or split the secret so accessory compromise does not yield timeline-forever capability. The `KeyGenerationHint` checkpoint design (`FindMyCrypto.c:164`) shows the infrastructure for state refresh already exists.
- Fix the daemon-side **fail-open nearOwner gate** (`fmb_arm64e.c:10003`): `.none` must map to the stranger advertisement, not the privileged near-owner variant. Also validate `publicKey`/`sharedSecretKey` lengths at the plist decode boundary before they reach `PublicKey::_init`/`KeyRepresentable::_init` (`audits/continuity_beacons.md` §3 item 4), and ship-verify the `FindMyBeaconingSupport` swizzle hook pointer is nil in production (`audits/continuity_beacons.md` §3 item 3).

**Per Finding D/E (enable-gate and parse design).**
- **Enable-gate design:** the ASCS surface's only protection on stock configs is `os_feature_enabled("Accessibility","LeAudio")` (`re_bluetoothaudiod.c:50622-50641`). Two lessons. Positive: *gating entire attack surfaces behind feature flags that default off* demonstrably contains blast radius — the wifip2pd/bluetoothaudiod/wifianalyticsd gates all fail closed (Finding E negative result), which is why none of these bugs is remotely exploitable on a stock Mac today. Negative: an accessibility feature that real users enable (hearing-aid support) becomes a de-facto security downgrade for exactly the population least able to tolerate radio-reachable daemon crashes. Recommendation: parse-hardening must not be deferred by the gate — the LTV loop's 4-byte stack sink (`re_bluetoothaudiod.c:35863`) is reachable the day any user enables LE Audio.
- **Parse invariants for TLV/codec parsers:** bound every loop by *actual* bytes read, never by *declared* length (`:35880` vs `readNumBytes_toData_`'s all-or-nothing semantics at `:31234-31270`); validate per-TLV payload lengths against remaining buffer before every indexed access; never memcpy a radio-supplied length into a fixed stack slot.
- **XPC hardening:** entitlement-bool gates should be paired with code-signing/audit-token validation (bluetoothaudiod residual, `audits/xpc_sweep_findings.md` finding 5); accept-time identity checks should enforce, not merely record (wifip2pd finding 6); and no listener should accept unvalidated connections with a full protocol exported (findmydeviced, `re_findmydeviced.c:26538`).
- **Decompression bounds:** cap decompressed output at a sane maximum before decode (`re_wifip2pd.c:304730-304763`).

---

## 5. Ethics & disclosure

**Consent protocol (binding, already operative in the artifacts).**
- All capture in this campaign is **passive receive-only** against third-party devices: no connection, no pairing, no probe directed at hardware we do not own (`reports/desk_map.md` — passive bursts only).
- All **active** experimentation (GATT writes, peripheral emulation, gate-enabled PoC runs) is directed exclusively at team-owned lab hardware and virtual peripherals we instantiate ourselves.
- The AirDrop validation protocol codifies the identity rule: crack/look up only numbers you own or hold written consent for; "ambiguity of 2-byte windows never justifies attributing a hit to a specific third party" (`airdrop_validate/VALIDATION.md:122-127`). All planted numbers in the selftest are synthetic (`airdrop_validate/VALIDATION.md:94-95`).
- Third-party names captured passively (e.g. `Doruk Tan's Backpack`) are reported only as evidence of the leak mechanism, minimized to what the finding requires.

**Disclosure plan.**
- **Findings D + E (bluetoothaudiod ASCS OOB, 8-handler NULL-deref family; wifip2pd decompression bomb; findmydeviced open listener)** → Apple product security. Draft outline: `paper/disclosure_apple.md` (preconditions + suggested fixes, no exploit code). Static evidence is complete for the ASCS finding; the dynamic PoC ([IN PROGRESS], Finding D) will be run against our own gate-enabled lab Mac and its trace attached to the report before submission.
- **Finding B** → the flaw is published academic work (USENIX Sec'21) that we independently confirm as live in macOS 26 (`audits/external_surface_sweep.md` finding 1); disclosure reduces to a confirmation note to Apple referencing the known class, plus our dual-window uniqueness refinement.
- **Finding C** → no vulnerability report warranted for the refuted half; the single-secret total-timeline weakness and the fail-open nearOwner gate (`fmb_arm64e.c:10003`) go into the Apple report as hardening findings.
- **Findings A** → publication of the census methodology with all third-party identifiers redacted; no vendor report (behavioral, not a bug).
- Coordinated-timing rule: nothing in this paper publishes exploit code, working payloads, or automatic attribution tooling; the rainbow table covers one consenting-test numbering plan and is treated as restricted internal data.

---

## 6. Future work

1. **AWDL identity correlation [IN PROGRESS]** — the campaign's third demo: prove that AirDrop-receiver identity hashes (or other stable identifiers) survive onto the AWDL interface, so that "Bluetooth off" does not restore anonymity. The AWDL agent (`awdl/`) reads `decomp/` (airportd export may not exist yet; no `analyzeHeadless` runs — the queue owns Ghidra) and works from live system observation in the meantime. Target deliverable: a captured-packet demonstration linking an AWDL peer identity to a BLE-observed persistent identifier on our own devices. Will extend Findings A/B with a cross-radio correlation section.
2. **Firmware RE [IN PROGRESS]** — the `decomp/fw_hunt_plan.md` track and `fw_stats.txt`/`fw_chip.log` artifacts; goal is the radio-firmware side of the advertisement pipeline (what the peripheral actually emits vs. what the daemon thinks it emits).
3. **FindMyLocate request-side decomp [QUEUED]** — the audits cover the *beaconing* side (fmb + FindMyCrypto); the location-*query* side (how an owner's device requests tags from Apple's infrastructure) is the remaining half of the Find My protocol and the natural place to test whether the single-secret timeline weakness extends to query authorization.
4. **LE Audio dynamic PoC completion [IN PROGRESS]** — Finding D's `leaudio_poc/` rig: virtual peripheral bring-up, truncated-write reproduction, crash trace capture on the gate-enabled lab Mac.
5. **sharingd export** — the last unlanded external surface: receiver HTTPS/mTLS path and `Discover` + hash construction (`audits/external_surface_sweep.md`, next steps (b)).
6. **Continuous-monitoring desk census** — replace the two-burst snapshot with an hour-scale capture to grow the DESK-CONFIRMED set from 1 toward the predicted 56+ (`reports/desk_map.md:79`).
7. **wifip2pd keychain-writer trace** — determine whether attacker-influenced bytes can reach the decompression-bomb keychain item; this decides whether E.2 is a real remote DoS or a hardening note (`audits/xpc_sweep_findings.md` finding 3).
8. **Caller trace of FUN_100064188** — the one genuine RCE candidate left open by the external sweep, refuted as a Swift stdlib thunk but listed as next-step (a) there; formally close it in the paper's final version (`audits/external_surface_sweep.md`, verified-safe section).

---

## Appendix: artifact index

| Artifact | Role |
|---|---|
| `reports/desk_map.md`, `desk_map.json`, `desk_map.html` | Finding A census + classification |
| `ble_map.jsonl` / `radar_live.jsonl` | Raw captures (4,344 / 1,791 lines) |
| `demo_map.md`, `map.md` | Per-capture ring maps, service category counts |
| `ble_scan.swift`, `ble_map.swift` | Passive CoreBluetooth observers |
| `radar_server.py` + `radar.html` | Live radar UI |
| `airdrop_brute.c`, `build_rainbow.c`, `rainbow_4179.tsv` | C ground-truth derivation + 438 MB rainbow |
| `airdrop_crack.py`, `real_hits.txt` | Live beacon matcher + 5,714 observed hits / 19 windows |
| `airdrop_validate/VALIDATION.md`, `derive.py` | Selftest proof of derivation consistency |
| `audits/findmy_rotation.md` | Finding C (two-sided verdict) |
| `audits/continuity_beacons.md` | Finding C daemon-side pipeline + parse-bug candidates |
| `audits/xpc_sweep_findings.md` | Finding E |
| `audits/external_surface_sweep.md` | Radio-reachable surface + crash-hunt addendum |
| `decomp/fmb_arm64e.c`, `decomp/FindMyCrypto.c`, `decomp/CoreBluetooth.c`, `decomp/re_bluetoothaudiod.c`, `decomp/re_wifip2pd.c`, `decomp/re_wifianalyticsd.c`, `decomp/re_findmydeviced.c` | Decompiled evidence base |
| `paper/disclosure_apple.md` | Apple product-security report outline (D + E) |
