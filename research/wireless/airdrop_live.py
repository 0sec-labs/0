#!/usr/bin/env python3
"""AirDrop OWT live reveal: passive BLE capture -> dual-window identification.

Pipeline: CoreBluetooth advertisement JSONL (ble_map / ble_scan format:
{"ts","mac","rssi","name","labels":["AirDrop"],"mfg":"4c00..."}) -> parse
Apple TLV 0x05 payloads -> extract the dual 2-byte windows (w1 = payload
bytes 0-1, w2 = payload bytes 2-3, big-endian — the synthetic-beacon
convention proven in airdrop_validate/derive.py; a full adjacent-window
sweep over the real 18-byte payload runs as a diagnostic since real payloads
carry hash1/hash2 for possibly different contacts) -> matcher.identify()
over the +4179 width-7 number space.

CONSENT SCOPE: passive receive-only against third parties; identification
runs ONLY on this team's owned/consented devices (lab Macs, team phones).
This tool never transmits anything. See reports/airdrop_reveal.md.

Modes:
  --replay FILE.jsonl   offline analysis of a capture (also used by selftest)
  --live SECONDS        run ./ble_map for N seconds, then analyze its JSONL
  --selftest            inject the 3 planted (w1,w2) pairs through the full
                        pipeline and assert recovery

Run with the project venv: /Users/peak/coding/0sec-labs/marauder/.venv/bin/python
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "airdrop_validate"))
import derive  # noqa: E402
import matcher  # noqa: E402

BLE_MAP = os.path.join(HERE, "ble_map")
WINDOWS_TXT = os.path.join(HERE, "windows.txt")
IDENT_CACHE = {}  # (w1, w2) -> candidate set


def identify_cached(w1, w2):
    if (w1, w2) not in IDENT_CACHE:
        IDENT_CACHE[(w1, w2)] = matcher.identify(w1, w2)
    return IDENT_CACHE[(w1, w2)]


def airdrop_records(jsonl_path):
    """Yield {ts, mac, rssi, name, payload(bytes), mfghex} for every record
    whose manufacturer data carries an Apple TLV 0x05 (AirDrop)."""
    with open(jsonl_path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            mfg = bytes.fromhex(rec.get("mfg", ""))
            if mfg[:2] != b"\x4c\x00" or len(mfg) < 4:
                continue
            for payload in matcher.parse_tlv05(mfg):
                yield {"ts": rec.get("ts", 0.0), "mac": rec.get("mac", "?"),
                       "rssi": rec.get("rssi", 0), "name": rec.get("name", ""),
                       "payload": payload, "mfg": rec.get("mfg", "")}


def fmt_ts(ts):
    return dt.datetime.fromtimestamp(ts).strftime("%H:%M:%S")


def analyze(jsonl_path, label, log=lambda m: print(m, flush=True)):
    """Full pipeline over a JSONL capture. Returns True if it ran clean."""
    events = list(airdrop_records(jsonl_path))
    if not events:
        log(f"[{label}] no Apple TLV 0x05 (AirDrop) records in {jsonl_path}")
        return False
    log(f"[{label}] {len(events)} AirDrop-advertisement records "
        f"from {len({e['mac'] for e in events})} device(s)")

    tracks = {}
    for e in events:
        tr = tracks.setdefault(e["mac"], {"first": e["ts"], "last": e["ts"],
                                          "rssi_min": 999, "rssi_max": -999,
                                          "hits": 0, "name": e["name"]})
        tr["last"] = max(tr["last"], e["ts"])
        tr["first"] = min(tr["first"], e["ts"])
        tr["hits"] += 1
        tr["rssi_min"] = min(tr["rssi_min"], e["rssi"])
        tr["rssi_max"] = max(tr["rssi_max"], e["rssi"])
        if e["name"]:
            tr["name"] = e["name"]

    unique_payloads = sorted({e["payload"] for e in events})
    log(f"[{label}] {len(unique_payloads)} unique 0x05 payload(s); "
        f"running dual-window identification (10^7 sha256/scan, cached)")

    # observed windows = all sliding windows per payload (windows.txt method)
    observed = {}
    for pl in unique_payloads:
        for i in range(len(pl) - 1):
            observed.setdefault((pl[i] << 8) | pl[i + 1], set()).add(pl)

    log("")
    log(f"{'MAC':<40} {'hits':>4}  {'rssi':<9} {'first→last':<17} candidates")
    for mac, tr in sorted(tracks.items()):
        mac_payloads = {e["payload"] for e in events if e["mac"] == mac}
        cands = set()
        for pl in mac_payloads:
            pair = matcher.pair_from_payload(pl)
            if pair is not None:
                cands |= identify_cached(*pair)
        shown = ", ".join(sorted(cands)) if cands else \
            f"(no candidate in +4179 space — {len(cands)} match)"
        log(f"{mac:<40} {tr['hits']:>4}  {tr['rssi_min']:>4}..{tr['rssi_max']:<4} "
            f"{fmt_ts(tr['first'])}→{fmt_ts(tr['last']):<8} {shown}")
    log("")

    for n, pl in enumerate(unique_payloads):
        pair = matcher.pair_from_payload(pl)
        log(f"[{label}] payload#{n} {pl.hex()}")
        cp = identify_cached(*pair) if pair else set()
        log(f"  canonical pair ({pair[0]:04x},{pair[1]:04x}) -> {sorted(cp) or '∅'}")
        pairs = matcher.pair_sweep(pl)
        counts = [len(identify_cached(*p)) for p in pairs]
        log(f"  adjacent-window sweep: {len(pairs)} pairs, "
            f"{counts.count(1)} yield exactly 1 candidate, "
            f"{counts.count(0)} yield 0, "
            f"{sum(1 for c in counts if c > 1)} yield >1")
        for p, c in zip(pairs, counts):
            if c == 1:
                log(f"    singleton pair {p} -> {sorted(identify_cached(*p))}")
        if len(pl) > 4:  # real 18-byte layout: hash1/hash2 fields of possibly
            h1, h2 = (pl[0] << 8) | pl[1], (pl[2] << 8) | pl[3]  # diff contacts
            s1 = identify_cached_pair_single(h1)
            s2 = identify_cached_pair_single(h2)
            log(f"  hash fields in isolation: {h1:04x} -> {len(s1)} candidates, "
                f"{h2:04x} -> {len(s2)} candidates (single-window ambiguity persists)")

    # the brief's replay metric: of the observed windows, how many identify
    # uniquely under dual-window (some adjacent co-window in the same ad)
    uniquely = {}
    for w, pls in sorted(observed.items()):
        for pl in pls:
            for i in range(len(pl) - 2):
                a = (pl[i] << 8) | pl[i + 1]
                b = (pl[i + 1] << 8) | pl[i + 2]
                if w not in (a, b):
                    continue
                c = identify_cached(a, b)
                if len(c) == 1:
                    uniquely.setdefault(w, set()).add(
                        (b if a == w else a, next(iter(c))))
    log(f"[{label}] observed windows: {len(observed)}; "
        f"uniquely identifying under dual-window (some co-window in the "
        f"same ad): {len(uniquely)}")
    for w, partners in sorted(uniquely.items()):
        for co, phone in sorted(partners):
            log(f"    {w:04x} + co-window {co:04x} -> {phone}")
    log(f"  caveat: pair entropy is 24 bits (windows overlap at digest byte "
        f"1) -> 10^7/2^24 ≈ 0.60 expected candidates/pair; singletons from "
        f"unrelated window pairs are Poisson noise, not identification")
    return True


def sliding(pl):
    return [(pl[i] << 8) | pl[i + 1] for i in range(len(pl) - 1)]


def identify_cached_pair_single(w):
    # match_single is expensive per window; cache it too
    key = ("single", w)
    if key not in IDENT_CACHE:
        IDENT_CACHE[key] = matcher.match_single(w)
    return IDENT_CACHE[key]


# ------------------------------------------------------------------ modes

def live(seconds, log=lambda m: print(m, flush=True)):
    """Real capture: subprocess the compiled ble_map (passive, receive-only)
    for N seconds, then analyze the JSONL it appended."""
    if not os.path.exists(BLE_MAP):
        sys.exit(f"missing {BLE_MAP} (build: swiftc -O ble_map.swift -o ble_map)")
    out = os.path.join(tempfile.gettempdir(), f"ble_map_live_{dt.datetime.now():%Y%m%d_%H%M%S}.jsonl")
    log(f"[live] {BLE_MAP} {seconds}s -> {out} (passive scan; approve Bluetooth "
        f"for this terminal if state 4/UNAUTHORIZED appears)")
    r = subprocess.run([BLE_MAP, str(seconds), out], cwd=HERE,
                       capture_output=True, text=True)
    for line in r.stdout.strip().splitlines():
        log(f"  ble_map| {line}")
    if r.returncode != 0:
        log(f"[live] ble_map exited {r.returncode}: {r.stderr.strip()}")
        return 1
    ok = analyze(out, "live")
    log(f"[live] raw JSONL kept at {out} for replay")
    return 0 if ok else 1


def selftest(log=lambda m: print(m, flush=True)):
    """Inject the 3 planted (w1,w2) pairs as synthetic TLV-0x05 beacons and
    run the identical replay pipeline; assert recovery."""
    path = os.path.join(HERE, "airdrop_validate", "live_selftest_beacons.jsonl")
    with open(path, "w") as fh:
        for i, p in enumerate(derive.PLANTED):
            d = derive.derive_hash(p)
            payload = bytes([d[0], d[1], d[1], d[2]])  # w1 || w2, big-endian
            # real wire format (ble_map.jsonl): company id bytes 4c 00,
            # then TLV type/len — NOT derive.py's flipped 004c convention
            mfg = "4c00" + "05" + f"{len(payload):02x}" + payload.hex()
            fh.write(json.dumps({"ts": 1791955859.0 + i, "mac": f"02:00:00:00:00:{i:02x}",
                                 "rssi": -50, "name": f"planted-{i}",
                                 "labels": ["AirDrop"], "mfg": mfg}) + "\n")
    log(f"[selftest] planted beacons written to {path}")
    # suppress the sweep's 10M-scans (planted payloads are 4 bytes = 2 pairs)
    ok = analyze(path, "selftest")
    # hard assertions: per-mac candidate set contains exactly the planted
    # number (plus at most one genuine 3-byte digest-prefix collider)
    events = list(airdrop_records(path))
    by_mac = {}
    for e in events:
        pair = matcher.pair_from_payload(e["payload"])
        by_mac.setdefault(e["mac"], set()).update(identify_cached(*pair))
    for i, p in enumerate(derive.PLANTED):
        mac = f"02:00:00:00:00:{i:02x}"
        cands = by_mac.get(mac, set())
        hit = p in cands and len(cands) <= 2
        ok &= hit
        log(f"[selftest] {mac} -> {sorted(cands)} planted {p}: "
            f"{'ok' if hit else 'FAIL'}")
    log(f"LIVE SELFTEST {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--replay", metavar="FILE.jsonl")
    g.add_argument("--live", type=int, metavar="SECONDS")
    g.add_argument("--selftest", action="store_true")
    ap.add_argument("--windows", default=WINDOWS_TXT,
                    help="observed-window list to cross-check (default windows.txt)")
    args = ap.parse_args()
    log = lambda m: print(m, flush=True)
    if args.selftest:
        sys.exit(0 if selftest() else 1)
    if args.replay:
        ok = analyze(args.replay, f"replay:{os.path.basename(args.replay)}")
        if os.path.exists(args.windows):
            observed = set()
            for e in airdrop_records(args.replay):
                observed.update(sliding(e["payload"]))
            listed = {int(x, 16) for x in open(args.windows).read().split()}
            log(f"[replay] windows.txt cross-check: {len(observed)} observed vs "
                f"{len(listed)} listed, overlap {len(observed & listed)}")
        sys.exit(0 if ok else 1)
    if args.live is not None:
        sys.exit(live(args.live))


if __name__ == "__main__":
    main()
