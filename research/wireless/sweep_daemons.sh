#!/bin/bash
# Systematic 0verse sweep over the Mac wireless/Find My daemon stack.
# Thin arm64e slice -> full pipeline -> JSON report per target.
set -u
export GHIDRA_INSTALL_DIR=$HOME/tools/ghidra_12.1.4_PUBLIC
export ZEROVERSE_BACKEND=ghidra
export ZEROVERSE_EXECUTOR=local
export ZEROVERSE_BUDGET_SECONDS=2700
export ZEROVERSE_BACKEND_TIMEOUT=1500
cd /Users/peak/coding/0sec-labs/0/0verse
OUT=/Users/peak/coding/0sec-labs/0/research/wireless/reports
mkdir -p "$OUT"

TARGETS=(
  /usr/libexec/findmydeviced
  /usr/libexec/airportd
  /usr/sbin/wifip2pd
  /usr/libexec/wifivelocityd
  /usr/libexec/wifianalyticsd
  /usr/sbin/bluetoothaudiod
)
for t in "${TARGETS[@]}"; do
  name=$(basename "$t")
  thin=/tmp/re_${name}_arm64e
  if lipo -info "$t" 2>/dev/null | grep -q arm64e; then
    lipo -thin arm64e "$t" -o "$thin" 2>/dev/null || cp "$t" "$thin"
  else
    cp "$t" "$thin"
  fi
  echo "===== $name ($(stat -f%z "$thin") bytes) ====="
  .venv/bin/python -m zeroverse.cli run "$thin" --format json > "$OUT/${name}.json" 2>"$OUT/${name}.err"
  .venv/bin/python - "$OUT/${name}.json" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("  report unreadable:", e); sys.exit(0)
print("  stages:", ",".join(d.get("stages_run", [])))
print("  findings:", len(d.get("findings", [])))
print("  outcome:", d.get("outcome"), "| note:", (d.get("note") or "")[:100])
PYEOF
done
echo "===== SWEEP COMPLETE ====="
