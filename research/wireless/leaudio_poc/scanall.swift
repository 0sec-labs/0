import Foundation
import CoreBluetooth
final class S: NSObject, CBCentralManagerDelegate {
    var c: CBCentralManager!
    override init() { super.init(); c = CBCentralManager(delegate: self, queue: nil) }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        print("state \(central.state.rawValue)")
        if central.state == .poweredOn { central.scanForPeripherals(withServices: nil, options: nil) }
    }
    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? p.name ?? ""
        let svcs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map { $0.description } ?? []
        print("scan: \"\(name)\" rssi=\(RSSI) svcs=\(svcs)")
    }
}
let s = S()
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { exit(0) }
dispatchMain()
