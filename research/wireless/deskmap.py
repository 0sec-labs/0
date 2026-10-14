#!/usr/bin/env python3
"""Stream-parse BLE capture JSONL -> per-identifier desk-stability -> desk_map.{json,md,html}.

Data (same laptop, two scan bursts):
  ble_map.jsonl    : 121.8s scan burst, Oct 13 ~22:37 PT
  radar_live.jsonl : live-radar burst 232.9s, Oct 14 ~00:24 PT (appends live; frozen snapshot used)
  Gap between bursts: ~1.87h.

Desk-stability tiers:
  DESK-CONFIRMED : heard in BOTH bursts (same identifier still audible ~1.87h later)
  SCAN-STABLE    : continuous presence through one burst (coverage>=0.9, <=2 sessions, >=10 obs)
  TRANSIENT      : partial presence (walk-by, brief appearance, or edge-of-range)
"""
import json, os, statistics, html as H

BASE = os.path.dirname(os.path.abspath(__file__))
SNAP = "/tmp/wireless_snapshot"
SOURCES = [("ble_map.jsonl", "ble_map"), ("radar_live.jsonl", "radar_live")]
GAP = 300.0
OUT = os.path.join(BASE, "reports")
os.makedirs(OUT, exist_ok=True)
GENERATED_AT = 1791962945  # unix ts of snapshot copy

def ring(med):
    if med >= -55: return 1
    if med >= -80: return 2
    if med >= -90: return 3
    return 4

devs, window = {}, {}
total_lines = bad_lines = invalid_rssi_obs = 0
snap_counts = {}

for fname, src in SOURCES:
    with open(os.path.join(SNAP, fname), encoding="utf-8") as fh:
        snap_counts[fname] = sum(1 for _ in fh)
    with open(os.path.join(SNAP, fname), encoding="utf-8") as fh:
        for line in fh:                       # streaming: one record in memory at a time
            line = line.strip()
            if not line: continue
            total_lines += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1; continue
            mac, ts, rssi = rec.get("mac"), rec.get("ts"), rec.get("rssi")
            if not mac or ts is None or rssi is None:
                bad_lines += 1; continue
            w = window.setdefault(src, [ts, ts])
            w[0] = min(w[0], ts); w[1] = max(w[1], ts)
            d = devs.setdefault(mac, {"identifier": mac[:8], "mac": mac, "names": set(),
                                      "labels": set(), "sources": {}, "per_src": {},
                                      "obs": 0})
            d["obs"] += 1
            d["sources"][src] = d["sources"].get(src, 0) + 1
            n = rec.get("name") or ""
            if n: d["names"].add(n)
            for lb in rec.get("labels") or []: d["labels"].add(lb)
            ps = d["per_src"].setdefault(src, {"rssis": [], "first": ts, "last": ts,
                                               "sess_first": ts, "sess_last": ts,
                                               "sessions": [], "bad": 0})
            if rssi >= 0:                     # 127 = CoreBluetooth invalid-RSSI placeholder
                ps["bad"] += 1
            else:
                ps["rssis"].append(rssi)
            ps["first"] = min(ps["first"], ts); ps["last"] = max(ps["last"], ts)
            if ts - ps["sess_last"] > GAP:
                ps["sessions"].append(ps["sess_last"] - ps["sess_first"])
                ps["sess_first"] = ts
            ps["sess_last"] = ts

for d in devs.values():
    for ps in d["per_src"].values():
        ps["sessions"].append(ps["sess_last"] - ps["sess_first"])
        del ps["sess_first"]; del ps["sess_last"]

win = {s: {"start": round(t[0], 3), "end": round(t[1], 3),
           "seconds": round(t[1] - t[0], 1), "hours": round((t[1] - t[0]) / 3600, 3)}
       for s, t in window.items()}
gap_h = (window["radar_live"][0] - window["ble_map"][1]) / 3600.0

