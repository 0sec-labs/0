#!/bin/bash
# queue2.sh — QueueOps. queue_remaining.sh died while waiting for the lock and
# never ran its three jobs, so we replicate them first, then add sharingd.
# Concurrency contract: max 2 Ghidra analyzeHeadless instances repo-wide —
# wait for ALL running instances before starting each job.
export JAVA_HOME=/Users/peak/Library/Java/JavaVirtualMachines/ms-21.0.8/Contents/Home
export GHIDRA_INSTALL_DIR=$HOME/tools/ghidra_12.1.4_PUBLIC
D=/Users/peak/coding/0sec-labs/0/research/wireless
LOG=$D/decomp/queue2.log

echo "[queue2] started pid=$$ waiting for analyzeHeadless holders $(date)" >> "$LOG"

wait_free() {
  while pgrep -f analyzeHeadless > /dev/null; do sleep 30; done
}

run_job() {
  name="$1"; bin="$2"; tmo="$3"
  proj="/tmp/ghidra-proj/q_$name"
  mkdir -p "$proj"
  wait_free
  echo "[queue2] $name start $(date)" >> "$LOG"
  "$GHIDRA_INSTALL_DIR/support/analyzeHeadless" "$proj" "$name" \
    -import "$bin" -analysisTimeoutPerFile "$tmo" \
    -scriptPath "$D" -postScript GhidraFullDecomp.java "$D/decomp" >> "$LOG" 2>&1
  echo "[queue2] $name done $(date)" >> "$LOG"
}

# (a) replicate queue_remaining.sh jobs — same specs (timeouts 2400/2400/9000)
lipo -thin arm64e /usr/libexec/findmydeviced -o /tmp/re_findmydeviced 2>/dev/null || cp /usr/libexec/findmydeviced /tmp/re_findmydeviced
lipo -thin arm64e /usr/libexec/airportd -o /tmp/re_airportd 2>/dev/null || cp /usr/libexec/airportd /tmp/re_airportd
lipo -thin arm64e /usr/libexec/bluetoothd -o /tmp/bluetoothd_arm64e 2>/dev/null || cp /usr/libexec/bluetoothd /tmp/bluetoothd_arm64e

run_job findmydeviced /tmp/re_findmydeviced 2400
run_job airportd /tmp/re_airportd 2400
run_job bluetoothd /tmp/bluetoothd_arm64e 9000

# (b) sharingd (17MB Continuity brain; arm64e slice pre-made at /tmp/re_sharingd)
lipo -thin arm64e /usr/libexec/sharingd -o /tmp/re_sharingd 2>/dev/null || cp /usr/libexec/sharingd /tmp/re_sharingd
run_job sharingd /tmp/re_sharingd 7200

echo "[queue2] ALL DONE $(date)" >> "$LOG"
