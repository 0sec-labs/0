#!/bin/bash
# Sequential re-queue of the daemons that died on the Ghidra project lock.
# Waits for the current analyzeHeadless to finish, then imports each into its
# OWN project dir (no lock contention), exports full decomp.
export JAVA_HOME=/Users/peak/Library/Java/JavaVirtualMachines/ms-21.0.8/Contents/Home
export GHIDRA_INSTALL_DIR=$HOME/tools/ghidra_12.1.4_PUBLIC
D=/Users/peak/coding/0sec-labs/0/research/wireless
LOG=$D/decomp/queue.log

# ensure thin slices exist
lipo -thin arm64e /usr/libexec/findmydeviced -o /tmp/re_findmydeviced 2>/dev/null || cp /usr/libexec/findmydeviced /tmp/re_findmydeviced
lipo -thin arm64e /usr/libexec/airportd -o /tmp/re_airportd 2>/dev/null || cp /usr/libexec/airportd /tmp/re_airportd

echo "[queue] waiting for lock holder to exit $(date)" >> "$LOG"
while pgrep -f analyzeHeadless > /dev/null; do sleep 30; done
echo "[queue] lock free $(date)" >> "$LOG"

for spec in "findmydeviced:/tmp/re_findmydeviced:2400" "airportd:/tmp/re_airportd:2400" "bluetoothd:/tmp/bluetoothd_arm64e:9000"; do
  name="${spec%%:*}"; rest="${spec#*:}"; bin="${rest%%:*}"; tmo="${rest##*:}"
  proj="/tmp/ghidra-proj/q_$name"
  echo "[queue] $name start $(date)" >> "$LOG"
  $GHIDRA_INSTALL_DIR/support/analyzeHeadless "$proj" "$name" \
    -import "$bin" -analysisTimeoutPerFile "$tmo" \
    -scriptPath "$D" -postScript GhidraFullDecomp.java "$D/decomp" >> "$LOG" 2>&1
  echo "[queue] $name done $(date)" >> "$LOG"
done
echo "[queue] ALL DONE $(date)" >> "$LOG"