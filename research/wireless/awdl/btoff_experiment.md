# Experiment: "Bluetooth off didn't save you" — AWDL persists after BLE silence

**Scope: TEAM-OWNED DEVICES ONLY.** Every active step below runs against an iPhone we
own and control, on our own bench. This Mac's role is passive receive-only observation.
The passive collection (`awdl_collect.py`, `ble_map`) and this Mac's own AWDL surface
never transmit to third parties.

## Claim under test

An Apple device that turns Bluetooth off is *not* invisible:

1. Its BLE Continuity advertising (the stable per-device identity UUID that `ble_map`
   logs, with Apple TLV labels like `NearbyInfo` / `Handoff`) goes **silent** — nothing
   broadcasts anymore on the 2.4 GHz BLE advertising channels.
2. Its **AWDL presence persists**: the Wi-Fi chip keeps participating in AWDL
   (action frames on the 60ms/availability-window schedule), so `wifip2pd` on this Mac
   keeps posting `peer presence for <MAC> on awdl0` for that device's randomized AWDL
   interface MAC.
3. Therefore a passive observer can tell "device present, radio stack awake" purely
   from AWDL, *after* the BLE identity channel is closed. Turning BT off removes the
   readable identity hash, not the presence beacon.

## Honest caveat (read this before demoing)

What we correlate is **temporal, not cryptographic**. Without the airportd decomp
mapping AWDL peer MAC → Apple identity fields (the AWDL action frame carries the
peer's interface MAC, election parameters, and sync state — the identity-bearing TLVs
live in frames we have not yet decoded from the decomp queue), we cannot *cryptographically
bind* a given AWDL peer MAC to a given BLE continuity UUID. The demo shows:

- BLE identity `X` (stable across days, contains the Apple continuity hash family used
  by the AirDrop reveal pipeline) vanishes at time T;
- an AWDL peer MAC appears / persists in the same physical proximity across T;
- the transition graph (correlate.py section b2) and the ±10s co-occurrence edges make
  the pairing *probable*, not proven.

When the airportd/AWDL frame decomp lands, the same session.jsonl replays with
cryptographic binding (AWDL frames are unencrypted — the identity is in the clear;
it is the *mapping* we lack, not the protection).

## Setup (this Mac = observer)

```
cd research/wireless/awdl
./awdl_collect.py 900          # 15 min session: 5 baseline + 5 BT-off + 5 restore
```

This records, in one timeline (`session.jsonl`):
- `awdl_mac_change` — our own awdl0 randomized MAC (5s poll, documents OUR rotation too)
- `awdl_peer` — wifip2pd peer presence/absence events with peer MACs (log stream)
- `ble_obs` — BLE continuity observations from `ble_map` (60s windows) and the
  `radar_live.jsonl` feed tail

## Script (team iPhone, owned)

| t (min) | action | expected signature in session.jsonl |
|---|---|---|
| 0–5 | **Baseline.** iPhone BT ON, Wi-Fi ON, screen on, iPhone on bench ≤2 m from the Mac. Note the phone's BLE identity UUID from `ble_map.jsonl` (stable `mac` field, `labels: ["NearbyInfo","Handoff",...]`). | steady `ble_obs` for the phone's UUID; phone's AWDL peer MAC appears once (first contact) and stays present (no absence) |
| 5 | **Toggle Bluetooth OFF** in Control Center / Settings. Say the toggle time out loud into the room log, or `touch marker_T` — the collector's timeline is the reference. | phone's `ble_obs` stops **within ~1 min** (CoreBluetooth caches age out); its AWDL `peer presence` events **continue**; no `peer absence` for its MAC |
| 5–10 | **BT off.** Touch nothing else. Open Control Center once at ~t=8 to confirm BT is still off (no re-enable). | `awdl_peer presence` for the phone's MAC still firing/absent-flickering as before; zero new `ble_obs` for its UUID |
| 10 | **Toggle Bluetooth back ON.** | phone's UUID `ble_obs` resumes within ~30 s with the **same UUID as baseline** (stability proof) |
| 10–15 | Restore + control. Optionally also toggle Wi-Fi off at t=12: AWDL peer events for the phone stop — the control that shows the `awdl_peer` stream is really tracking the phone, not noise. | AWDL presence stops only when the Wi-Fi side dies |

## Analysis

```
./correlate.py session.jsonl
```

Read out loud in the demo:
- section (a): the ±10s spikes binding the phone's UUID to its AWDL peer MAC **before**
  the toggle (establishes the pair while both channels are up);
- section (c): "BLE id `<uuid>` silent Ns at +T while AWDL peers present: `<mac>`" —
  the BT-off signature line, where `<mac>` is the same MAC section (a) bound;
- the restore: BLE obs resume, same UUID, correlation edges re-form.

## Pass/fail

- **PASS (claim proven for our device):** BLE obs for the phone's UUID stop at T while
  `awdl_peer presence` events for the MAC that section (a) paired with that UUID
  continue for the whole BT-off window.
- **INCONCLUSIVE:** AWDL peer events also stop at T — means BT-off also tears down AWDL
  on that device (report honestly; this is exactly what the experiment is designed to
  measure, and either answer is a result).
- **FAIL (claim false):** AWDL identity itself rotates away on BT-off in a way that
  breaks the section-(a) pairing; then the story is "BT off + AWDL re-randomizes" —
  still worth reporting with the rotation timeline from `awdl_mac_change`.

## Controls and hygiene

- Do the run in the lab (same room, phone ≤2 m) so RSSI-based identification is unambiguous.
- Other team phones may be present: the collector records them too; section (a) filters
  by UUID, and the phone under test is the only one whose BT state changes at T.
- Never run the active parts of this protocol against a visitor's or stranger's device.
  Third-party devices are observed only as passive background traffic, same as any
  bystander's phone passing the bench.
