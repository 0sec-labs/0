#!/bin/bash
# queue3.sh — QueueOps follow-up: 5th job FindMyLocate. Appending to the
# running queue2.sh is unsafe (bash reads scripts sequentially), so this is a
# separate process that waits for queue2.sh to finish first, then honors the
# same max-2-analyzeHeadless contract.
export JAVA_HOME=/Users/peak/Library/Java/JavaVirtualMachines/ms-21.0.8/Contents/Home
export GHIDRA_INSTALL_DIR=$HOME/tools/ghidra_12.1.4_PUBLIC
D=/Users/peak/coding/0sec-labs/0/research/wireless
LOG=$D/decomp/queue2.log

echo "[queue2] queue3 follow-up started pid=$$ waiting for queue2.sh to finish $(date)" >> "$LOG"
while pgrep -f 'research/wireless/queue2\.sh' > /dev/null; do sleep 30; done
echo "[queue2] queue3: queue2.sh finished $(date)" >> "$LOG"

while pgrep -f analyzeHeadless > /dev/null; do sleep 30; done
echo "[queue2] queue3: analyzeHeadless free $(date)" >> "$LOG"

BIN=/tmp/dsc_fm/FindMyLocate
if [ ! -f "$BIN" ]; then
  echo "[queue2] queue3: extracting FindMyLocate from dyld shared cache $(date)" >> "$LOG"
  /opt/homebrew/bin/ipsw dyld extract \
    /System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e \
    FindMyLocate -o "$BIN" >> "$LOG" 2>&1
fi

proj="/tmp/ghidra-proj/q_findmylocate"
mkdir -p "$proj"
echo "[queue2] findmylocate start $(date)" >> "$LOG"
"$GHIDRA_INSTALL_DIR/support/analyzeHeadless" "$proj" "findmylocate" \
  -import "$BIN" -analysisTimeoutPerFile 3600 \
  -scriptPath "$D" -postScript GhidraFullDecomp.java "$D/decomp" >> "$LOG" 2>&1
echo "[queue2] findmylocate done $(date)" >> "$LOG"
echo "[queue2] queue3 ALL DONE $(date)" >> "$LOG"
