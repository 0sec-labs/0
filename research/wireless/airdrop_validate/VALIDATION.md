# AirDrop OWT hash derivation — validation report

Validated: 2026-10-14. Artifacts in this directory were produced by
`python3 derive.py` (selftest) against the real C binaries in `../`
(`airdrop_brute`, `build_rainbow`) and the C-built table `../rainbow_4179.tsv`
(read-only, never modified).

## The derivation, exactly (ground truth: `airdrop_brute.c` / `build_rainbow.c`)

1. **Input format.** The hashed string is `prefix + zero-padded ordinal`,
   built as `snprintf("%s%0*ld", prefix, width, n)`. For the +4179 plan:
   prefix `+4179`, width 7 → `+4179` + 7 zero-padded digits, e.g.
   `+41795551234`.
   - The leading `+` **is part of the hashed input** (both C binaries hash
     `buf`, which starts with the literal prefix `+4179`).
   - Zero-padding **is part of the input** (`%0*ld`): ordinal 342 hashes as
     `+41790000342`, not `+4179342`.
   - **No normalization of any kind**: no E.164 rewriting, no digit-only
     stripping, no lower/upper-case handling, no emoji/unicode stripping.
     Neither C source contains any such step; the string is hashed
     byte-for-byte as constructed (UTF-8/ASCII bytes).
2. **Algorithm.** SHA-256 (CommonCrypto `CC_SHA256`) over exactly those
   bytes — identical to Python `hashlib.sha256(s.encode("utf-8"))`.
3. **BLE 2-byte windows** (`airdrop_brute.c`, `worker()`): two 2-byte
   windows at byte offsets **0** and **1**, big-endian:
   - `w1 = (d[0] << 8) | d[1]`
   - `w2 = (d[1] << 8) | d[2]`
   rendered as 4 lowercase hex digits. These are the 2-byte values carried
   in Apple TLV 0x05 beacons.
4. **Receiver-cert rainbow key** (`build_rainbow.c`, `worker()`): the first
   **16 digest bytes** (128-bit prefix) as 32 lowercase hex chars; TSV line
   `<hash32> <phone>`.
5. **`airdrop_crack.py` equivalence** (verified numerically below): its
   `digest_prefixes()` returns `{d[:2], d[1:3]}` — the same offsets-0/1
   windows — and `phone_variants()` includes the raw stripped `+41…` string,
   which equals the canonical C input. No divergence from the C
   implementation was found, so `derive.py` needed no fix.

## What the selftest proves

That the hash → number recovery pipeline works **end-to-end** with one
consistent derivation across all three tools:

- Python `derive.py` reproduces the C-built rainbow table entries exactly
  (phase 1) — the derivations in `derive.py` and the C binaries are the same
  function.
- `airdrop_brute` (the real C binary) recovers each planted number exactly
  from its 2-byte windows over the full 10^7-candidate width-7 space
  (phase 2).
- `airdrop_crack.py` flags a synthetic Apple-TLV-0x05 beacon carrying the
  planted windows, with the matched variant equal to the canonical form
  (phase 3) — i.e. the crack tool's derivation matches the C ground truth
  for canonical `+41…` inputs.
- A hash of a captured cert (full SHA-256 prefix) or a 2-byte beacon window
  resolves to the planted phone number exactly, given rainbow/brute coverage
  of the numbering range.

**Caveat the selftest also demonstrates:** 2-byte windows are inherently
ambiguous over a large space — the brute run produced ~1,818 additional
colliding candidates across 6 windows (~152 expected per window over 10M
candidates / 65536 windows). A beacon window hit means "one of N
candidates"; only the full 128-bit cert-hash rainbow lookup is exact in
practice.

### Selftest output (verbatim)

