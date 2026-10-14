# Ghidra headless postscript: firmware recon summary.
# Prints function count, top functions by size, and macOS/host-visible artifacts.
# @category: Analysis

from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

def run():
    prog = currentProgram
    fm = prog.getFunctionManager()
    funcs = list(fm.getFunctions(True))
    print("FW-STATS functions=%d imageBase=%s" % (len(funcs), prog.getImageBase()))

    top = sorted(funcs, key=lambda f: f.getBody().getNumAddresses())[-15:]
    for f in top:
        print("TOP-FN %s size=%d %s" % (f.getEntryPoint(), f.getBody().getNumAddresses(), f.getName()))

    # defined strings
    listing = prog.getListing()
    strings = []
    di = listing.getDefinedData(True)
    for d in di:
        try:
            dt = d.getDataType().getName()
            if dt.startswith("string") or dt.startswith("char") or dt == "Unicode":
                v = d.getValue()
                if v and len(str(v)) > 8:
                    strings.append((d.getAddress().getOffset(), str(v)))
        except Exception:
            pass
    print("FW-STATS strings=%d" % len(strings))
    keys = ("airdrop", "awdl", "hotspot", "nan_", "wpa", "bssid", "ssid", "pciedev", "dma", "malloc", "free")
    for off, s in strings:
        low = s.lower()
        if any(k in low for k in keys):
            print("STR 0x%x %s" % (off, s[:120]))

    # unresolved external-ish: functions that reference strings about DMA/H2D (chip <-> host protocol)
    print("FW-STATS done")
