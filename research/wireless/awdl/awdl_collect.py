#!/Users/peak/coding/0sec-labs/marauder/.venv/bin/python
"""awdl_collect.py — continuous no-sudo collector of AWDL identity surface + BLE correlation inputs.

Records to awdl/session.jsonl, one JSON per line:
  {"ts": <epoch>, "iso": <utc>, "kind": "awdl_peer"|"awdl_mac_change"|"ble_obs", "data": {...}}

Sources (all passwordless, verified by probe.sh):
  1. awdl0 MAC poll (5s cadence) via `ifconfig awdl0` — the AWDL interface MAC is a
     randomized, locally-administered address that ROTATES; changes emit awdl_mac_change.
  2. `log stream` of wifip2pd — "Posted peer presence/absence for <MAC> on awdl0".
     (airportd does not log peer MACs; wifip2pd is the AWDL peer feed.)
  3. `ble_map 60 <chunk>` subprocess windows — passive CoreBluetooth Apple-continuity
     observations (stable per-device identity UUID + Apple TLV labels).
  4. tail of ../radar_live.jsonl (the live radar pipeline's BLE feed), merged as ble_obs
     with source "radar".

Usage: awdl_collect.py [duration_s=600] [outdir=<script dir>]
"""
import json
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PY = sys.executable
BLE_MAP = ROOT / "ble_map"
RADAR = ROOT / "radar_live.jsonl"

W = threading.Lock()
OUT = None
counts = {"awdl_peer": 0, "awdl_mac_change": 0, "ble_obs": 0}


def write_rec(kind, data, ts=None):
    ts = time.time() if ts is None else ts
    rec = {"ts": round(ts, 3),
           "iso": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
           "kind": kind, "data": data}
    with W:
        OUT.write(json.dumps(rec) + "\n")
        OUT.flush()
        counts[kind] = counts[kind] + 1


# ---------------------------------------------------------------- 1. awdl0 MAC poll
def poll_mac(stop, duration):
    deadline = time.time() + duration
    last = None
    while time.time() < deadline and not stop.is_set():
        try:
            out = subprocess.run(["ifconfig", "awdl0"], capture_output=True,
                                 text=True, timeout=5).stdout
            m = re.search(r"ether (\S+)", out)
            if m:
                mac = m.group(1)
                if mac != last:
                    if last is not None:
                        write_rec("awdl_mac_change",
                                  {"iface": "awdl0", "from": last, "to": mac})
                    else:
                        write_rec("awdl_mac_change",
                                  {"iface": "awdl0", "from": None, "to": mac,
                                   "note": "session_start"})
                    last = mac
        except Exception as e:
            write_rec("awdl_mac_change", {"error": str(e)})
        stop.wait(5.0)


# ---------------------------------------------------------------- 2. wifip2pd log stream
PEER_RE = re.compile(
    r"Posted peer (?P<ev>presence|absence) for (?P<mac>[0-9a-f:]{17}) on awdl0")
LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6})([+-]\d{4})")


def log_stream(stop, duration):
    cmd = ["log", "stream", "--style", "syslog",
           "--predicate", 'process == "wifip2pd" AND eventMessage CONTAINS[c] "peer"']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, bufsize=1)
    deadline = time.time() + duration
    try:
        for line in p.stdout:
            if time.time() > deadline or stop.is_set():
                break
            m = PEER_RE.search(line)
            if not m:
                continue
            ts = time.time()
            tm = LOG_TS_RE.match(line)
            if tm:
                try:
                    ts = datetime.strptime(tm.group(1) + tm.group(2),
                                           "%Y-%m-%d %H:%M:%S.%f%z").timestamp()
                except ValueError:
                    pass
            write_rec("awdl_peer", {"event": m.group("ev"), "peer_mac": m.group("mac"),
                                    "raw": line.strip()[-160:]}, ts=ts)
    finally:
        p.terminate()


# ---------------------------------------------------------------- 3+4. BLE feeds
def ble_windows(stop, duration, chunk_path):
    """Run ble_map in 60s windows; each record becomes one ble_obs."""
    deadline = time.time() + duration
    while time.time() < deadline and not stop.is_set():
        run_for = min(60, max(1, deadline - time.time()))
        try:
            chunk_path.write_text("")
            p = subprocess.run([str(BLE_MAP), str(int(run_for)), str(chunk_path)],
                               capture_output=True, text=True, timeout=run_for + 20)
            for line in chunk_path.read_text().splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                write_rec("ble_obs", {"source": "ble_map", "mac": r.get("mac"),
                                      "labels": r.get("labels", []),
                                      "rssi": r.get("rssi"), "mfg": r.get("mfg", "")})
        except Exception as e:
            write_rec("ble_obs", {"source": "ble_map", "error": str(e)})


def tail_radar(stop, duration):
    """Follow radar_live.jsonl (the live radar pipeline's BLE observations)."""
    deadline = time.time() + duration
    off = RADAR.stat().st_size if RADAR.exists() else 0
    while time.time() < deadline and not stop.is_set():
        try:
            if RADAR.exists():
                size = RADAR.stat().st_size
                if size < off:  # rotated/truncated
                    off = 0
                if size > off:
                    with RADAR.open() as f:
                        f.seek(off)
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                r = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            write_rec("ble_obs", {"source": "radar",
                                                  "mac": r.get("mac"),
                                                  "labels": r.get("labels", []),
                                                  "rssi": r.get("rssi"),
                                                  "mfg": r.get("mfg", "")})
                        off = f.tell()
        except Exception as e:
            write_rec("ble_obs", {"source": "radar", "error": str(e)})
        stop.wait(5.0)


def main():
    global OUT
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 600.0
    chunk = HERE / "ble_chunk.jsonl"
    session = HERE / "session.jsonl"
    OUT = session.open("w")
    write_rec("awdl_mac_change", {"note": "collector_start", "duration_s": duration})
    stop = threading.Event()
    ths = [threading.Thread(target=poll_mac, args=(stop, duration), daemon=True),
           threading.Thread(target=log_stream, args=(stop, duration), daemon=True),
           threading.Thread(target=ble_windows, args=(stop, duration, chunk), daemon=True),
           threading.Thread(target=tail_radar, args=(stop, duration), daemon=True)]
    for t in ths:
        t.start()
    t0 = time.time()
    while time.time() - t0 < duration + 10 and any(t.is_alive() for t in ths):
        stop.wait(5.0)
        el = int(time.time() - t0)
        if el % 30 < 5.5:
            print(f"[{el:4d}s/{int(duration)}s] "
                  + " ".join(f"{k}={v}" for k, v in counts.items()), flush=True)
    stop.set()
    time.sleep(1)
    OUT.close()
    print(f"DONE {int(time.time()-t0)}s -> {session} "
          + " ".join(f"{k}={v}" for k, v in counts.items())
          + f" total={sum(counts.values())}")


if __name__ == "__main__":
    main()
