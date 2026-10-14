// Ghidra headless postscript — firmware recon summary (Java, no PyGhidra needed).
// @category Analysis

import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.data.*;
import ghidra.program.model.address.*;

import java.util.*;

public class GhidraFwStats extends GhidraScript {
    @Override
    public void run() throws Exception {
        Program prog = currentProgram;
        FunctionIterator it = prog.getFunctionManager().getFunctions(true);
        List<Function> funcs = new ArrayList<>();
        while (it.hasNext()) funcs.add(it.next());
        println("FW-STATS functions=" + funcs.size() + " imageBase=" + prog.getImageBase());

        funcs.sort(Comparator.comparingLong(f -> -f.getBody().getNumAddresses()));
        for (int i = 0; i < Math.min(15, funcs.size()); i++) {
            Function f = funcs.get(i);
            println("TOP-FN " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses() + " " + f.getName());
        }

        List<long[]> strAddrs = new ArrayList<>();
        List<String> strVals = new ArrayList<>();
        DataIterator di = prog.getListing().getDefinedData(true);
        int nStr = 0;
        while (di.hasNext()) {
            Data d = di.next();
            String dt = d.getDataType().getName();
            if (dt.startsWith("string") || dt.startsWith("char") || dt.equals("Unicode")) {
                Object v = d.getValue();
                if (v != null && v.toString().length() > 8) {
                    strAddrs.add(new long[]{d.getAddress().getOffset()});
                    strVals.add(v.toString());
                    nStr++;
                }
            }
        }
        println("FW-STATS strings=" + nStr);
        String[] keys = {"airdrop", "awdl", "hotspot", "nan_", "wpa", "bssid", "ssid", "pciedev", "dma", "malloc", "free", "event", "crypto"};
        for (int i = 0; i < strVals.size(); i++) {
            String low = strVals.get(i).toLowerCase();
            for (String k : keys) {
                if (low.contains(k)) {
                    println("STR 0x" + Long.toHexString(strAddrs.get(i)[0]) + " " + strVals.get(i).substring(0, Math.min(120, strVals.get(i).length())));
                    break;
                }
            }
        }
        println("FW-STATS done");
    }
}
