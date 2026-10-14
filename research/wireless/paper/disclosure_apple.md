# Draft outline — Apple Product Security report

**Status: DRAFT OUTLINE.** No exploit code, no working payloads, no automated attribution tooling is included here or will be included in the submission. All findings are from static reverse engineering of decompiled system daemons on our own lab Mac (macOS 26.2, arm64e); dynamic confirmation of D.1 is in progress on consent-scoped, team-owned hardware. Line references are to our local decompiler exports; we will re-map them to official binary offsets/versions before submission.

Proposed submission split: this covers one report with three attached findings (same subsystem family: wireless daemons), or three separate reports if Apple's triage prefers per-daemon scoping.

---

## Finding 1 — bluetoothaudiod: heap OOB read in ASCS codec-config TLV parser (radio-reachable)

**Component:** `bluetoothaudiod` (Bluetooth LE Audio daemon), `ASCSServerService`.
**Class:** CWE-125 (out-of-bounds read) / CWE-1284 (improved: input length validated against declared, not actual, bytes) — plus a related CWE-121 stack-write variant, see 1b.
**Reach:** remote, radio — any LE central in range that can write to the Mac's GATT server (prerequisite: LE Audio enabled on the target; see "Enable-gate context").

### Evidence (static, decompiled)

Function `ASCSServerService::codecConfigRequest:` @ `0x10003344c` (`re_bluetoothaudiod.c:35721`), LTV loop at `:35838-35885`. Reached from `ASCSServerService::receivedWriteRequest:` @ `0x100032d80` when a GATT write arrives on the ASCS Control Point characteristic with opcode 1 (`:35586-35592`).

Defect A (heap OOB read): the parser reads a one-byte declared length (`local_97`, ≤255) and requests that many bytes via `DataInputStream::readNumBytes_toData_` (`:31234-31270`). That helper appends to the NSMutableData **only on a fully successful read**; on a truncated write the buffer stays empty. The parse loop nevertheless bounds itself by the *declared* length (`while ((int)uVar12 < (int)(uint)local_97)` at `:35880`) and indexes the possibly-empty buffer (`*(byte *)(IVar5 + 1 + idx)` at `:35846`), then `___memcpy_chk(&local_9c, IVar5 + idx + 2, len, 4)` (`:35863`). The `___memcpy_chk` fortify guard bounds the 4-byte *destination*, not the OOB *source*. Result: up to 255 bytes read past a zero-length heap buffer (SIGSEGV if `bytes()` returns nil), and heap-adjacent data flows into `setAudioChanAllocMask_` / `setOctetsPerCodecFrame_` ASE state — i.e., OOB-read-influenced values are stored and observable in later GATT reads/notifications.

Defect B (related stack-write): for LTV types 3 and 4, a radio-supplied length byte drives `___memcpy_chk` into a **4-byte stack slot** (`local_9c`) with the fortify bound computed from the *destination* size while the copy size comes from the attacker byte (`:35863` and the type-4 variant at `:35870-35871`); any LTV length > 4 aborts via `__chk_fail` (deterministic SIGABRT of a root daemon). Without hardening this is a 255-byte stack smash. We report the observable abort as the confirmed behavior; the unhardened stack-smash path is inferred from the decompile, not demonstrated.

Also noted in the same handler family: per-TLV payload lengths are never validated against remaining data (the cursor advances by header + declared length regardless), so TLV desync is inherent to the parser, not an edge case.

### Reproduction preconditions (described; no payload)

1. Target Mac with LE Audio enabled (see gate below). Attacker: any BLE central in radio range.
2. Connect as a central to the Mac's LE Audio GATT server (peripheral/server role active).
3. Perform a single ATT write to the ASCS Control Point characteristic containing a codec-config command (opcode 1) whose declared LTV length exceeds the bytes actually delivered, or whose LTV type-3/type-4 length byte exceeds 4.
4. Expected observable: `bluetoothaudiod` crash (SIGABRT via `__chk_fail` for defect B; SIGSEGV/heap OOB read for defect A) — we will attach the crash trace from our consent-scoped lab reproduction before submission.

