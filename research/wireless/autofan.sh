#!/bin/bash
# Auto-fan-out: watch decomp/ for new .c exports; for each landed framework,
# spawn a scout audit on the external-parser surface. Fire-and-forget.
D=/Users/peak/coding/0sec-labs/0/research/wireless
SEEN="$D/decomp/.audited"
touch "$SEEN"

while true; do
  for c in "$D"/decomp/*.c; do
    [ -e "$c" ] || continue
    name=$(basename "$c" .c)
    grep -qx "$name" "$SEEN" && continue
    # wait until the file is complete (export writes are atomic-ish; check pairing)
    idx="$D/decomp/$name.functions.txt"
    [ -e "$idx" ] || continue
    # only fan out on the external-surface targets
    case "$name" in
      FindMyCrypto|CoreBluetooth|Sharing|WirelessProximity|re_airportd|re_bluetoothd_arm64e|re_findmydeviced)
        echo "$name" >> "$SEEN"
        nohup /bin/bash -c "
# fan-out marker: $name
" >/dev/null 2>&1 &
        ;;
    esac
  done
  sleep 60
done