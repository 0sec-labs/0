# Find My Beacon Key-Rotation Chain Audit — findmybeaconingd (fmb_arm64e)

Target: `research/wireless/decomp/fmb_arm64e.c` (symbolized, 846 functions) + `fmb_arm64e.functions.txt`.

**Structural finding first:** every `FindMyCrypto::*` symbol present in this binary is a 16-byte thunk that tail-jumps via `PTR_*` indirection into the separate FindMyCrypto framework (`functions.txt:653-676`); the framework binary is NOT in `decomp/`. All daemon-side logic (seeding, schedule, call pattern, no-entropy property) is fully recovered below; statements about framework internals are marked `[INFERENCE]`.

## 1. FindMyCrypto::KeyGenerationHint::get_index()

- Symbol: `get_index` @ `0x100018e44`, 16 bytes (`functions.txt:667`); decompiled stub at `fmb_arm64e.c:18011-18025` — `PTR` indirect jump, body unrecoverable here.
- Demangled getter contract: `FindMyCrypto.KeyGenerationHint.index.getter : Swift.UInt64` (`fmb_arm64e.c:18011`). The only recovered member is a `UInt64` index.
- Daemon usage (`FUN_10000f2c8`, `fmb_arm64e.c:9989-9995`): `GeneratedTokens::get_hint` → `get_index` → result passed as the `bucket` argument to `FindMyCrypto::dateInterval(baseTime, bucket, 0xf)` (0xf = 15 minutes), producing the advertisement's validity `DateInterval` (`functions.txt:654`).
- **Conclusion:** the index is a *time-only* 15-minute bucket index — NOT a per-tag secret. It is consumed purely to timestamp the advertisement window.

## 2. TokenSequence::_next()

- Symbol: `$next` @ `0x100018dc4`, 16-byte thunk (`functions.txt:659`); stub at `fmb_arm64e.c:17884-17898`. **Real body is in the FindMyCrypto framework and is not present in `decomp/`** — it cannot be recovered from this file; the stub's own comment says "Could not recover jumptable".
- What the daemon's use proves (`FUN_10000eed0` @ `0x10000eed0`, `fmb_arm64e.c:9751-9833`): a generation loop of `param_2 - param_1` iterations; each iteration calls `TokenSequence::_next` (line 9815), retains the returned `GeneratedTokens?` (Optional, witness +0x30 call line 9817) and appends it to a Swift array (lines 9818-9825). No clock read, no RNG, no re-init inside the loop.
- Called from the rotation path as `FUN_10000eed0(0, 5, ...)` (`fmb_arm64e.c:12067`): **exactly 5 tokens pre-generated per refresh = ~75 minutes of lookahead.**
- **Entropy audit:** grep of the entire file for `SecRandomCopyBytes|arc4random|SecKeyCreateRandomKey|RandomNumberGenerator|readRandom` → **zero matches**. The only time source in the whole chain is `FindMyCommon::ReferenceClock::get_now` (`fmb_arm64e.c:12049-12050`), used once to compute the starting bucket. Shape: init once with a startIndex, then repeated `_next` into a lookahead buffer — a pure deterministic sequence (counter- or chain-advanced inside the framework `[INFERENCE]`). No daemon-side reseeding, ever.

## 3. TokenSequence.init(privateKey, publicKey, sharedKey, startIndex, hint:)

- Full demangled signature: `fmb_arm64e.c:17865-17871`. Call site: `FUN_100011f78` @ `0x100011f78` (`fmb_arm64e.c:11976-12102`):
  - `FindMyCommon::ReferenceClock::get_now` → current Date (`fmb_arm64e.c:12049-12050`).
  - `FindMyCrypto::bucket(param_2+off(0x14), param_2+off(0x18), date, 0xf)` (`fmb_arm64e.c:12053-12055`) — demangled `bucket(UUID beaconIdentifier, Date baseTime, Date date, __int64 bucketSizeInMinutes)` (`functions.txt:673`).
  - `publicKey` ← `param_2+off(0x1c)`, `sharedKey` ← `param_2+off(0x20)` (`fmb_arm64e.c:12058-12059`).
  - `param_2` is a per-tag `SPOwner::LocalBeaconKeyInfo` — fields: `sharedSecretKey`, `publicKey`, `userIdentifier`, `beaconIdentifier`, `pairDate` (`functions.txt:706-711`), copied out of `LocalBeaconing::beaconInfo` by `FUN_10001113c` (`fmb_arm64e.c:11027-11040`, loaded at `fmb_arm64e.c:10061-10072`).
