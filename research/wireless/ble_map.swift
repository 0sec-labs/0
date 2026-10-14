// BLE Continuity tracker — persistent device map with names, stability hashes, distance buckets.
// Usage: swiftc -O ble_map.swift -o ble_map && ./ble_map [seconds] [out.jsonl]
// Passive only. Groups randomized MACs by stable Continuity hashes where present.

import CoreBluetooth
import Foundation

struct Track {
    var name = ""
    var firstSeen = Date()
    var lastSeen = Date()
    var bestRSSI = -999
    var worstRSSI = 999
    var hits = 0
    var labels: Set<String> = []
    var hashes: Set<String> = []   // stable identity anchors inside Continuity payloads
    var models: Set<String> = []
    var sampleTLV = ""
}

let typeNames: [UInt8: String] = [
    0x02: "iBeacon", 0x03: "AirPrint", 0x05: "AirDrop", 0x07: "ProximityPairing",
    0x08: "HeySiri", 0x0C: "Handoff", 0x0E: "HotspotTarget", 0x0F: "HotspotSource",
    0x10: "NearbyInfo", 0x12: "FindMy", 0x16: "NearbyAction",
]

let models: [UInt8: String] = [
    0x07: "AirPods", 0x0E: "AirPods", 0x0F: "AirPods", 0x11: "AirPods(3rd)",
    0x13: "AirPodsPro", 0x1B: "BeatsFlex", 0x22: "AirPodsMax", 0x2A: "AirPodsPro2",
]

func bucket(_ rssi: Int) -> String {
    switch rssi {
    case (-55)...(-1): return "right-here(<3m)"
    case (-75)...(-56): return "near(3-10m)"
    case (-90)...(-76): return "far(10-25m)"
    default: return "faint"
    }
}

func parseTLVs(_ data: Data) -> [(UInt8, Data)] {
    var out: [(UInt8, Data)] = []
    var i = data.startIndex + 2
    while i + 1 < data.endIndex {
        let type = data[i]
        let len = Int(data[data.index(after: i)])
        let ps = data.index(i, offsetBy: 2)
        let pe = data.index(ps, offsetBy: len, limitedBy: data.endIndex) ?? data.endIndex
        if pe == data.endIndex && len > data.distance(from: ps, to: data.endIndex) { break }
        out.append((type, data[ps..<pe]))
        i = pe
    }
    return out
}

final class Mapper: NSObject, CBCentralManagerDelegate {
    var central: CBCentralManager!
    let seconds: Double
    let outFile: FileHandle?
    var tracks: [String: Track] = [:]  // key: primary stable hash, else MAC UUID
    var macToKey: [UUID: String] = [:]

    init(seconds: Double, path: String?) {
        self.seconds = seconds
        if let p = path {
            if !FileManager.default.fileExists(atPath: p) {
                FileManager.default.createFile(atPath: p, contents: nil)
            }
            if let fh = FileHandle(forWritingAtPath: p) {
                fh.seekToEndOfFile()  // append, never truncate history
                outFile = fh
            } else { outFile = nil }
        } else { outFile = nil }
        super.init()
    }

    func start() {
        central = CBCentralManager(delegate: self, queue: .main)
        RunLoop.main.run(until: Date().addingTimeInterval(seconds + 2))
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            central.scanForPeripherals(withServices: nil,
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        } else if central.state == .unauthorized {
            print("BLE: UNAUTHORIZED — approve Bluetooth for this terminal, rerun."); exit(2)
        } else {
            print("BLE state: \(central.state.rawValue)")
        }
    }

