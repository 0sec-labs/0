// victim_peripheral.swift — LE Audio ASCS vulnerable-server simulator.
//
// Legal target for the ASCS OOB-read PoC: a CBPeripheralManager running on OUR
// OWN Mac that reproduces the buggy codec-config parser extracted from
// decomp/re_bluetoothaudiod.c (ASCSServerService::codecConfigRequest:
// @10003344c, lines 35721-35920). It advertises 0x184B (Common Audio Service),
// exposes 0x2B84 SinkASE / 0x2B85 SourceASE / 0x2B86 ASE Control Point, parses
// written commands with the SAME attacker-trusting length logic as the
// decompile, and echoes parsed fields (including OOB-derived bytes) back to
// the subscribed central.
//
// OOB demonstration: the codec-config bytes are copied into a malloc'd heap
// buffer sized exactly like the materialized NSMutableData in the decompile;
// a separate canary allocation (256 bytes filled with a repeating
// CA FE BA BE 04 03 pattern) is placed immediately after it, so any read past
// the config buffer crosses a real heap-object boundary into the canary.
//
// Build: swiftc -O -o victim_peripheral victim_peripheral.swift
// SAFETY: advertises only to this machine; never attacks third parties.

import Foundation
import CoreBluetooth

let kServiceUUID      = CBUUID(string: "184B")   // Common Audio Service
let kSinkASEUUID      = CBUUID(string: "2B84")   // Sink ASE
let kSourceASEUUID    = CBUUID(string: "2B85")   // Source ASE
let kControlPointUUID = CBUUID(string: "2B86")   // ASE Control Point
let kVictimName       = "LEAUDIO-POC-VICTIM"
let kCanaryLen        = 256

// Canary fill: repeating 6-byte pattern [CA FE BA BE 04 03]. CA FE BA BE is the
// canary magic; the trailing 04 03 is a honeypot TLV header ([len=4][type=3])
// so that once the buggy parser walks into the canary it keeps issuing type-3
// 4-byte copies — propagating the magic into echoed codec fields.
let kCanaryPattern: [UInt8] = [0xCA, 0xFE, 0xBA, 0xBE, 0x04, 0x03]

func ts(_ s: String) { print("[victim \(Date().formatted(date: .omitted, time: .standard))] \(s)") }

// MARK: - Heap layout (malloc'd config buffer + adjacent canary)

enum ReadRegion: UInt8 { case inBounds = 0, slack = 1, canary = 2, beyond = 3 }

final class HeapConfig {
    let configPtr: UnsafeMutableRawPointer   // malloc'd; holds the materialized config bytes
    let configSize: Int                      // LOGICAL size == bytes readNumBytes_toData_ appended
    let allocSize: Int                       // malloc'd size (malloc-zone "capacity" analog)
    let canaryPtr: UnsafeMutableRawPointer   // separate canary OBJECT, adjacent after config
    let adjacent: Bool
    var canaryReads = 0
    var slackReads = 0
    var beyondReads = 0

    init(materializedSize: Int) {
        configSize = max(materializedSize, 0)
        // Same malloc size class for config and canary (tiny zone): consecutive
        // allocations from a fresh size-class run are physically adjacent, so
        // the OOB read crosses a real heap-object boundary deterministically.
        // allocSize doubles as the NSMutableData "capacity" analog: reads
        // between configSize and allocSize are in-object slack, reads at or
        // past allocSize are OOB into the canary object.
        allocSize = max(16, ((max(configSize, 1) + 15) / 16) * 16)

        // Heap grooming, attacker-style: spray same-size-class allocations until
        // two of them are exactly allocSize apart (fresh tiny-region pages are
        // laid out sequentially, so such neighbors exist), use the LOWER one as
        // the config object and the HIGHER one as the canary object, then free
        // everything else (freeing afterwards does not move the chosen pair).
        var seen = Set<UInt>()
        var kept: [UnsafeMutableRawPointer] = []
        var chosen: (UnsafeMutableRawPointer, UnsafeMutableRawPointer)?
        for _ in 0..<200000 {
            let p = malloc(allocSize)!
            let a = UInt(bitPattern: p)
            if seen.contains(a &- UInt(allocSize)) {
                chosen = (UnsafeMutableRawPointer(bitPattern: a &- UInt(allocSize))!, p)
                break
            }
            if seen.contains(a &+ UInt(allocSize)) {
                chosen = (p, UnsafeMutableRawPointer(bitPattern: a &+ UInt(allocSize))!)
                break
            }
            seen.insert(a)
            kept.append(p)
        }
        for p in kept where chosen == nil || p != chosen!.0 && p != chosen!.1 { free(p) }
        if let (c, k) = chosen {
            configPtr = c; canaryPtr = k; adjacent = true
        } else {
            configPtr = malloc(allocSize)!
            canaryPtr = malloc(allocSize)!
            adjacent = false
        }
        memset(configPtr, 0xCC, allocSize)          // poison every non-materialized byte
        memset(canaryPtr, 0x00, allocSize)
        for i in 0..<allocSize {
            (canaryPtr + i).storeBytes(of: kCanaryPattern[i % kCanaryPattern.count], as: UInt8.self)
        }
        ts("heap: config=\(configPtr) logical=\(configSize) alloc=\(allocSize) canary=\(canaryPtr) distance=\(Int(bitPattern: canaryPtr) &- Int(bitPattern: configPtr)) adjacent=\(adjacent)")
    }