rows = []
for mac, d in devs.items():
    per_src, all_rssi, presence_s, total_sessions, bad_total = {}, [], 0.0, 0, 0
    for src, ps in d["per_src"].items():
        span = ps["last"] - ps["first"]
        wlen = window[src][1] - window[src][0]
        rss = ps["rssis"]; all_rssi += rss
        per_src[src] = {"obs": d["sources"][src],
                        "first_seen": round(ps["first"], 3), "last_seen": round(ps["last"], 3),
                        "span_s": round(span, 1), "coverage": round(span / wlen, 3),
                        "sessions": len(ps["sessions"]),
                        "rssi_min": min(rss) if rss else None,
                        "rssi_median": statistics.median(rss) if rss else None,
                        "rssi_max": max(rss) if rss else None,
                        "invalid_rssi_obs": ps["bad"]}
        total_sessions += len(ps["sessions"]); presence_s += span; bad_total += ps["bad"]
    med = statistics.median(all_rssi) if all_rssi else None
    persist = len(d["per_src"]) >= 2
    cont = any(v["coverage"] >= 0.9 and v["sessions"] <= 2 and d["sources"][s] >= 10
               for s, v in per_src.items())
    if persist:
        tier, cls = "desk_confirmed", "DESK-STABLE"
    elif cont:
        tier, cls = "scan_stable", "DESK-STABLE"
    else:
        tier, cls = "transient", "TRANSIENT"
    rows.append({"identifier": d["identifier"], "mac": mac,
                 "names": sorted(d["names"]), "labels": sorted(d["labels"]),
                 "sources": d["sources"], "per_source": per_src, "obs": d["obs"],
                 "first_seen": round(min(p["first"] for p in d["per_src"].values()), 3),
                 "last_seen": round(max(p["last"] for p in d["per_src"].values()), 3),
                 "presence_hours": round(presence_s / 3600, 4),
                 "sessions_total": total_sessions,
                 "rssi_min": min(all_rssi) if all_rssi else None,
                 "rssi_median": med, "rssi_max": max(all_rssi) if all_rssi else None,
                 "invalid_rssi_obs": bad_total,
                 "ring": ring(med) if med is not None else None,
                 "persistent_across_captures": persist,
                 "tier": tier, "class": cls})

rows.sort(key=lambda r: (-r["presence_hours"], -r["obs"]))
for i, r in enumerate(rows, 1): r["rank"] = i

stable = [r for r in rows if r["class"] == "DESK-STABLE"]
confirmed = [r for r in rows if r["tier"] == "desk_confirmed"]
named = [r for r in rows if r["names"]]
named_stable = [r for r in named if r["class"] == "DESK-STABLE"]
top20 = rows[:20]

def hms(ts):
    # local time PT = UTC-7
    import datetime
    return datetime.datetime.fromtimestamp(ts, datetime.timezone(datetime.timedelta(hours=-7)))\
        .strftime("%H:%M:%S")

data = {
    "generated": "2026-10-14",
    "generated_at_unix": GENERATED_AT,
    "source_snapshot": SNAP,
    "sources": ["ble_map.jsonl", "radar_live.jsonl"],
    "snapshot_lines": snap_counts,
    "method": {
        "streaming": "line-by-line JSONL; per-identifier session split at gap>300s",
        "ring_thresholds_median_rssi": {"ring1": ">= -55", "ring2": ">= -80",
                                        "ring3": ">= -90", "ring4": "< -90"},
        "tier_rules": {
            "desk_confirmed": "identifier heard in BOTH capture bursts (~1.87h apart)",
            "scan_stable": "coverage>=0.9 of one capture window, <=2 sessions, >=10 obs",
            "transient": "everything else (partial presence / walk-by)",
        },
        "invalid_rssi": "rssi=127 (CoreBluetooth invalid placeholder) excluded from RSSI stats, obs kept",
    },
    "captures": win,
    "gap_between_captures_hours": round(gap_h, 2),
    "total_lines": total_lines, "bad_lines": bad_lines,
    "total_identifiers": len(rows),
    "total_observations": sum(r["obs"] for r in rows),
    "desk_stable_count": len(stable),
    "desk_confirmed_count": len(confirmed),
    "scan_stable_count": len(stable) - len(confirmed),
    "transient_count": len(rows) - len(stable),
    "named_identifiers": [r["identifier"] for r in named],
    "named_desk_stable_identifiers": [r["identifier"] for r in named_stable],
    "records": rows,
}
with open(os.path.join(OUT, "desk_map.json"), "w") as f:
    json.dump(data, f, indent=1)

