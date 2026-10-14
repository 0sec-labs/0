// BLE Continuity observer — passive Apple advertisement scanner.
// Usage: swiftc -O ble_scan.swift -o ble_scan && ./ble_scan [seconds]
// Passively records what nearby Apple devices broadcast. No connection, no write.

import CoreBluetooth
import Foundation

// Best-known Continuity TLV type map (furiousMAC/continuity, USENIX Sec'21).
// Labels are hypotheses; raw hex is always emitted so we can decode empirically.
let appleTLVTypes: [UInt8: String] = [
    0x02: "iBeacon",
    0x03: "AirPrint",
    0x04: "AirDrop(legacy)",
    0x05: "AirDrop",
    0x06: "HomeKit",
    0x07: "ProximityPairing(AirPods)",
    0x08: "HeySiri",
    0x09: "AirDrop?",
    0x0A: "MagicSwitch?",
    0x0B: "unknown-0x0B",
    0x0C: "Handoff",
    0x0D: "unknown-0x0D",
    0x0E: "TetheringTarget",
    0x0F: "TetheringSource(Hotspot)",
    0x10: "NearbyInfo",
    0x11: "unknown-0x11",
    0x12: "FindMy(offline)",
    0x16: "NearbyAction",
]

let modelNames: [UInt8: String] = [
    0x07: "AirPods", 0x0E: "AirPods", 0x0F: "AirPods", 0x11: "AirPods(3rd)",
    0x13: "AirPods Pro", 0x14: "Beats Solo Pro", 0x1B: "Beats Flex",
    0x22: "AirPods Max", 0x24: "Powerbeats", 0x2A: "AirPods Pro 2",
    0x54: "iPhone?", 0x63: "Watch?",
]

func parseAppleTLVs(_ data: Data) -> [String] {
    var out: [String] = []
    var i = data.startIndex + 2 // skip company ID (little-endian 0x004C)
    while i + 1 < data.endIndex {
        let type = data[i]; let len = data[data.index(after: i)]
        let payloadStart = data.index(i, offsetBy: 2)
        guard len > 0 else { break }
        let payloadEnd = data.index(payloadStart, offsetBy: Int(len))
        guard payloadEnd <= data.endIndex else { out.append("malformed-tlv@\(i)"); break }
        let payload = data[payloadStart..<payloadEnd]
        let hex = payload.map { String(format: "%02x", $0) }.joined()
        let label = appleTLVTypes[type] ?? "type-0x\(String(format: "%02x", type))"
        if let model = modelNames.first(where: { payload.first == $0.key }) {
            out.append("\(label)[\(model.value)](\(len):\(hex))")
        } else {
            out.append("\(label)(\(len):\(hex))")
        }
        i = payloadEnd
    }
    return out
}

final class Scanner: NSObject, CBCentralManagerDelegate {
    var central: CBCentralManager!
    var startedAt: Date?
    var duration: Double
    var seen: [UUID: (name: String, rssi: Int, tlvs: Set<String>, hits: Int)] = [:]

    init(duration: Double) { self.duration = duration; super.init() }

    func start() {
        central = CBCentralManager(delegate: self, queue: .main)
        startedAt = Date()
        RunLoop.main.run(until: Date().addingTimeInterval(duration + 2))
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(withServices: nil,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        case .unauthorized:
            print("BLE: UNAUTHORIZED — grant Bluetooth permission to this terminal, rerun.")
            exit(2)
        default:
            print("BLE state: \(central.state.rawValue)")
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        var entry = seen[peripheral.identifier] ?? (peripheral.name ?? "", RSSI.intValue, [], 0)
        entry.hits += 1
        if RSSI.intValue > entry.rssi { entry.rssi = RSSI.intValue }
        if let n = peripheral.name, !n.isEmpty { entry.name = n }

        if let mfg = advertisementData["kCBAdvDataManufacturerData"] as? Data,
           mfg.count >= 3, mfg[0] == 0x4C, mfg[1] == 0x00 {
            for tlv in parseAppleTLVs(mfg) {
                if tlv.hasPrefix("malformed") { continue }
                entry.tlvs.insert(tlv)
            }
        }
        if let localName = advertisementData["kCBAdvDataLocalName"] as? String {
            entry.name = localName
        }
        seen[peripheral.identifier] = entry
    }

    func report() {
        print("\n===== \("\(seen.count)") distinct devices =====")
        for (id, e) in seen.sorted(by: { $0.value.hits > $1.value.hits }) {
            let tlvs = e.tlvs.sorted().joined(separator: " | ")
            print("\(id.uuidString.prefix(8)) rssi=\(e.rssi) hits=\(e.hits) name='\(e.name)'")
            if !tlvs.isEmpty { print("   \(tlvs)") }
        }
    }
}

let seconds = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 30 : 30
let s = Scanner(duration: seconds)
s.start()
s.report()