    func key(for id: UUID, hashes: Set<String>) -> String {
        if let k = macToKey[id] { return k }
        // Re-key under a stable hash so randomized MACs collapse onto one track.
        if !hashes.isEmpty {
            let k = "H:" + hashes.sorted().joined(separator: ",")
            for (mac, mk) in macToKey where mk.hasPrefix("H:") {
                // first-come stable anchor wins
                _ = mac
            }
            if let existing = tracks[k] { _ = existing } // keep
            macToKey[id] = k
            return k
        }
        macToKey[id] = id.uuidString
        return id.uuidString
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover p: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        guard let mfg = advertisementData["kCBAdvDataManufacturerData"] as? Data,
              mfg.count >= 3, mfg[0] == 0x4C, mfg[1] == 0x00 else { return }
        let now = Date()
        var labels: Set<String> = []
        var hashes: Set<String> = []
        var modelsFound: Set<String> = []
        var sample = ""

        for (t, payload) in parseTLVs(mfg) {
            if let name = typeNames[t] { labels.insert(name) }
            // stability anchors: first 4-6 payload bytes act as the per-device rotation hash
            if payload.count >= 4 {
                let h = payload.prefix(6).map { String(format: "%02x", $0) }.joined()
                hashes.insert("t\(String(format: "%02x", t)):\(h)")
            }
            if t == 0x07, let first = payload.first, let m = models[first] { modelsFound.insert(m) }
        }
        if sample.isEmpty { sample = mfg.map { String(format: "%02x", $0) }.joined() }

        let k = key(for: p.identifier, hashes: hashes)
        var tr = tracks[k] ?? Track()
        if tr.hits == 0 { tr.firstSeen = now }
        tr.lastSeen = now
        tr.hits += 1
        let r = RSSI.intValue == 127 ? tr.worstRSSI : RSSI.intValue // 127 = invalid
        if tr.hits == 1 { tr.bestRSSI = r; tr.worstRSSI = r }
        if r > tr.bestRSSI { tr.bestRSSI = r }
        if r < tr.worstRSSI { tr.worstRSSI = r }
        if let n = advertisementData["kCBAdvDataLocalName"] as? String, !n.isEmpty { tr.name = n }
        if tr.name.isEmpty, let n = p.name, !n.isEmpty { tr.name = n }
        tr.labels.formUnion(labels)
        tr.hashes.formUnion(hashes)
        tr.models.formUnion(modelsFound)
        tr.sampleTLV = sample
        tracks[k] = tr

        if let fh = outFile {
            let rec: [String: Any] = ["ts": now.timeIntervalSince1970,
                                       "mac": p.identifier.uuidString,
                                       "rssi": RSSI.intValue,
                                       "name": tr.name,
                                       "labels": Array(tr.labels),
                                       "mfg": sample]
            if let d = try? JSONSerialization.data(withJSONObject: rec) {
                fh.write(d + Data("\n".utf8))
            }
        }
    }

    func report() {
        print("\n===== DEVICE MAP — \(tracks.count) tracks =====\n")
        let sorted = tracks.values.sorted { $0.bestRSSI > $1.bestRSSI }
        for t in sorted {
            let dur = Int(t.lastSeen.timeIntervalSince(t.firstSeen))
            let bar = String(repeating: "█", count: max(2, min(20, (t.bestRSSI + 100) / 3)))
            let nm = t.name.isEmpty ? "(no name)" : "'\(t.name)'"
            let mdl = t.models.isEmpty ? "" : " [" + t.models.sorted().joined(separator: ",") + "]"
            let lbl = t.labels.sorted().joined(separator: ",")
            print("\(bucket(t.bestRSSI)) \(bar) \(nm)\(mdl)")
            print("    \(lbl) | seen \(t.hits)x over \(dur)s | rssi \(t.bestRSSI)..\(t.worstRSSI)")
        }
        let byLabel = Dictionary(grouping: sorted) { $0.labels.sorted().first ?? "uncategorized" }
        print("\n===== CATEGORY SUMMARY =====")
        for (lbl, dev) in byLabel.sorted(by: { $0.value.count > $1.value.count }) {
            print("\(lbl): \(dev.count) devices")
        }
        let named = sorted.filter { !$0.name.isEmpty }
        print("\n===== NAMED DEVICES (\(named.count)) =====")
        for t in named { print("  '\(t.name)' \(bucket(t.bestRSSI)) rssi=\(t.bestRSSI) \(t.labels.sorted().joined(separator: ","))") }
    }
}

let secs = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 60 : 60
let out = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
let m = Mapper(seconds: secs, path: out)
m.start()
m.report()