- **startIndex = the current 15-minute time bucket computed from the tag's beaconIdentifier + pairDate + wall clock.** It is neither random nor directly secret-anchored (though `bucket()` may mix the UUID into the index — body in framework, unrecovered).
- The `hint:` argument is Optional; the daemon allocates an Optional `KeyGenerationHint` slot (`fmb_arm64e.c:12061-12063`, value-witness +0x38 call) whose payload (some vs none) is not recoverable in this decompile.
- Immediately after init: `FUN_10000eed0(0,5,...)` pre-generates the 5-token lookahead (`fmb_arm64e.c:12067`).

## 4. DiversifiedRootKeys::get_publicKey()

- Symbols: `GeneratedTokens::get_diversifiedRootKeys` @ `0x100018de4` (`functions.txt:661`, stub `fmb_arm64e.c:17918-17921`) and `DiversifiedRootKeys::get_publicKey` @ `0x100018e64` (`functions.txt:669`). Both 16-byte thunks — **branch count and diversifier are NOT recoverable from this binary**.
- Daemon chain (`FUN_10000f2c8`, `fmb_arm64e.c:9989-10020`): token → `hint.index` → `dateInterval(base, index, 15)` → `diversifiedRootKeys` → `publicKey` → `PublicKey::get_advertisement` (`functions.txt:674`) → `Advertisement::get_data` / `get_nearOwner` → ObjC `SPBeaconingKey initWithDateInterval:key:` (`fmb_arm64e.c:10010-10020`). The beacon payload is published together with its validity DateInterval.
- `[INFERENCE]`: plural "RootKeys" with a singular `get_publicKey` getter suggests at least one keyed branch per purpose (e.g., near-owner vs separated advertisement), consistent with a KDF over (shared secret, time bucket) — needs the framework binary to confirm.

## 5. VERDICT

**Rotation schedule: fully public and deterministic.** `index = bucket(beaconIdentifier, pairDate, now, 15min)`; the beacon itself broadcasts its validity DateInterval, so timing is observable. Zero randomness anywhere in the daemon.

**Token stream from a single observed beacon: NOT predictable on the evidence of this binary.** An observer of one beacon obtains only the advertisement payload (public-key-derived data) plus its time window. Deriving subsequent tokens requires either the tag's `SharedSecretKey` or an invertible/linked derivation inside the unrecovered `_next`/diversification code in the FindMyCrypto framework. **Cross-rotation tag tracking cannot be confirmed from fmb_arm64e.c alone.**

Two genuine weaknesses ARE established here:
1. **Forever-deterministic stream, no reseeding, no entropy** (`fmb_arm64e.c:9751-9833`, `12049-12067`; RNG grep empty). Anyone holding a tag's `SharedSecretKey` can compute that tag's complete advertisement timeline arbitrarily far into the past and future, and pre-roll the same 5×15-minute lookahead the daemon uses. The secret is a single point of failure shared across the FindMy ecosystem.
2. **Replayable, time-anchored tokens**: tokens are a pure function of (persistent keys, pairDate, wall clock), so captured advertisements are valid exactly when recomputed and cannot be revoked by rotation alone.

The decisive evidence (the `_next` body, diversification count) requires decompiling the FindMyCrypto framework — see open questions.

---

## Open questions (next RE target: FindMyCrypto.framework)

1. Body of `TokenSequence::_next` — pure counter advance (`token_n = KDF(seed, n)`) or chained re-seed (`token_{n+1} = G(token_n)`)? A chained/invertible advance flips the verdict to cross-rotation tracking from one beacon.
2. `FindMyCrypto::bucket` body — does it mix `beaconIdentifier` into the index beyond `floor((now - pairDate)/15min)`?
3. `DiversifiedRootKeys` — how many diversified branches, what value diversifies, and whether consecutive buckets' diversified public keys are algebraically linkable.
4. Does `KeyGenerationHint` carry per-tag/secret fields beyond `index:UInt64`? Only `.index` is read by the daemon.
5. Provenance and entropy width of `LocalBeaconKeyInfo.sharedSecretKey` (pairing/keychain storage) — the single point of failure for the whole deterministic stream.
6. Is the `KeyGenerationHint` passed to `TokenSequence.init` at `fmb_arm64e.c:12063` Optional.some or .none? Optional payload construction is a witness-table call, unrecoverable in this decompile.

---

Evidence index: `fmb_arm64e.c` lines 9751-9833 (FUN_10000eed0 gen loop), 9899-10023 (FUN_10000f2c8 adv construction), 10049-10076 (beaconInfo dispatch), 11027-11040 (FUN_10001113c), 11976-12102 (FUN_100011f78 init site), 17864-17940 (thunk signatures/stubs), 18011-18037; `fmb_arm64e.functions.txt` lines 653-676, 706-711.

