#!/Users/peak/coding/0sec-labs/marauder/.venv/bin/python
"""correlate.py — AWDL presence <-> BLE continuity correlation analysis over session.jsonl.

Hypothesis: an Apple device's AWDL presence (wifip2pd peer events) co-occurs in time with
its BLE Continuity identity (stable per-device UUID from ble_map), because both radios
wake together for AirDrop/Handoff/UCG proximity events.

Analyses:
  (a) time-window correlation — per AWDL peer presence event, BLE identifiers whose
      observation count in [-10s, +10s] spikes over their baseline rate;
  (b) stability — BLE-id <-> AWDL-MAC transition graph over the session, plus our own
      awdl0 randomized-MAC rotation log;
  (c) BT-off signature detector — AWDL peer presence persisting while every BLE stream
      goes silent (only PROVABLE on a team device we toggle ourselves; see
      btoff_experiment.md).

Usage: correlate.py [session.jsonl] [--window 10] [--json]
"""
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(path):
    peers, ble, macs = [], [], []
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            k, d = r.get("kind"), r.get("data", {})
            if k == "awdl_peer":
                peers.append((r["ts"], d.get("event"), d.get("peer_mac")))
            elif k == "ble_obs":
                ident = d.get("mac")
                if ident and not d.get("error"):
                    ble.append((r["ts"], ident, d.get("rssi"),
                                tuple(d.get("labels", [])), d.get("source")))
            elif k == "awdl_mac_change":
                macs.append((r["ts"], d.get("from"), d.get("to"), d.get("note")))
    return peers, ble, macs


