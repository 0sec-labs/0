# AirDrop OWT → phone-number reveal: dual-window matcher fix, live/replay pipeline

Date: 2026-10-14 · Owner: AirdropLive (wireless campaign phase 2) ·
Artifacts: `airdrop_validate/matcher.py`, `airdrop_live.py`, this report.
Consent scope: all capture and identification is limited to devices this team
owns and controls. No third-party identification was performed live in this
task (see §Consent and legality).

## 1. Derivation recap (ground truth, unchanged)

Exactly as validated in `airdrop_validate/VALIDATION.md` and implemented in
the C binaries (`airdrop_brute.c`, `build_rainbow.c`):

1. **Input string** is `snprintf("%s%0*ld", prefix, width, n)` — for the
   +4179 plan: literal `+4179` + 7 zero-padded digits, e.g. `+41795551234`.
   The `+` and the zero-padding are part of the hashed input; no
   normalization of any kind.
2. **Algorithm**: SHA-256 over the UTF-8 bytes of that string
   (CommonCrypto `CC_SHA256` ≡ `hashlib.sha256`).
3. **BLE 2-byte windows** (Apple TLV 0x05 beacons), big-endian:
   - `w1 = (d[0] << 8) | d[1]` — digest bytes 0-1
   - `w2 = (d[1] << 8) | d[2]` — digest bytes 1-2
4. **Rainbow key** (`build_rainbow.c`): first 16 digest bytes as 32 hex
   chars; TSV `rainbow_4179.tsv` (438 MB, read-only) maps `<hash32> <phone>`.

Phase 1 established the failure mode: a **single** 2-byte window over the
10^7-candidate width-7 space is inherently ambiguous — measured 5,714 HITs
over the 19 observed windows (`real_hits.txt`), i.e. ~280-320 candidates per
window. The rainbow table cannot fix beacons: a single pass over it is
useless for 2-byte-window queries (only 128-bit+ prefixes are stored), and a
beacon carries only 2 bytes of each hash.

## 2. The matcher fix: dual-window identification

`airdrop_validate/matcher.py` keeps only candidates whose digest produces
**both** windows captured from one advertisement:

- `identify(w1, w2)` — scans the number space (`+4179` + `%07d`, all 10^7
  ordinals) keeping numbers where `(d[0:2], d[1:3])` equals `(w1, w2)` or
  `(w2, w1)` (order-insensitive, covers equal-window corner cases).
- `match_single(w)` — the unfixed-matcher behavior, for the ambiguity demo.
- `pair_from_payload(payload)` — canonical TLV-0x05 offsets (payload[0:2],
  payload[2:4], per `derive.py`'s synthetic-beacon convention
  `payload = d[0],d[1],d[1],d[2]`).
- `pair_sweep(payload)` / `identify_payload(payload)` — every adjacent
  sliding-window pair of a real 18-byte payload, as a layout diagnostic.

**Enumeration strategy.** The brief suggested loading
`rainbow_4179.tsv` into a `hash16→phone` dict, but that dict is ~2 GB per
window index and the TSV stores only hash prefixes. Instead the matcher
streams the number space itself, computing `sha256('+4179' + %07d)` once per
number (multiprocessing over 10 ranges). Measured on this M1 Max: 0.45 s per
10^6 in pure `hashlib`, **~1 s wall for the full 10^7 space parallel** — no C
helper needed; `airdrop_brute` remains as the C ground truth.

**Entropy correction (fixes the phase-1 estimate).** The phase-1 brief
estimated "dual-window intersection ≈ 0.0023 expected candidates", which
assumes two independent 16-bit constraints (2^-32). The two windows **share
digest byte 1**, so a pair constrains only 24 bits: expected candidates is
10^7 / 2^24 ≈ **0.60**, not 0.0023. Empirically confirmed: the planted pairs
resolve to 1-2 candidates (vs ~305 for a single window), and two of the
three planted pairs each contain exactly one genuine 3-byte SHA-256
digest-prefix collision — proven, not assumed:

```
+41795551234 vs +41797818744: digest prefixes 9d5da4 / 9d5da4 — identical
+41796654321 vs +41795533867: digest prefixes cb44ad / cb44ad — identical
```

So the honest claim is: **a dual-window pair shrinks ~305 candidates to ≤ 2
(here), with residual singletons being verifiable digest-prefix collisions —
and "exactly 1 candidate" occurs when no 3-byte collision exists in the
space (1 of 3 planted pairs), not always.** Attribution of a singleton to a
human still requires the consented owned-device protocol.

### matcher.py unit selftest (verbatim)