    // Faithful stand-in for the decompile's unchecked reads `*(byte *)(IVar5 + N)`.
    // Reads inside the config object or inside the canary object are performed
    // for real (a canary read IS the cross-boundary OOB demonstration). Reads
    // past the canary are clamped to 0 — a documented demo-stability divergence:
    // the real parser has no guard and keeps reading adjacent heap.
    func byte(at i: Int) -> (UInt8, ReadRegion) {
        let p = configPtr + i
        if p >= configPtr + allocSize {              // outside the config object
            if adjacent && p >= canaryPtr && p < canaryPtr + allocSize {
                canaryReads += 1
                return (p.load(as: UInt8.self), .canary)
            }
            beyondReads += 1
            return (0, .beyond)
        }
        if i >= configSize { slackReads += 1; return (p.load(as: UInt8.self), .slack) }
        return (p.load(as: UInt8.self), .inBounds)
    }
}

// MARK: - Parsed state (mirrors local_9c/locals in the decompile)

struct TlvRecord {
    var len: UInt8
    var type: UInt8
    var region: ReadRegion
    var copied: [UInt8]
}

struct ParsedConfig {
    var samplingFrequency: UInt8 = 0
    var frameDuration: UInt8 = 0
    var chanAlloc: [UInt8] = [0, 0, 0, 0]     // type-3 dest: local_9c (4 bytes)
    var octetsPerFrame: [UInt8] = [0, 0]      // type-4 dest: low 2 bytes of local_9c
    var framesPerSDU: UInt8 = 0
    var tlvs: [TlvRecord] = []
    var oobHit = false
}

// MARK: - Faithful mirror of ASCSServerService::codecConfigRequest: @10003344c
//
// Line references in comments are to decomp/re_bluetoothaudiod.c.