```
planted: ['+41795551234', '+41796654321', '+41797771001']
[1/3] derive.py vs C-built rainbow_4179.tsv (ground truth):
  rainbow-agree +41795551234: expect '9d5da4158feec5cc162e357565a2c6a4 +41795551234' got '9d5da4158feec5cc162e357565a2c6a4 +41795551234' -> ok
  rainbow-agree +41796654321: expect 'cb44ad65b42dcee072e2a293a608cddd +41796654321' got 'cb44ad65b42dcee072e2a293a608cddd +41796654321' -> ok
  rainbow-agree +41797771001: expect '8afec0aa3626ee7e5b5ff3c5bbb4d668 +41797771001' got '8afec0aa3626ee7e5b5ff3c5bbb4d668 +41797771001' -> ok
[2/3] airdrop_brute (C binary) recovers planted numbers:
  running /Users/peak/coding/0sec-labs/0/research/wireless/airdrop_brute over 10^7 candidates, 6 planted windows
done: 10000000 candidates x 6 windows
  brute-recover +41795551234: ok
  brute-recover +41796654321: ok
  brute-recover +41797771001: ok
  note: 1818 colliding candidates (2-byte truncation is inherently ambiguous over a 10M space) — planted numbers all exact
[3/3] airdrop_crack.py matches planted numbers in synthetic beacon:
  airdrop_crack.py output:
    3 AirDrop-advertising devices, 3 candidates
    MATCH 02:00:00:00:00:00: candidate '+41795551234' (variant '+41795551234') payload 9d5d5da4
    MATCH 02:00:00:00:00:01: candidate '+41796654321' (variant '+41796654321') payload cb4444ad
    MATCH 02:00:00:00:00:02: candidate '+41797771001' (variant '+41797771001') payload 8afefec0
  crack-tool +41795551234: ok
  crack-tool +41796654321: ok
  crack-tool +41797771001: ok
SELFTEST PASS (rainbow=True, brute=True, crack=True)
```

## What the selftest does NOT prove

- **It does not attribute any real-world hit to a real person.** All three
  planted numbers are synthetic. The existing `real_hits.txt` (5,714 hits)
  shows that 2-byte windows over a 10M-candidate space match thousands of
  candidates — an individual hit there is NOT evidence that a specific
  number is behind a specific observed beacon. Linking a hash to a specific
  human being requires the consented protocol below; everything else is a
  candidate set, not an identification.
- It does not validate the derivation against Apple's actual firmware
  behavior beyond the observed-beacon layout assumptions already baked into
  the C sources (`[INFERENCE]` the offsets-0/1 window convention in
  `airdrop_brute.c` matches what real beacons carry; the synthetic-beacon
  phase only tests our own tooling's self-consistency).

## Consent-scoped real-world validation protocol

The only sound way to confirm the derivation against reality:

1. **(a) Capture own device hash.** Put a device you own (your own phone,
   your own Apple ID/phone number) into AirDrop-everyone mode and capture
   its BLE 0x05 beacon payload (and, in a controlled session, its receiver
   cert) with your own scanner. You are the data subject.
2. **(b) Crack.** Run `airdrop_crack.py --candidates` with your own number
   against the captured payload, and/or look up the captured cert's
   `sha256(phone)` 32-hex prefix in the rainbow table.
3. **(c) Confirm number.** The recovered candidate must equal your own
   number exactly (for the 128-bit cert-hash path) or include it (for the
   2-byte window path — expect colliding candidates).
4. **(d) Never target third parties without written consent.** Hashes of
   other people's phone numbers observed in the wild are personal data.
   Do not crack, look up, or attribute any number you do not own or have
   explicit written consent (from the data subject) to test. Any real-world
   validation beyond your own device requires that written consent and a
   lawful basis; ambiguity of 2-byte windows never justifies attributing a
   hit to a specific third party.

## Reproducing

```
cd research/wireless/airdrop_validate
python3 derive.py
```

Requires `../airdrop_brute` (built: `clang -O2 -o airdrop_brute airdrop_brute.c`)
and, for the rainbow-agreement phase, `../rainbow_4179.tsv` (read-only).

## Files

- `derive.py` — reference derivation + selftest (rainbow agreement, brute
  recovery, crack-tool equivalence).
- `selftest_windows.txt` — the 6 planted 2-byte windows.
- `selftest_brute_hits.txt` — raw `airdrop_brute` output over the full
  width-7 space (planted + colliding candidates).
- `selftest_beacons.jsonl`, `selftest_candidates.txt` — synthetic beacon
  capture and candidate list for the crack-tool phase.