```
planted: ['+41795551234', '+41796654321', '+41797771001']
[1/3] dual-window identification (pair from one advertisement):
  (9d5d,5da4) -> ['+41795551234', '+41797818744'] ok  [collider +41797818744: digest prefix 9d5da4 == planted 9d5da4 = True]
  (cb44,44ad) -> ['+41795533867', '+41796654321'] ok  [collider +41795533867: digest prefix cb44ad == planted cb44ad = True]
  (8afe,fec0) -> ['+41797771001'] ok (exact, unique)
[2/3] single-window ambiguity (the unfixed matcher):
  5da4 -> 317 candidates ok (ambiguous)
  9d5d -> 287 candidates ok (ambiguous)
  44ad -> 291 candidates ok (ambiguous)
  cb44 -> 310 candidates ok (ambiguous)
  8afe -> 313 candidates ok (ambiguous)
  fec0 -> 308 candidates ok (ambiguous)
[3/3] planted numbers present inside their ambiguous sets:
  +41795551234: in w1=9d5d set: True, in w2=5da4 set: True ok
  +41796654321: in w1=cb44 set: True, in w2=44ad set: True ok
  +41797771001: in w1=8afe set: True, in w2=fec0 set: True ok
MATCHER SELFTEST PASS
```

## 3. `airdrop_live.py` — passive capture → reveal pipeline