func codecConfigParse(configData: [UInt8], declaredLen: Int, heap: HeapConfig) -> ParsedConfig {
    var out = ParsedConfig()
    // :35843-35844 — IVar5 = bytes of the NSMutableData; loop `uVar12 = 0`,
    // :35880 `while ((int)uVar12 < (int)(uint)local_97)` — bound is the
    // ATTACKER-DECLARED length, never the buffer's real length.
    var idx = 0
    var count = 0
    while idx < declaredLen {
        defer { count += 1 }
        // :35862 — bVar3 = *(byte *)(IVar5 + uVar12): length byte at data[idx].
        // :35846 — bVar2 = *(byte *)(IVar5 + 1 + uVar12): type byte at data[idx+1].
        let (len, rLen) = heap.byte(at: idx)
        let (type, rType) = heap.byte(at: idx + 1)
        let region = max(rLen.rawValue, rType.rawValue)
        var rec = TlvRecord(len: len, type: type, region: ReadRegion(rawValue: region)!, copied: [])
        let uVar1 = idx + 2                                   // value offset
        switch type {
        case 1:                                               // :35847-35851
            let (v, r) = heap.byte(at: uVar1)
            out.samplingFrequency = v
            if r != .inBounds { rec.region = r }
            out.tlvs.append(rec); idx = idx + 3
        case 2:                                               // :35853-35857
            let (v, r) = heap.byte(at: uVar1)
            out.frameDuration = v
            if r != .inBounds { rec.region = r }
            out.tlvs.append(rec); idx = idx + 3
        case 3:                                               // :35863-35868
            // ___memcpy_chk(&local_9c, IVar5 + uVar1, bVar3, 4)
            var n = Int(len); var wouldAbort = false
            if n > 4 { wouldAbort = true; n = 4 }             // _chk fortify: n>dstsize aborts on-device
            var copied = [UInt8](repeating: 0, count: 4)
            for j in 0..<n {
                let (b, r) = heap.byte(at: uVar1 + j)
                copied[j] = b
                if r != .inBounds { rec.region = r; out.oobHit = true }
            }
            rec.copied = copied
            if wouldAbort { ts("type-3 len=\(len) > 4: real binary __memcpy_chk would __chk_fail abort (DoS); clamped for demo stability") }
            out.chanAlloc = copied
            out.tlvs.append(rec)
            // :35884 — uVar12 = (idx + 2) + bVar3
            idx = idx + 2 + Int(len)
        case 4:                                               // :35869-35875
            // ___memcpy_chk(&local_9c, IVar5 + uVar1, bVar3 - 1, 2)
            let rawN = len == 0 ? UInt64.max : UInt64(len) - 1 // byte→ulong, so len==0 wraps huge
            let n = rawN > 2 ? 2 : Int(rawN); let wouldAbort = rawN > 2
            var copied = [UInt8](repeating: 0, count: 2)
            for j in 0..<n {
                let (b, r) = heap.byte(at: uVar1 + j)
                copied[j] = b
                if r != .inBounds { rec.region = r; out.oobHit = true }
            }
            rec.copied = copied
            if wouldAbort { ts("type-4 len=\(len): n=len-1=\(len == 0 ? "2^64-1 (wrap)" : "\(len-1)") > 2: real binary __memcpy_chk would __chk_fail abort (DoS); clamped for demo stability") }
            out.octetsPerFrame = copied
            out.tlvs.append(rec)
            idx = idx + 2 + Int(len)
        case 5:                                               // :35876-35881
            let (v, r) = heap.byte(at: uVar1)
            out.framesPerSDU = v
            if r != .inBounds { rec.region = r }
            out.tlvs.append(rec); idx = idx + 3
        default:                                              // :35871/35882 — unknown type: advance 2
            out.tlvs.append(rec); idx = idx + 2
        }
        if count >= 64 { out.tlvs.append(TlvRecord(len: 0, type: 0xFF, region: .inBounds, copied: [])); break } // echo cap
    }
    return out
}

// MARK: - ASCS parse engine (shared by the BLE victim and the --parse selftest)

final class ASCSEngine {
    var magicLeaked = false

    // `notify` is the echo-back stand-in for
    // updateValue_forCharacteristic_onSubscribedCentrals_ (:35906-35920).
    func handleCodecConfig(_ value: Data, notify: (Data) -> Void) {
        let b = [UInt8](value)
        var o = 1
        func u8() -> UInt8 { defer { o += 1 }; return o < b.count ? b[o] : 0 }
        let numASE = Int(u8())                                // local_91, :35765
        ts("codecConfigRequest: numASE=\(numASE)")
        for _ in 0..<max(numASE, 0) {
            let aseID = u8()                                  // local_94
            let latency = u8()                                // local_95
            let phy = u8()                                    // local_96
            var codecID = [UInt8](); for _ in 0..<5 { codecID.append(u8()) }  // readUint40_
            let declared = Int(u8())                          // local_97, :35838 — ATTACKER LENGTH
            let actual = max(0, b.count - o)
            // readNumBytes_toData_ @10002cf50 (:31234-31261): appends to the
            // NSMutableData ONLY if the full declared count was read
            // (:31250-31252) — a truncated write materializes an EMPTY buffer.
            let materialized = actual >= declared ? declared : 0
            ts("ASE \(aseID): latency=\(latency) phy=\(phy) codecID=\(hex(Data(codecID))) declared=\(declared) actualConfigBytes=\(actual) materialized=\(materialized)\(actual < declared ? "  <-- TRUNCATED (empty buffer, parser still runs to declared)" : "")")
            let heap = HeapConfig(materializedSize: materialized)
            if materialized > 0 {
                for i in 0..<materialized { (heap.configPtr + i).storeBytes(of: b[o + i], as: UInt8.self) }
            }
            o += min(actual, declared)
            let parsed = codecConfigParse(configData: [], declaredLen: declared, heap: heap)
            reportParse(parsed, heap: heap)
            notify(echoData(parsed, aseID: aseID))
        }
    }