def report(path, win=10.0):
    peers, ble, macs = load(path)
    if not ble and not peers:
        print("EMPTY session — nothing to correlate.")
        return
    t0 = min([t for t, *_ in ble + peers] or [0])
    t1 = max([t for t, *_ in ble + peers] or [0])
    dur = max(t1 - t0, 1)
    out = []
    out.append(f"session: {path}  span {dur:.0f}s "
               f"({datetime.fromtimestamp(t0, timezone.utc):%Y-%m-%d %H:%M:%S}Z +)")
    out.append(f"records: {len(peers)} awdl_peer events, {len(ble)} ble_obs, "
               f"{len(macs)} awdl_mac_change")

    # ---- own-MAC rotation (b) ------------------------------------------------
    out.append("\n== (b1) own awdl0 randomized-MAC rotation ==")
    seen_macs = []
    for ts, frm, to, note in macs:
        if note:
            continue
        seen_macs.append((ts, frm, to))
        out.append(f"  +{ts - t0:7.0f}s  {frm} -> {to}")
    if not seen_macs:
        out.append("  no rotation observed during session (common when idle)")
    session_awdl_macs = {frm for _, frm, _ in seen_macs if frm} | \
                        {to for _, _, to in seen_macs if to}

    # ---- BLE id overview -----------------------------------------------------
    ids = defaultdict(lambda: {"n": 0, "labels": Counter(), "rssi": []})
    for ts, ident, rssi, labels, src in ble:
        ids[ident]["n"] += 1
        ids[ident]["rssi"].append(rssi if isinstance(rssi, (int, float)) else None)
        for lb in labels:
            ids[ident]["labels"][lb] += 1
    out.append(f"\n== BLE identity surface: {len(ids)} distinct identifiers ==")
    for ident, st in sorted(ids.items(), key=lambda kv: -kv[1]["n"]):
        rss = [r for r in st["rssi"] if r is not None]
        rs = f"{min(rss)}..{max(rss)}" if rss else "-"
        out.append(f"  {ident[:38]:38s} n={st['n']:4d} rssi={rs:12s} "
                   f"labels={dict(st['labels'])}")
    span_per_id = {i: (max(t for t, id_, *_ in ble if id_ == i)
                       - min(t for t, id_, *_ in ble if id_ == i)) for i in ids}

    # ---- (a) time-window correlation ----------------------------------------
    out.append(f"\n== (a) time-window correlation (+-{win:.0f}s around AWDL presence) ==")
    pres = [(t, m) for t, ev, m in peers if ev == "presence"]
    per_event = Counter(m for _, m in pres)
    rate = {i: ids[i]["n"] / dur for i in ids}  # baseline obs/sec per BLE id
    ble_by_id = defaultdict(list)
    for t, ident, *_ in ble:
        ble_by_id[ident].append(t)

    def co_count(pt, ident, w=None):
        w = win if w is None else w
        return sum(1 for t in ble_by_id[ident] if abs(t - pt) <= w)

    # base rates: fraction of uniformly random instants where the BLE id shows up
    # in a co-occurrence window (controls for always-present advertisers). Computed
    # for BOTH the loose +-win window (used in (a)) and the tight one (used in (b2)).
    tight = min(win, 2.0)
    n_rand = min(len(pres), 200) if pres else 1
    base, base_tight = {}, {}
    for ident in ids:
        hits_r = hits_t = 0
        for k in range(n_rand):
            rt = t0 + (k + 0.5) * dur / max(n_rand, 1)
            if co_count(rt, ident) >= 1:
                hits_r += 1
            if co_count(rt, ident, tight) >= 1:
                hits_t += 1
        base[ident] = hits_r / max(n_rand, 1)
        base_tight[ident] = hits_t / max(n_rand, 1)

    edges = defaultdict(int)          # (peer_mac, ble_id) -> co-occurring event count
    co_events = defaultdict(int)      # peer_mac -> events with any co-occurrence
    hits, spikes = 0, 0
    for pt, pm in pres:
        hits += 1
        lines = []
        for ident in ids:
            c = co_count(pt, ident)
            exp = rate[ident] * 2 * win
            if c >= 1:
                edges[(pm, ident)] += 1
            # strict Poisson spike: >=2 obs AND count exceeds lambda+2*sqrt(lambda)
            if c >= 2 and c > exp + 2 * math.sqrt(max(exp, 1e-9)):
                spikes += 1
                lines.append(f"{ident[:32]} SPIKE (c={c}, exp={exp:.2f})")
            elif c >= 1:
                lines.append(f"{ident[:32]} (c={c})")
        if lines:
            co_events[pm] += 1
            out.append(f"  +{pt - t0:7.0f}s  AWDL peer {pm}  <-  " + "; ".join(lines[:4]))
    if not hits:
        out.append("  (no AWDL peer presence events captured)")
    elif not spikes and not co_events:
        out.append("  no BLE identifier observed near any AWDL presence event "
                   "(honest null: co-occurrence not observed in this window)")

    # ---- (b2) stability graph ------------------------------------------------
    # Tight (+-2s) window + precision test: a REAL pairing means the BLE id's own
    # observations cluster at the peer's event times, not just anywhere in the span.
    tight = min(win, 2.0)
    out.append(f"\n== (b2) BLE-id <-> AWDL-MAC stability graph (tight +-{tight:.0f}s, "
               "lift+precision-filtered) ==")
    strong = []
    for (pm, ident) in edges:
        n_ev = per_event[pm]
        w = sum(1 for pt, m2 in pres if m2 == pm and co_count(pt, ident, tight) >= 1)
        co_rate = w / max(n_ev, 1)
        lift = co_rate / base_tight[ident] if base_tight[ident] > 0 else float("inf")
        n_id = ids[ident]["n"]
        prec = sum(1 for t in ble_by_id[ident]
                   if any(abs(t - pt) <= tight for pt, m2 in pres if m2 == pm)) / max(n_id, 1)
        if co_rate >= 0.5 and lift >= 1.5 and w >= 5 and prec >= 0.5:
            strong.append((lift, co_rate, prec, w, n_ev, pm, ident))
    if strong:
        for lift, co_rate, prec, w, n_ev, pm, ident in sorted(strong, reverse=True):
            out.append(f"  AWDL {pm}  <->  BLE {ident[:38]:38s} "
                       f"co={w}/{n_ev} co_rate={co_rate:.2f} prec={prec:.2f} "
                       f"lift={lift:.1f}")
        by_mac = defaultdict(set)
        for lift, co_rate, prec, w, n_ev, pm, ident in strong:
            by_mac[pm].add(ident)
        for pm, idset in by_mac.items():
            if len(idset) == 1:
                out.append(f"  -> UNIQUE pairing candidate: {pm} == "
                           f"{next(iter(idset))[:38]}")
    else:
        out.append("  no stable co-occurrence edges (need longer session or active "
                   "AirDrop/Handoff stimulus)")
    per_mac = per_event
    out.append(f"  AWDL peer MACs this session: {len(per_mac)} distinct, "
               + ", ".join(f"{m} x{n}" for m, n in per_mac.most_common(8)))

    # ---- (c) BT-off signature detector ---------------------------------------
    out.append("\n== (c) BT-off signature scan (AWDL alive while BLE silent) ==")
    strong_ids = {ident for _, _, _, _, _, _, ident in strong}
    any_line = False
    for i, st in ids.items():
        ts_i = sorted(t for t, id_, *_ in ble if id_ == i)
        gaps = [(b - a, a) for a, b in zip(ts_i, ts_i[1:]) if b - a > 60]
        for gap, at in gaps[:3]:
            awdl_in_gap = [m for t, m in pres if at < t < at + gap]
            if awdl_in_gap:
                tag = " ** PAIRED-ID SILENCE **" if i in strong_ids else ""
                out.append(f"  BLE id {i[:32]} silent {gap:.0f}s at +{at - t0:.0f}s "
                           f"while AWDL peers present: {sorted(set(awdl_in_gap))}{tag}")
                any_line = True
    if not any_line:
        out.append("  no BLE-silence-with-AWDL-alive interval observed")
    out.append("  (definitive proof requires the team-device BT toggle — "
               "see btoff_experiment.md)")

    txt = "\n".join(out)
    print(txt)
    return txt


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    path = next((a for a in args if not a.startswith("-")),
                str(HERE / "session.jsonl"))
    report(path)