### Enable-gate context (honest scoping)

The daemon gates its entire LE-Audio surface at startup (`re_bluetoothaudiod.c:50605-50646`): it exits unless `os_feature_enabled("Accessibility","LeAudio")` is true, or the fallback (`security.mac.amfi.developer_mode_status == 1` **and** the `enableHALEAudio` preference) is satisfied. On stock configurations the gate is closed and this surface is not instantiated. We flag this so severity can be triaged correctly — but note that the gate is an *accessibility* feature that real users enable for hearing aids, so the exposure is real for that population, and the parser defect is one flag away on every build.

### Suggested fixes

- Bound the parse loop by **actual** bytes available in the received data, never by the declared length alone; treat short reads as a parse error (reject the request) instead of proceeding with an empty buffer.
- Validate each TLV's payload length against remaining buffer before every indexed read/memcpy.
- Reject (not clamp) LTV length bytes that exceed the fixed destination size, rather than relying on fortify to abort.
- Consider a single shared "parse LTV sequence with bounds checking" helper so the invariant is enforced once.

---

## Finding 2 — bluetoothaudiod: NULL-deref in 8 XPC volume/preset handlers

**Component:** `bluetoothaudiod`, `LEAudioXPCSession` message handlers.
**Class:** CWE-476 (NULL pointer dereference).
**Reach:** local — any process holding the `com.apple.bluetoothaudiod.cb` entitlement. Not radio-reachable.

### Evidence (static, decompiled)

Eight handlers — `SetVolume`, `SetVolumeOffSet`, `SetVolumeMute`, `WriteVolumeAudioInput`, `SetMicrophoneMute`, `WriteMicrophoneAudioInput`, `ReadPresets`, `SetActivePreset` (@ `0x100035ef4`, `0x100035fd8`, `0x1000361c4`, `0x1000362c8`, `0x1000364b4`, `0x1000365b8`, `0x1000367a4`, `0x10003685c`; `re_bluetoothaudiod.c:38140-38429`) — read `xpc_dictionary_get_value(msg, "kCBMsgArgLEAudioDeviceUUID")` and pass the result directly to `xpc_uuid_get_bytes` and `NSUUID::initWithUUIDBytes_` with no null/type check (`:38150-38153` is the representative site). A message omitting the key (or carrying a non-UUID type) yields `xpc_uuid_get_bytes(NULL)` → NULL dereference / undefined behavior inside NSUUID init.

Dispatch context: `LEAudioXPCSession::handleMsg:` builds selectors from the attacker-controlled `kCBMsgId` string but the `"_handle%@Msg:reply:"` format pins prefix/suffix, so only the intended handlers are invocable (`:38095-38106`) — this confines the bug to the 8 handlers above; no arbitrary selector injection.

Connection gate context: the mach service requires the entitlement as a boolean true and cancels otherwise — deny-by-default, correct shape (`:8424-8446`). The residual gap (no code-signing identity/audit-token check beyond the entitlement) is reported as hardening, not as part of this finding.

### Reproduction preconditions (described; no payload)

1. A local process holding the `com.apple.bluetoothaudiod.cb` entitlement (e.g., an Apple-internal or system component context; we verified the gate only accepts entitled clients).
2. Send one XPC dictionary to the service with a `kCBMsgId` naming any of the 8 handlers and **without** the `kCBMsgArgLEAudioDeviceUUID` key.
3. Expected observable: `bluetoothaudiod` NULL-deref crash. We have not executed this against the live daemon (our lab Mac does not run the LE-Audio path by default); the finding is static-confirmed.

### Suggested fixes

- After `xpc_dictionary_get_value`, check for NULL and `xpc_get_type` == UUID before `xpc_uuid_get_bytes`; return a per-handler error reply instead of crashing.
- The same nil-safe pattern used elsewhere in the file (`numberForKey_optional_dict_` helpers) should be applied to UUID arguments.