    func reportParse(_ p: ParsedConfig, heap: HeapConfig) {
        ts("parsed: sf=\(p.samplingFrequency) fd=\(p.frameDuration) framesPerSDU=\(p.framesPerSDU) chanAlloc=\(hex(Data(p.chanAlloc))) octets=\(hex(Data(p.octetsPerFrame))) tlvs=\(p.tlvs.count)")
        for (i, t) in p.tlvs.enumerated() {
            let cp = t.copied.isEmpty ? "" : " copy=\(hex(Data(t.copied)))"
            ts("  tlv[\(i)] len=0x\(String(t.len, radix: 16)) type=0x\(String(t.type, radix: 16)) region=\(t.region)\(cp)")
        }
        ts("heap OOB reads: canary=\(heap.canaryReads) slack=\(heap.slackReads) beyondCanary(clamped)=\(heap.beyondReads)")
        if p.chanAlloc == kCanaryPattern.prefix(4).map({ $0 }) {
            magicLeaked = true
            ts("*** CANARY MAGIC CA FE BA BE read OOB into channelAllocMask — cross-boundary leak CONFIRMED ***")
        }
    }

    // :35906-35920 — response built with DataOutputStream and pushed via
    // ServerCommonAudioProfile::updateValue_forCharacteristic_onSubscribedCentrals_
    // (real daemon: ASEControlPointCharacteristic). Our echo is an instrumented
    // superset so the central can see every parsed (incl. OOB-derived) value.
    // Format: [respOp][numASE][aseID][status][sf][fd][frames][chanAlloc 4B][octets 2B]
    //         [tlvCount] then per TLV [len][type][region][copyLen][copy...]
    func echoData(_ p: ParsedConfig, aseID: UInt8) -> Data {
        var e: [UInt8] = [0x01, 0x01, aseID, 0x01,
                          p.samplingFrequency, p.frameDuration, p.framesPerSDU]
        e += p.chanAlloc + p.octetsPerFrame
        let n = min(p.tlvs.count, 64)
        e.append(UInt8(n))
        for t in p.tlvs.prefix(n) {
            e += [t.len, t.type, t.region.rawValue, UInt8(t.copied.count)] + t.copied
        }
        return Data(e)
    }
}

// MARK: - Peripheral manager

final class Victim: NSObject, CBPeripheralManagerDelegate {
    let pm = CBPeripheralManager()
    var service: CBMutableService!
    var sinkASE: CBMutableCharacteristic!
    var sourceASE: CBMutableCharacteristic!
    var controlPoint: CBMutableCharacteristic!
    let engine = ASCSEngine()
    var lastEcho: [CBUUID: Data] = [:]

    override init() {
        super.init()
        pm.delegate = self
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        ts("PM state: \(peripheral.state.rawValue)")
        guard peripheral.state == .poweredOn else {
            if peripheral.state == .unauthorized || peripheral.state == .unsupported {
                ts("FATAL: CoreBluetooth \(peripheral.state == .unauthorized ? "unauthorized (TCC)" : "unsupported") — loopback cannot run")
                exit(2)
            }
            return
        }
        sinkASE = CBMutableCharacteristic(type: kSinkASEUUID, properties: [.read, .notify],
                                          value: nil, permissions: [.readable])
        sourceASE = CBMutableCharacteristic(type: kSourceASEUUID, properties: [.read, .notify],
                                            value: nil, permissions: [.readable])
        controlPoint = CBMutableCharacteristic(
            type: kControlPointUUID,
            properties: [.write, .writeWithoutResponse, .read, .notify],
            value: nil, permissions: [.writeable, .readable])
        service = CBMutableService(type: kServiceUUID, primary: true)
        service.characteristics = [sinkASE, sourceASE, controlPoint]
        pm.add(service)
        let adv: [String: Any] = [CBAdvertisementDataLocalNameKey: kVictimName,
                                  CBAdvertisementDataServiceUUIDsKey: [kServiceUUID]]
        pm.startAdvertising(adv)
        ts("service 0x184B added; advertising \"\(kVictimName)\" + 0x184B")
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        ts("advertising started" + (error.map { " (error: \($0))" } ?? "") + " — waiting for central")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        ts("central \(central) subscribed to \(characteristic.uuid)")
        if let d = lastEcho[characteristic.uuid] {           // replay cached echo
            pm.updateValue(d, for: characteristic as! CBMutableCharacteristic, onSubscribedCentrals: nil)
        }
    }

