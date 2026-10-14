# Continuity/Nearby Beacon Audit — findmybeaconingd (fmb_arm64e.c)

## Verdict
fmb_arm64e.c is `findmybeaconingd`'s arm64e slice. It is an **orchestration shell around FindMyCrypto.framework**: every advertisement-serialization call (`Advertisement.get_data`, `NearbyAdvertisement.get_data`, `PublicKey.get_advertisement`, `TokenSequence.init/next`) is an unrecovered indirect jump into FindMyCrypto (`PTR_get_data_…`, `PTR_get_nearOwner_100020168`, etc.). **The per-TLV type numbers/byte layout are therefore NOT in this binary** — they live in FindMyCrypto.framework. What this daemon does contain — and what this report maps — is the key-material pipeline feeding the encoder, the 15-minute rotation schedule, and the nearOwner-vs-stranger gate.

## 1. Advertisement payload construction pipeline (what bytes carry)
Key material source: `SPOwner::LocalBeaconKeyInfo` (get_userIdentifier/get_beaconIdentifier/get_pairDate/get_publicKey/get_sharedSecretKey, funcs idx 706–710, lines 18677–18750). Decoded from a plist via `Foundation::PropertyListDecoder::_decode` (line 7087) from the `SPOwner` XPC (`_TtP7SPOwner33FindMyBeaconDaemonPushXPCProtocol_`, line 6114).

Field map (FUN_100011f78, lines 11983–12076, offsets read via GeneratedTokens metadata at `param_2 + 0x14/0x18/0x1c/0x20`):
| Input field | Symbol | Role in payload |
|---|---|---|
| `beaconIdentifier` UUID | `SPOwner::LocalBeaconKeyInfo::get_beaconIdentifier` | Rotation-domain salt: fed to `FindMyCrypto::bucket` (line 12056) |
| `pairDate` Date | `get_pairDate` | Rotation epoch (baseTime for bucketing) |
| `publicKey` Data | `get_publicKey` → `FindMyCrypto::PublicKey::_init` (line 12061) | Identity key → `get_advertisement` (line 9999) → beacon identity bytes |
| `sharedSecretKey` Data | `get_sharedSecretKey` → `KeyRepresentable::_init` (line 2494) | Distinguishes nearOwner capability: `FindMyCrypto::TokenSequence::_init(privateKey, publicKey, sharedKey)` (line 12064, signature at 17865–17867) |
| `userIdentifier` UUID | `get_userIdentifier` | Owner routing only, not advertised |

Pipeline: `TokenSequence._next` → `GeneratedTokens` → `get_hint` → `KeyGenerationHint::get_index` → `FindMyCrypto::dateInterval(baseTime, bucket, 0xf)` (line 9995) → `get_diversifiedRootKeys` → `get_publicKey` → `Advertisement` → `NearOwnerAdvertisement` → `get_data` → `SPBeaconingKey(initWithDateInterval:key:)` (lines 10009–10022).

**Rotation schedule (predictability):** bucketSizeInMinutes is hardcoded `0xf` = **15 minutes** (lines 9995, 12056: `FindMyCrypto::bucket(beaconIdentifier, pairDate, now, 0xf)`). Five future beacons are pre-generated in `FUN_100012438` (line 12123: `_getBeacon(false, 0..<5)`, and `FUN_10000eed0(0,5,…)`, line 12067), each with a `DateInterval` of `FindMyBeaconingSupport::get_keyDuration()` seconds (line 12142). Everything determining the rotation — beaconIdentifier, pairDate, publicKey, sharedSecretKey — sits in one plist: **an attacker with one LocalBeaconKeyInfo record can precompute every future advertisement payload offline.** No nonce, no per-day entropy beyond the 15-min bucket index.

**TLV type numbers:** encoded inside FindMyCrypto (`NearOwnerAdvertisement::get_data` thunk, line 18077; `Advertisement::get_data`, line 17850 region). This daemon hands the framework a structured Swift object, not bytes. Open question for follow-up: dump FindMyCrypto.framework for the encoder; public reverse-engineering (hexway 2021, OpenFindMy) documents the FindMy OF payload as ME/type-byte TLVs with a status+battery byte, but no TLV numbers in this binary confirm that layout.

