#!/usr/bin/env python3
"""Proximity map generator — renders ble_map.jsonl as a spatial-style report.

Reads the JSONL stream from ble_map and emits:
  1. A markdown "radar map" (device rings by signal distance bucket)
  2. A mermaid timeline of the loudest trackers (presence over capture window)
  3. Category counts

Usage: python3 mapgen.py [ble_map.jsonl] [--out map.md]
"""
import json
import sys
from collections import defaultdict

DEFAULT = "ble_map.jsonl"


def load(path):
    tracks = {}
    with open(path) as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            mac = rec["mac"]
            t = tracks.setdefault(mac, {
                "name": "", "labels": set(), "rssi_min": 0, "rssi_max": -200,
                "first": rec["ts"], "last": rec["ts"], "hits": 0})
            t["hits"] += 1
            t["last"] = rec["ts"]
            t["labels"].update(rec.get("labels") or [])
            r = rec["rssi"]
            if r != 127:  # invalid marker
                t["rssi_max"] = max(t["rssi_max"], r)
                t["rssi_min"] = min(t["rssi_min"] if t["rssi_min"] else r, r)
            if rec.get("name"):
                t["name"] = rec["name"]
    return tracks


def bucket(r):
    if r >= -55: return 0  # ring 1
    if r >= -75: return 1
    if r >= -90: return 2
    return 3


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    tracks = load(path)
    rings = defaultdict(list)
    for mac, t in tracks.items():
        if t["rssi_max"] <= -200:
            continue
        rings[bucket(t["rssi_max"])].append((mac, t))

    names = {c: label for c, label in
             [(0, "RING 1 — within arm's reach (<3m)"),
              (1, "RING 2 — same room (3-10m)"),
              (2, "RING 3 — building floor (10-25m)"),
              (3, "RING 4 — edge of range")]}

    lines = ["# Nearby-device radar map", "", f"_Capture: {path}_", ""]
    for ring in range(4):
        devs = sorted(rings[ring], key=lambda x: -x[1]["hits"])
        if not devs:
            continue
        lines.append(f"## {names[ring]}")
        lines.append("")
        for mac, t in devs:
            nm = t["name"] or "unnamed"
            lbl = ",".join(sorted(t["labels"]))
            lines.append(f"- `{mac[:8]}` **{nm}** — {lbl} (rssi {t['rssi_max']}..{t['rssi_min']}, {t['hits']} obs)")
        lines.append("")

    # mermaid timeline for top trackers
    top = sorted(tracks.items(), key=lambda kv: -kv[1]["hits"])[:8]
    if top:
        lines += ["```mermaid", "gantt", "    title Top devices by observation count", "    dateFormat X", "    axisFormat %s"]
        for mac, t in top:
            nm = t["name"] or mac[:8]
            lines.append(f"    {nm} :a{mac[:6]}, {int(t['first']*1000)}, {int((t['last']-t['first'])*1000)}")
        lines.append("```")

    counts = defaultdict(int)
    for t in tracks.values():
        for l in t["labels"]:
            counts[l] += 1
    lines += ["", "## Category counts", ""]
    for lbl, n in sorted(counts.items(), key=lambda x: -x[1]):
        lines.append(f"- {lbl}: {n}")

    out = "\n".join(lines)
    print(out)
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        with open(sys.argv[i + 1], "w") as fh:
            fh.write(out + "\n")


if __name__ == "__main__":
    main()