# ---------------- markdown ----------------
def rowline(i, r):
    names = ", ".join(r["names"]) or "unnamed"
    srcs = "+".join(f"{s}:{v['obs']}" for s, v in sorted(r["per_source"].items()))
    return (f"| {i} | `{r['identifier']}` | {H.escape(names)} | {r['obs']} | {r['rssi_min']} | "
            f"{r['rssi_median']} | {r['rssi_max']} | {r['ring']} | {r['sessions_total']} | "
            f"{srcs} | {r['class']} |")

md = []
A = md.append
A("# Desk map — persistent workplace tracking from one laptop")
A("")
A(f"_Generated 2026-10-14 from a frozen snapshot of `ble_map.jsonl` "
  f"({snap_counts.get('ble_map.jsonl')} lines) and `radar_live.jsonl` "
  f"({snap_counts.get('radar_live.jsonl')} lines, live feed, copied at unix {GENERATED_AT}). "
  f"Raw per-identifier table: `desk_map.json`._")
A("")
A("## Capture reality check")
A("")
A(f"The two input files are **two short scan bursts from the same laptop**, not one continuous "
  f"monitoring session:")
A("")
A(f"- `ble_map.jsonl`: {win['ble_map']['seconds']}s burst ({hms(win['ble_map']['start'])}–"
  f"{hms(win['ble_map']['end'])} PT), {data['snapshot_lines']['ble_map.jsonl']} lines")
A(f"- `radar_live.jsonl`: {win['radar_live']['seconds']}s burst ({hms(win['radar_live']['start'])}–"
  f"{hms(win['radar_live']['end'])} PT), {data['snapshot_lines']['radar_live.jsonl']} lines (still appending when snapshotted)")
A(f"- Gap between the bursts: **{data['gap_between_captures_hours']}h**")
A("")
A(f"Total: **{data['total_identifiers']} unique persistent identifiers**, "
  f"**{data['total_observations']} observations**, {data['bad_lines']} malformed lines discarded. "
  f"{rows and sum(r['invalid_rssi_obs'] for r in rows)} observations carried rssi=127 "
  f"(CoreBluetooth's invalid-RSSI placeholder) and are excluded from RSSI statistics.")
A("")
A("## How a device earns DESK-STABLE")
A("")
A("A 2-minute burst can't distinguish a desk from a parked human by session count alone — every "
  "device here shows 1–2 sessions because the windows are short. So stability is graded:")
A("")
A("1. **DESK-CONFIRMED** — the *same identifier* is audible in both bursts, {gap}h apart. That is "
  "the signature of hardware that lives at a fixed spot (desk, docked phone, peripherals)."
  .format(gap=data['gap_between_captures_hours']))
A("2. **SCAN-STABLE** — present for ≥90% of one burst in ≤2 sessions with ≥10 observations: "
  "continuously advertising during the whole scan = stationary during that scan, but only proven "
  "for that moment.")
A("3. **TRANSIENT** — partial presence: walk-bys, brief appearances, edge-of-range flicker.")
A("")
A("## Headline numbers")
A("")
A(f"- Total unique identifiers tracked: **{data['total_identifiers']}**")
A(f"- Desk-stable total: **{data['desk_stable_count']}** "
  f"({data['desk_confirmed_count']} desk-confirmed + {data['scan_stable_count']} scan-stable); "
  f"transient: {data['transient_count']}")