Pipeline: CoreBluetooth JSONL (`ble_map`/`ble_scan` format, parsed from the
`mfg` hex field; company id bytes `4c 00`, Apple TLV walk identical to
`ble_map.swift`'s `parseTLVs`) → TLV type 0x05 payloads → window extraction
→ `matcher.identify()` with a result cache (one 10^7-scan per distinct
pair). Tracks per randomized MAC: hits, RSSI min/max, first/last seen;
unique payloads deduplicate the expensive scans. `--live` runs the compiled
`ble_map` binary for N seconds (appends raw JSONL for replay — the raw dump
requirement) and feeds it through the identical analysis path.

### Selftest (3 planted identities through the full pipeline) — PASS

```
[selftest] planted beacons written to .../airdrop_validate/live_selftest_beacons.jsonl
[selftest] 3 AirDrop-advertisement records from 3 device(s)
...
MAC                                      hits  rssi      first→last        candidates
02:00:00:00:00:00                           1   -50..-50  22:30:59→22:30:59 +41795551234, +41797818744
02:00:00:00:00:01                           1   -50..-50  22:31:00→22:31:00 +41795533867, +41796654321
02:00:00:00:00:02                           1   -50..-50  22:31:01→22:31:01 +41797771001
...
[selftest] 02:00:00:00:00:00 -> ['+41795551234', '+41797818744'] planted +41795551234: ok
[selftest] 02:00:00:00:00:01 -> ['+41795533867', '+41796654321'] planted +41796654321: ok
[selftest] 02:00:00:00:00:02 -> ['+41797771001'] planted +41797771001: ok
LIVE SELFTEST PASS
```

3/3 planted numbers recovered (each is in its device's candidate set; sets
of size ≤ 2, third planted pair exactly 1). One tooling fix found by the
selftest itself: `derive.py`'s synthetic beacons write the company id as
`004c`, while real advertisement bytes are `4c 00` — `airdrop_live.py`
emits the real wire format.

### Replay of the real 122 s capture (`ble_map.jsonl`) — real counts

```
[replay:ble_map.jsonl] 53 AirDrop-advertisement records from 2 device(s)
[replay:ble_map.jsonl] 2 unique 0x05 payload(s); running dual-window identification (10^7 sha256/scan, cached)

MAC                                      hits  rssi      first→last        candidates
BA4692ED-B9AD-28A5-ED7F-D892485F00FC       48   -84..-64  22:30:59→22:32:47 (no candidate in +4179 space — 0 match)
D6DA35C1-6BA9-2305-8452-B330D4B283A4        5   -79..-68  22:32:50→22:32:59 (no candidate in +4179 space — 0 match)

[replay:ble_map.jsonl] payload#0 404ec05e00000000035302022064d2002b00
  canonical pair (404e,c05e) -> ∅
  adjacent-window sweep: 16 pairs, 4 yield exactly 1 candidate, 11 yield 0, 1 yield >1
  hash fields in isolation: 404e -> 293 candidates, c05e -> 283 candidates (single-window ambiguity persists)
[replay:ble_map.jsonl] payload#1 40df90f600000000035302022064d2002b00
  canonical pair (40df,90f6) -> ∅
  adjacent-window sweep: 16 pairs, 2 yield exactly 1 candidate, 12 yield 0, 2 yield >1
  hash fields in isolation: 40df -> 297 candidates, 90f6 -> 323 candidates (single-window ambiguity persists)
[replay:ble_map.jsonl] observed windows: 19; uniquely identifying under dual-window (some co-window in the same ad): 9
[replay] windows.txt cross-check: 19 observed vs 19 listed, overlap 19
```

Interpretation — three honest findings:

1. **Canonical offsets give 0/2 payloads.** The real beacons' two hash
   fields (`404e`/`c05e`, `40df`/`90f6`) are **not** the two overlapping
   windows of one digest — for a pair at offsets 0-1/2-3 of one digest,
   byte 1 would have to equal bytes 1 of both fields (`df` ≠ `90`,
   `4e` ≠ `c0`). [INFERENCE, consistent with PrivateDrop literature]: real
   AirDrop beacons carry hash1 and hash2 as two **separate** 2-byte
   truncated hashes (email and phone, the phone one with a 1-byte offset),
   not one contact's dual windows. The synthetic convention in
   `derive.py` therefore models the *protocol's* window algebra, not the
   *layout* of a real 18-byte payload.
2. **Of the 19 observed windows, 9 admit an adjacent co-window pair that
   yields exactly 1 candidate — all of them are noise.** With 24-bit pair
   entropy, λ = 0.60 expected candidates per pair; singleton hits on
   unrelated window pairs (e.g. `0000`+`5e00` → `+41796811210`) are Poisson
   singletons, **not identifications**. The brief's expectation "only those
   seen with both windows from one ad identify uniquely" is thus sharpened:
   even co-occurrence in one ad only identifies when the co-window is the
   true sibling window of the same digest — which the real layout denies
   (finding 1). Zero of the 19 windows are legitimately identified.
3. **Single-window ambiguity persists for the real hash fields**: 283-323
   candidates each — exactly the problem the dual-window matcher removes
   *when both sibling windows are observable* (planted/synthetic case,
   and any future consented capture where the contact derivation applies).

**Live-mode status.** The capture mechanics were smoke-verified: a 5 s
`./ble_map 5 /tmp/ble_live_smoke.jsonl` run wrote 43 JSONL records through
the exact path `--live` drives (no AirDrop advertisers in that short window,
so the run exercised capture + write only). The identification stage
`--live` invokes is the replay-proven pipeline above. A full live
identification session is deferred to the consented protocol below — no
third-party identification was performed live in this task.

## 4. Consent and legality framing

**This is personal-data processing, not a party trick.** Under GDPR
(Art. 5), a 2-byte truncated hash of a phone number broadcast over BLE is
data relating to an identifiable natural person — even pseudonymized,
it is personal data the moment it can be attributed with reasonable means
(and the rainbow/brute machinery here is exactly that means). Processing it
requires a lawful basis; "it was in the air" is not one.

- **Austria**: covert pursuit/observation of a person — which is what
  tracking a beacon through a crowd is — falls under stalking as briefed in
  the campaign documents (GEG 129/2009 §§ 117-119): repeated chasing,
  observing, and recording of a person's whereabouts via technical means,
  punishable on complaint. Identifying or contacting an uninvolved person
  from a leaked hash would additionally implicate data-processing and
  disclosure rules.
- **Consent scope of this work**: all capture and identification ran only
  against lab-owned infrastructure and synthetic/planted identities. Real
  captures (`ble_map.jsonl`) are passive receive-only scans in the team's
  own lab; the two AirDrop advertisers observed are team devices, and this
  report attributes **nothing** to them (finding 2 — the math says the
  windows are ambiguous anyway).
- **Rules for any future live demo**: (1) only devices the demonstrator
  owns, or with the data subject's informed written consent; (2) public
  demos only with informed consent from everyone whose beacon is processed,
  or with identification disabled (passive capture + hashes only); (3) never
  transmit, never inject beacons toward third parties; (4) raw JSONL stays
  on team storage, deleted after the session; (5) any attribution claim must
  survive the ambiguity math above (candidate set + colliders shown).

## 5. Reproducing

```
cd research/wireless
/Users/peak/coding/0sec-labs/marauder/.venv/bin/python airdrop_validate/matcher.py   # unit selftest
/Users/peak/coding/0sec-labs/marauder/.venv/bin/python airdrop_live.py --selftest   # full-pipeline selftest
/Users/peak/coding/0sec-labs/marauder/.venv/bin/python airdrop_live.py --replay ble_map.jsonl
/Users/peak/coding/0sec-labs/marauder/.venv/bin/python airdrop_live.py --live 60    # consented session only
```

Files: `airdrop_validate/matcher.py` (matcher + unit tests),
`airdrop_validate/live_selftest_beacons.jsonl` (synthetic capture),
`airdrop_live.py` (pipeline), `windows.txt` / `real_hits.txt`
(phase-1 artifacts, reused read-only). `rainbow_4179.tsv` untouched.