## 2. nearOwner vs stranger gating
`FUN_10000f2c8` line 10003: `if ((local_90 == 1) || ((local_90 != 0 && (local_90 == -1))))` → nearOwner path (`Advertisement::get_nearOwner` → `NearOwnerAdvertisement::get_data`); **else** → stranger path (`Advertisement::get_data`). The flag is a Swift `Optional<Bool>` bit pattern: `0` = `.some(false)`, `1` = `.some(true)`, `-1` (0xFF tag) = `.none`. **Both `.some(true)` AND `.none` select the NearOwner advertisement; only an explicit `.some(false)` yields the stranger variant.** The gate fails open: a nil/unset flag means the device broadcasts the near-owner variant. Semantically, `NearOwnerAdvertisement` is the payload an owner's other devices can fully resolve (sharedSecretKey makes it authenticate/decrypt), while the stranger `Advertisement` exposes only the rotated public-key material. The gate value arrives as `param_4` through closure thunks `FUN_10001283c`/`FUN_100012840` (lines 12208–12227) from `FUN_100011f78`'s dispatch on `beaconInfo` state (`FUN_10000f804` / `FUN_1000142d4`, lines 13298–13325: the FMIP-enabled branch vs the fallback). The beacon payload itself is only conditionally broadcast at all — gated upstream on FMIP being enabled ("Not beaconing since FMIP is turned off." / "Beaconing FMIP keys.", lines 9334/9352).

## 3. Parsing-bug candidates
1. **USE-AFTER-FREE candidate:** `FUN_100012438` (~line 12127-12131): on error from `FindMyBeaconingSupport::_getBeacon(false,count)` the code executes `_swift_release(puVar16); return puVar16;` — returns the just-released ContiguousArray storage pointer to the caller. If a `_getBeacon` throw occurs mid-loop, caller receives a dangling array buffer.
2. **Fails-open nearOwner gate (semantic bug):** `FUN_10000f2c8:10003` — `local_90 == 1 || (local_90 != 0 && local_90 == -1)` takes the NearOwnerAdvertisement path for BOTH `.some(true)` (1) and `.none` (-1 tag); only explicit `.some(false)` (0) produces the stranger Advertisement. An unset/missing flag defaults the device to broadcasting the near-owner variant.
3. **Unvalidated third-party swizzle hook:** `PTR__getBeacon_100020840` — `FindMyBeaconingSupport.getBeacon(device:count:swizzler:)` is a replaceable function pointer consulted before every beacon generation; if this research shim ships in production images, the entire advertisement payload (and any downstream TLV validation) can be substituted wholesale.
4. **Opaque-length Data from plist decode:** `LocalBeaconKeyInfo` is deserialized with `Foundation::PropertyListDecoder::_decode` (line ~7087) from XPC-provided Data; `publicKey`/`sharedSecretKey` byte lengths are not validated anywhere in this binary before being fed into `FindMyCrypto::PublicKey::_init` / `KeyRepresentable::_init` — any length check is framework-side only.
5. **TLV decoder not in this binary:** Advertisement/NearOwnerAdvertisement `get_data` are unrecovered indirect jumps (0-length-TLV / bounds-check candidates live in FindMyCrypto.framework); recommend dumping that framework for the classic 0-length-TLV and off-by-one length checks.
6. **Minor:** `FUN_100012438` converts the UInt64 key interval via `NEON_ucvtf` to Double before `Foundation::Date::init(timeIntervalSince1970:)` — lossy above 2^53, benign for practical epoch-second values.

## Exploitation implications
1. **Rotation is deterministic and precomputable:** 15-minute buckets over (beaconIdentifier, pairDate) with all key material in one plist — trivial offline prediction of all future beacon identities given one key record (backups/XPC extraction).
2. **Fails-open nearOwner default:** nil flag ⇒ near-owner variant broadcast; a state-machine bug upstream silently upgrades the advertisement class.
3. **Debug swizzle hook** (`FindMyBeaconingSupport` + `getBeacon(…swizzler:)`) can substitute beacon bytes entirely if present in production builds.

## Open questions
- FindMyCrypto.framework dump needed for: TLV type numbers, status/battery/model byte placement, and the advertisement *decoder* (0-length-TLV / bounds-check audit target).
- Where does the nearOwner flag originate before the closure capture (needs `FUN_10001113c` / beaconInfo state machine trace)?
- Is `PTR__getBeacon_100020840` nil in production (i.e., is FindMyBeaconingSupport compiled out)?