A(f"- Named devices heard: **{len(named)}** — "
  + ", ".join(f"`{r['identifier']}` *{', '.join(r['names'])}*" for r in named))
A(f"- Named devices that are desk-stable: **{len(named_stable)}**")
A("")
if confirmed:
    A("## DESK-CONFIRMED (heard in both bursts, {}h apart)".format(data['gap_between_captures_hours']))
    A("")
    A("| rank | id | name | obs | rssi min | med | max | ring | sessions | src | class |")
    A("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in confirmed:
        A(rowline(r["rank"], r))
    A("")
A("## Top 20 by within-capture presence")
A("")
A("| rank | id | name | obs | rssi min | med | max | ring | sess | src:obs | class |")
A("|---|---|---|---|---|---|---|---|---|---|---|")
for i, r in enumerate(top20, 1):
    A(rowline(i, r))
A("")
A("Ring = median-RSSI band (ring1 ≥ −55, ring2 ≥ −80, ring3 ≥ −90, else ring4).")
A("")
A("## Named devices, cross-referenced")
A("")
for r in named:
    A(f"- `{r['identifier']}` **{', '.join(r['names'])}** — rank {r['rank']}, {r['obs']} obs, "
      f"median RSSI {r['rssi_median']} (ring {r['ring']}), "
      f"{r['class'].lower()} ({r['tier']})")
A("")
if confirmed:
    pk = confirmed[0]
    a, b = pk["per_source"]["ble_map"], pk["per_source"]["radar_live"]
    A(f"`{pk['identifier']}` (**{', '.join(pk['names'])}**) is the only identifier present in "
      f"*both* bursts: {a['obs']} obs covering {a['coverage']*100:.0f}% of the first burst, then "
      f"{b['obs']} obs covering {b['coverage']*100:.0f}% of the second burst "
      f"{data['gap_between_captures_hours']} hours later. **The named phone did not move "
      f"meaningfully between the two scans — and a passive laptop-side listener can say so with "
      f"zero pairing, zero connection, zero user interaction.** [INFERENCE: stationary from "
      f"continuous presence; the phone could also have been moved and returned within an "
      f"unobserved gap.]")
A("")
A("## What this proves about workplace tracking")
A("")
A(f"- From a single stock laptop with no special hardware, a pair of passive scans totaling "
  f"**{(win['ble_map']['hours'] + win['radar_live']['hours']) * 60:.1f} minutes** enumerated "
  f"**{data['total_identifiers']} devices** and fingerprinted "
  f"**{data['desk_stable_count']} of them as desk-stable** — including one device carrying a "
  f"human-readable name (`PeakPhone`).")
A("- Randomized MACs do not help: Apple's Continuity peripherals (Handoff/NearbyInfo/FindMy) "
  "re-use a stable per-device identifier in the `mac` field of these captures, so the same "
  "physical device is recognized burst-to-burst — that is what makes cross-burst persistence "
  "visible at all.")
A("- Device names leak third-party identity: `Doruk Tan’s Backpack` (an AirTag-style FindMy "
  "beacon advertising its owner's name) and `BCPro_203739` were both heard; a co-worker's "
  "bag is locatable from your desk.")
A("- RSSI medians place stationary devices into rooms: 6F.../ED.../3D... sit in ring 3 "
  "(another floor/room) yet were continuously present through the whole live burst — "
  "neighboring desks, not visitors.")
A(f"[INFERENCE] With continuous monitoring instead of two bursts, the desk-confirmed set would "
  f"grow well beyond one device: all {data['scan_stable_count']} scan-stable devices already show "
  f"multi-minute continuous presence and would likely re-appear on every repeat scan.")
A("")
with open(os.path.join(OUT, "desk_map.md"), "w") as f:
    f.write("\n".join(md) + "\n")

# ---------------- html (SVG timeline of top 20, one panel per burst) ----------------
RINGCOL = {1: "#e53935", 2: "#fb8c00", 3: "#43a047", 4: "#8e8e8e"}
PLOT_L, PLOT_W, BARH, GAPY = 160, 720, 20, 6

def panel(src, y_top, rows):
    w = win[src]
    t0s, t1s = w["start"], w["end"]
    def X(t): return PLOT_L + (t - t0s) / (t1s - t0s) * PLOT_W
    out = [f'<text x="{PLOT_L}" y="{y_top - 14}" font-size="13" font-weight="bold">'
           f'Burst: {src} ({w["seconds"]}s, {hms(t0s)}–{hms(t1s)} PT)</text>']
    out.append(f'<rect x="{PLOT_L}" y="{y_top}" width="{PLOT_W}" '
               f'height="{len(rows) * (BARH + GAPY) - GAPY}" fill="#f4f4f4"/>')
    out.append(f'<text x="{PLOT_L}" y="{y_top - 2}" font-size="10" fill="#555">{hms(t0s)}</text>')
    out.append(f'<text x="{PLOT_L + PLOT_W}" y="{y_top - 2}" font-size="10" fill="#555" text-anchor="end">{hms(t1s)}</text>')
    for i, r in enumerate(rows):
        y = y_top + i * (BARH + GAPY)
        label = ", ".join(r["names"]) or r["identifier"]
        out.append(f'<text x="{PLOT_L - 8}" y="{y + BARH - 5}" text-anchor="end" font-size="11">'
                   f'{H.escape(label[:26])}</text>')
        p = r["per_source"].get(src)
        if p:
            x0, x1 = X(p["first_seen"]), X(p["last_seen"])
            c = RINGCOL[r["ring"]] if r["ring"] else "#ccc"
            out.append(f'<rect x="{x0:.1f}" y="{y}" width="{max(x1 - x0, 2):.1f}" height="{BARH}" '
                       f'fill="{c}" rx="3"><title>{r["identifier"]} {src} obs={p["obs"]} '
                       f'rssi_med={p["rssi_median"]} coverage={p["coverage"]} ring={r["ring"]}</title></rect>')
    return out

svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{PLOT_L + PLOT_W + 30}" '
       f'height="{2 * (len(top20) * (BARH + GAPY) + 60)}" font-family="monospace">']