    // :35531 header — receivedWriteRequest: @100032d80, opcode dispatch :35586-35592.
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for req in requests {
            let value = req.value ?? Data()
            ts("write to \(req.characteristic.uuid): \(hex(value)) (\(value.count) B)")
            guard req.characteristic.uuid == kControlPointUUID else {
                pm.respond(to: req, withResult: .success); continue
            }
            guard let op = value.first else { pm.respond(to: req, withResult: .requestNotSupported); continue }
            switch op {
            case 0x01:
                engine.handleCodecConfig(value) { data in     // → codecConfigRequest_ @10003344c
                    ts("echo (\(data.count) B): \(hex(data))")
                    for ch in [controlPoint!, sinkASE!, sourceASE!] {
                        lastEcho[ch.uuid] = data
                        if !pm.updateValue(data, for: ch, onSubscribedCentrals: nil) {
                            ts("(updateValue returned false for \(ch.uuid) — no subscriber yet; cached for replay on subscribe)")
                        }
                    }
                }
            default:
                ts("opcode 0x\(String(op, radix: 16)) not exercised by PoC (decompile dispatches 2=QoS, 3=enable, ...)")
            }
            pm.respond(to: req, withResult: .success)
        }
    }

    // :35660+ — ASE read request: ASE_ID + state.
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        if request.characteristic.uuid == kSinkASEUUID || request.characteristic.uuid == kSourceASEUUID {
            request.value = Data([0x01, 0x01])               // ASE_ID=1, state=Idle(1)
        }
        pm.respond(to: request, withResult: .success)
    }
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined(separator: " ") }

// --parse <hex> [<hex> ...]: direct-feed selftest — run the REAL parser/heap/
// canary/echo chain on the attacker's crafted payloads with only the BLE
// transport bypassed (CoreBluetooth on macOS does not route a local
// peripheral's advertisements to the local central, so the loopback
// demonstration is driven at the ATT-payload boundary).
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--parse"), args.count > i + 1 {
    ts("direct-feed selftest mode: real parser + malloc heap + adjacent canary, BLE transport bypassed")
    let engine = ASCSEngine()
    for arg in args[(i + 1)...] {
        let clean = arg.replacingOccurrences(of: " ", with: "")
        var bytes = [UInt8](); var idx = clean.startIndex
        while idx < clean.endIndex, let v = UInt8(clean[idx..<clean.index(idx, offsetBy: 2)], radix: 16) {
            bytes.append(v); idx = clean.index(idx, offsetBy: 2)
        }
        ts("=== payload (\(bytes.count) B): \(hex(Data(bytes))) ===")
        engine.handleCodecConfig(Data(bytes)) { data in
            ts("echo (\(data.count) B): \(hex(data))")
            let b = [UInt8](data)
            if let r = b.firstRange(of: kCanaryPattern.prefix(4)) {
                ts(">>> CANARY MAGIC CA FE BA BE present in echoed bytes at offset \(r.lowerBound) <<<")
            }
            var o = 14
            if b.count > 14, b[0] == 0x01 {
                for t in 0..<Int(b[13]) {
                    guard o + 4 <= b.count else { break }
                    let cl = Int(b[o+3])
                    let copy = cl > 0 && o + 4 + cl <= b.count ? Array(b[(o+4)..<(o+4+cl)]) : []
                    ts("  echo tlv[\(t)] len=0x\(String(b[o], radix: 16)) type=0x\(String(b[o+1], radix: 16)) region=\(ReadRegion(rawValue: b[o+2]).map { "\($0)" } ?? "?")\(copy.isEmpty ? "" : " copy=\(hex(Data(copy)))")")
                    o += 4 + cl
                }
            }
        }
    }
    ts("=== SELFTEST VERDICT: \(engine.magicLeaked ? "PASSED — canary magic crossed the heap boundary into parsed+echoed codec fields" : "FAILED — no canary magic in parsed fields") ===")
    exit(engine.magicLeaked ? 0 : 1)
}

ts("LE Audio ASCS victim simulator — advertising 0x184B on this Mac only (SAFETY: self-owned target)")
let victim = Victim()
dispatchMain()