---

## Finding 3 — wifip2pd: unbounded decompression in Wi-Fi Aware config loader

**Component:** `wifip2pd` (Wi-Fi Aware / NAN daemon), config loader.
**Class:** CWE-409 (improper resource shutdown/control during decompression — decompression bomb / memory exhaustion).
**Reach:** local context dependent — the sink is confirmed; the attacker-influence path into the input is **not** established (see below).

### Evidence (static, decompiled)

`FUN_100165e2c` @ `0x100165e2c` calls `NSData decompressedDataUsingAlgorithm:error:` (algorithm from a global pointer) with **no cap on decompressed output**, then feeds the result to `Foundation::JSONDecoder::_decode` (`re_wifip2pd.c:304730-304763`). The sole caller `FUN_1001673e8` @ `0x1001673e8` iterates **Keychain items** (`kSecAttrAccount` / `kSecValueData`, `:305560-305600`) and passes each item's `Data` value to the decompress+decode path. A small, highly-compressed blob in such a keychain item forces the daemon to allocate the full expanded size — resource exhaustion.

**Honest limitation:** we did not trace which code path writes attacker-influenced bytes into that keychain item; our hypothesis (cached peer attributes from an upstream handler) is unverified inference. We are reporting the unbounded-decompress sink itself; if Apple confirms no external writer can populate the item, severity drops to hardening.

### Reproduction preconditions (described; no payload)

1. Ability to write a compressed blob to the relevant keychain item (exact writer path under investigation — this is the precondition we will close out before submission, or state as unconfirmed).
2. Trigger the config-loader path in `wifip2pd` (daemon restart / config refresh).
3. Expected observable: large allocation spike from the decompress call proportional to the expansion ratio; memory pressure / jetpack kill of the daemon.

### Suggested fixes

- Impose a maximum decompressed size on `decompressedDataUsingAlgorithm:` results (fail the decode beyond the cap).
- Size-limit before JSON decode regardless of input provenance — defense in depth for any config loader.

---

## Related hardening notes (bundled, low severity)

- **findmydeviced:** `listener:shouldAcceptNewConnection:` accepts every connection with no entitlement/audit-token/code-signing validation and exports the full FMM protocol (`re_findmydeviced.c:26538`). Local-only; contrast with bluetoothaudiod's deny-by-default gate. Suggested fix: standard entitlement gate like sibling daemons.
- **findmybeaconingd (fmb):** Swift `Optional<Bool>` fail-open gate — `.none` selects the *near-owner* advertisement variant (`fmb_arm64e.c:10003`), the opposite of a safe default; plus a release-then-return UAF candidate in `FUN_100012438` (`fmb_arm64e.c:12127-12131`); plus unvalidated plist-decoded key lengths feeding crypto init (`audits/continuity_beacons.md` §3). We can fold these into this report or file separately under the Find My component.
- **bluetoothaudiod residual:** entitlement-bool mach gate without code-signing/audit-token validation (`re_bluetoothaudiod.c:8424-8446`) — any entitled process reaches all session handlers (relevant to Finding 2's surface).
- **wifip2pd:** codesign bitmask at accept time accepts any Apple-platform-signed dynamically-valid binary (result recorded but not enforced at accept; per-request entitlement gate does enforce) (`re_wifip2pd.c:381576-381582`, enforcement at `:622296-622380`).

---

## Submission checklist (ours)

- [ ] Re-verify all decompile line references against the exact build/version we report (macOS 26.2, arm64e) and convert to Apple-consumable form (function names, offsets, build ID).
- [ ] Complete dynamic PoC for Finding 1 on the consent-scoped lab Mac (LE-Audio gate enabled on our own machine only) and attach crash traces.
- [ ] Close out or explicitly caveat the wifip2pd keychain-writer provenance question.
- [ ] Confirm no exploit code, payloads, or attribution tooling is included — descriptions and preconditions only.
- [ ] State researcher identity, contact, and consent scope in the report preamble.