svg += panel("ble_map", 40, top20)
y2 = len(top20) * (BARH + GAPY) + 90
svg += panel("radar_live", y2, top20)
ly = 2 * (len(top20) * (BARH + GAPY) + 60) - 20
for ring_n, col in RINGCOL.items():
    x = PLOT_L + (ring_n - 1) * 150
    svg.append(f'<rect x="{x}" y="{ly - 10}" width="12" height="12" fill="{col}" rx="2"/>')
    svg.append(f'<text x="{x + 18}" y="{ly}" font-size="11">ring {ring_n}</text>')
svg.append('</svg>')
html_doc = (f'<!doctype html><meta charset="utf-8"><title>desk map</title>'
            f'<body style="background:#fff;font-family:sans-serif;max-width:940px;margin:2em auto">'
            f'<h1>Desk map — top 20 presence timeline</h1>'
            f'<p>{data["total_identifiers"]} identifiers / {data["total_observations"]} obs; '
            f'{data["desk_stable_count"]} desk-stable; bar color = ring (red 1 → gray 4). '
            f'Data: desk_map.json</p>' + "\n".join(svg) + '</body>')
with open(os.path.join(OUT, "desk_map.html"), "w") as f:
    f.write(html_doc)

print(f"OK ids={len(rows)} obs={data['total_observations']} stable={len(stable)} "
      f"confirmed={len(confirmed)} named={len(named)}")
for r in confirmed: print("CONFIRMED", r["identifier"], r["names"], r["per_source"])
print("md/json/html written to", OUT)