---

## 6. FindMyCrypto.framework findings (follow-up decompile)

Source: `research/wireless/decomp/FindMyCrypto.c` (632 KB, 1076 functions, exported 2026-10-14 00:23, `decomp/fmc.log` "DECOMP DONE FindMyCrypto wrote=1076") + `FindMyCrypto.functions.txt`. All line numbers below are `FindMyCrypto.c` unless prefixed. This decompile recovers the real bodies that sections 1-4 could only see as 16-byte thunks.

### 6.1 — Q1: `TokenSequence::_next` body: **CHAINED RE-SEED (ratchet), not a pure KDF over (seed, index)**

- `_next` body: `FindMyCrypto.c:364-467`. Its single computational step is `FUN_23eaf10a4(...)` at `FindMyCrypto.c:412`, thunked into `FUN_23eaf10d0` (`FindMyCrypto.c:7638-7833`).
- `FUN_23eaf10d0`'s first operation is exactly **one** ratchet iteration: `FUN_23eaf195c(&local_a0,&local_d0,1)` — `FindMyCrypto.c:7700`.
- `FUN_23eaf195c` (`FindMyCrypto.c:7838-8015`) is a ratchet loop: each iteration runs the ANSI-X9.63 KDF (`_CCKDFParametersCreateAnsiX963` at `FindMyCrypto.c:11104`, executed by `_CCDeriveKey(params, 10, ...)` at `FindMyCrypto.c:10528/10600/10702/10750`; failure path logs `"Error running CCDeriveKey. Code: %d."` `FindMyCrypto.c:7916`) with fixed info label `"update"` (hex literal `0x657461647075` = "update", `FindMyCrypto.c:7869-7871`), takes 32 output bytes, then feeds the output back as the next input: `param_3 = param_3 + -1; puVar2 = puVar14;` — `FindMyCrypto.c:7996-7997`.
- **No index enters the derivation.** The state at bucket *n+1* is `state_{n+1} = X963KDF(state_n, info="update", 32B)`. The `index` field of `GeneratedTokens`/hint is bookkeeping (see 6.4), never a KDF input.
- Cross-check with the daemon (section 2 of this audit): `_init` pre-ratchets `startIndex` iterations from the raw `sharedKey` (`FindMyCrypto.c:179`, and the hint fast-forward at `FindMyCrypto.c:164`), then each `_next` ratchets once. This is a hash-chain ("ratchet" in Apple's own log strings, `FindMyCrypto.c:121,164`), i.e. `token_{n+1} = G(token_n)`.

**Consequence:** forward-only. Given the *current* 32-byte token one computes all *future* tokens; past tokens are unrecoverable (X9.63 is hash-based, one-way). Given only the root `sharedSecretKey`, the entire timeline (past and future) is computable — confirming old weakness 1.

### 6.2 — Q2: `FindMyCrypto::bucket` body: **pure time arithmetic; beaconIdentifier does NOT mix into the index**

- Body `FindMyCrypto.c:16079-16311` (`bucket(UUID beaconIdentifier, Date baseTime, Date date, Int bucketSizeInMinutes)`).
- Fatal guard: only `bucketSizeInMinutes == 15 (0xf)` or `== 1440 (0x5a0)` are accepted; anything else hits `fatalError` in `FindMyCrypto/MappingFunctions.swift` — `FindMyCrypto.c:16110-16124,16173`.
- The computed index is `local_a8 = (long)dVar20 + 1` (`FindMyCrypto.c:16213`) where `dVar20 = (date − baseTime) / bucketSeconds` (division at `FindMyCrypto.c:16182-16186`). **`beaconIdentifier` is never used in the arithmetic** — it is only formatted into the debug os_log line (fields `.primary`/`.secondary` and `hash`, plus the UUID description; `FindMyCrypto.c:16187-16210`).
- Companion `dateInterval(baseTime, bucket, size)` (`FindMyCrypto.c:16312+`): bucket is **1-based** — window start = `baseTime + (bucket−1) × size` (`FindMyCrypto.c:16398`); bucket 0 is rejected with `"Caller attempted to calculate dateInterval for bucket 0!"` (`FindMyCrypto.c:16391`).
- **Conclusion:** `index = floor((now − baseTime)/15min) + 1`, globally synchronized across all tags. The UUID-in-index hypothesis from section 3 is REFUTED.

### 6.3 — Q3: `DiversifiedRootKeys`: three members; diversifier is secret-derived; consecutive public keys NOT linkable to a passive observer

- Structure: `init(intermediateKey: IntermediateKey?, publicKey: PublicKey, privateKey: PrivateKey?)` — `FindMyCrypto.c:11291-11294`; getters at `FindMyCrypto.c:11320-11381` (`functions.txt:394-397`). So per token there are up to **three** derived key slots (an optional intermediate key, the public key, an optional private key), not a per-purpose branch tree.
- Per-token derivation inside `FUN_23eaf10d0`: after the ratchet, the 32-byte state is expanded with a second X9.63 KDF using info label `"diversify"` (`0x6669737265766964`/`0xe9...79` = "diversif"+"y", `FindMyCrypto.c:7706-7708`) to **72 bytes** (`FindMyCrypto.c:7712`, length validated by `FUN_23eaf6d40` @`FindMyCrypto.c:12707`).
- ECC pipeline (curve is P-224: private scalar 28 bytes — validator `FUN_23eaf6f70` expects `0x1c`; public point 57 bytes uncompressed — `PublicKey.length = 0x39`, `FindMyCrypto.c:13056`, length-checked by `FUN_23eaee8a0` with `0x39` at `FindMyCrypto.c:7789`): import key material (`_CCECCryptorImportKey`, `FindMyCrypto.c:9269` in `FUN_23eaf3840`), then **`_CCECCryptorTwinDiversifyKey`** (`FindMyCrypto.c:9480,9579,9695,9738` in `FUN_23eaf3c68`; error log `"Error running CCECCryptorTwinDiversifyKey. Code: %d."`), then export (`_CCECCryptorExportKey`, `FindMyCrypto.c:10185-10301`; error path `FUN_23eaf3258` logs `"Error running CCECCryptorExportKey. Code: %d"`).
- The diversifier input to twin-diversify comes from the 72-byte `"diversify"` KDF output, which is derived from the **secret** ratcheted token — both the private-key branch (`FindMyCrypto.c:7722-7724`) and the public-key-only branch (`FindMyCrypto.c:7773-7775`) consume the same secret-derived material before the shared closure at `FindMyCrypto.c:7804`. [INFERENCE: exact argument wiring of the elided `FUN_23eaf3c68()` calls is decompiler-lossy, but no public value enters the diversification in either branch.]
- **Conclusion:** `pk_{n+1}` is a one-way function of `state_{n+1} = X963KDF(state_n)`. An observer holding only `pk_n` (or its 28-byte advertisement form) cannot compute `pk_{n+1}` without inverting X9.63 or solving ECDLP on P-224. Consecutive buckets' public keys are **not algebraically linkable** from the advertisement alone.

### 6.4 — Q4: `KeyGenerationHint` fields: `{index: UInt64, sharedSecret: SharedSecretKey}`

- `get_index` returns a raw `UInt64` (`FindMyCrypto.c:5934`); `get_sharedSecret` returns a `SharedSecretKey` (`FindMyCrypto.c:5946-5966`).
- The type is Codable/Hashable/Equatable (`FindMyCrypto.c:6173-6228` encode, `6284-6336` decode-init) — hints are persisted/transported, not ephemeral.
- `SharedSecretKey.length = 0x20` (32 bytes, `FindMyCrypto.c:15127`).
- Semantics (from `TokenSequence._init`, `FindMyCrypto.c:46-200`): if the hint is usable, its `sharedSecret` becomes the chain state and the sequence skips `(hint.index − startIndex)` ratchet iterations — `"KeyGenerationHint hint.index:%llu saved %llu ratchet iterations"` (`FindMyCrypto.c:164`); if the hint's index is too far from the requested start (beyond `initialRatchetsToSkip`), it is dropped — `"Ignoring KeyGenerationHint: hint.index (%llu) > initialRatchetsToSkip(%llu)"` (`FindMyCrypto.c:121`). **The hint is a (index, secret-checkpoint) pair for cheap catch-up after restore/reboot — it carries no per-tag entropy beyond a snapshot of the chain itself.**

### 6.5 — Q5: provenance/entropy of `sharedSecretKey`

- The framework treats `sharedSecretKey` as an opaque **32-byte input** (`SharedSecretKey.length = 0x20`, `FindMyCrypto.c:15127`; byte-width enforced by the `0x20` validator `FUN_23eaf6e58`); it is only ever a parameter of `TokenSequence.init` (`FindMyCrypto.c:41-45`) — never generated in the rotation path.
- Grep for `SecRandom|arc4random|CCCryptorGenerate` in the rotation path: the **only** RNG entry points in the framework are `PrivateKey.random()` → `_CCECCryptorGeneratePair` (`FindMyCrypto.c:23593 → 8804`), generic `KeyRepresenting.random()` (`FindMyCrypto.c:4371`), and the P-256/SymmetricKey256 generators (`FindMyCrypto.c:20523,21411`) — none is called by the ratchet/diversify chain. [INFERENCE: `sharedSecretKey` originates at pairing time in the owner ecosystem and is provisioned to the accessory; its generation site is outside this framework — matching section 3's `LocalBeaconKeyInfo` field, still the single point of failure.]

### 6.6 — Q6: Optional `KeyGenerationHint` at the daemon init site — still open

- The framework accepts both `.some` and `.none` (`FindMyCrypto.c:121,164` handle each case), so the framework alone cannot decide. The daemon's optional slot construction at `fmb_arm64e.c:12061-12063` (witness-table call) remains unrecovered. [INFERENCE: a fresh session init at the current bucket needs no checkpoint, so the beacon daemon likely passes `.none`; `.some` would only make sense on restore paths that persisted a hint — the hint being Codable (`FindMyCrypto.c:6173-6336`) supports a persisted-checkpoint design. Not confirmed.]

### 6.7 — VERDICT (rewritten)

**Can an observer of one beacon track it across 15-minute rotations? NO — not passively.** The decompiled chain is now fully recovered:

```
state_0        = sharedSecretKey (32 B, persistent, pairing-provisioned)
state_{n+1}    = ANSI-X9.63-KDF(state_n, info="update", 32B)      # FindMyCrypto.c:7869-7871,7996-7997
bucket key     = ANSI-X9.63-KDF(state_{n+1}, info="diversify", 72B)  # FindMyCrypto.c:7706-7712
advertisement  = 28-byte datum of a twin-diversified P-224 point     # FindMyCrypto.c:13027,13056 (57B point)
```

The advertisement exposes only 28 bytes of a P-224 public point; recovering the chain state requires breaking X9.63 preimage resistance or ECDLP. `bucket()` is pure wall-clock arithmetic with no UUID mixing (`FindMyCrypto.c:16213`), so rotation timing is fully predictable — but **predictability of the schedule is not linkability of the keys**: consecutive public keys are chained through a secret-state hash ratchet whose diversifier is itself secret-derived. A passive observer of a single beacon advertisement cannot compute, recognize, or link the next bucket's key. This REFUTES the "chained re-seed ⇒ single-beacon tracking" reading: chaining exists, but every link is secret-anchored, so chaining alone does not help an adversary who holds no key material.

What the chaining DOES establish (sharpened weaknesses over section 5):
1. **Forward compromise window is unbounded.** Anyone who learns a *current* 32-byte token (e.g., by briefly compromising an accessory, or capturing state from a paired device) can compute every future advertisement of that tag forever — the ratchet never reseeds and never expires (`FindMyCrypto.c:7996-7997`). Past buckets stay safe (one-way).
2. **Full-timeline capability for holders of `sharedSecretKey`** — confirmed at the framework level: with the 32-byte root, all past and future buckets are computable, matching the daemon-side finding of section 5 (weakness 1). The `KeyGenerationHint{index, sharedSecret}` checkpoint mechanism (`FindMyCrypto.c:164`) shows Apple's own code fast-forwards this chain by design.
3. **Schedule is globally synchronized** (`bucket = floor((now−base)/15min)+1`, no per-tag offset, `FindMyCrypto.c:16213`): an adversary with *any* key material for a tag knows exactly which bucket index to derive without observing the tag, enabling targeted offline replay within a captured window.

Residual unknowns: which side computes the 2-byte `Advertisement.hint` (`FindMyCrypto.c:1334`) and `Advertisement.address` (`FindMyCrypto.c:1357`) and whether either leaks extra linkage bits is in the beaconing daemon, not this framework; exact closure wiring of the twin-diversify call is [INFERENCE] as noted in 6.3.

New-decompile evidence index: `FindMyCrypto.c` 41-200 (TokenSequence._init + hint logs), 364-467 (_next), 179/7700 (ratchet steps), 7706-7724/7773-7789 (diversify + ECC pipeline), 7838-8015 (ratchet loop, "update" label, CCDeriveKey), 8968-9054 (diversify KDF wrapper), 9269/9480-9738/10185-10301 (import/twin-diversify/export), 10528-10750 (_CCDeriveKey algo 10), 11034-11217 (X9.63 params), 13027-13056 (advertisement, 57B pubkey), 15127 (SharedSecretKey 32B), 16079-16311 (bucket, no UUID mixing, +1 at 16213), 16312-16398 (dateInterval), 6173-6336 + 5934-5966 (KeyGenerationHint), 23593/8804 (only RNG entry points).