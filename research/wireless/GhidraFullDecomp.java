// Full decompile export — every function, real symbols, ready-to-read C.
// Usage (headless, program already imported & analyzed):
//   analyzeHeadless <proj> <projName> -process <name> -noanalysis \
//     -scriptPath <thisDir> -postScript GhidraFullDecomp.java <outdir>
// Writes <outdir>/<binary>.functions.json + one .c per function (capped).
// @category Analysis

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.Address;
import ghidra.util.task.ConsoleTaskMonitor;

import java.io.*;
import java.util.*;

public class GhidraFullDecomp extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        File outDir = args.length > 0 ? new File(args[0]) : new File("/tmp/decomp");
        outDir.mkdirs();
        String base = currentProgram.getName().replaceAll("[^A-Za-z0-9_.-]", "_");

        DecompInterface di = new DecompInterface();
        DecompileOptions opts = new DecompileOptions();
        di.setOptions(opts);
        di.toggleCCode(true);
        di.setSimplificationStyle("decompile");
        di.openProgram(currentProgram);

        FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
        List<Function> fns = new ArrayList<>();
        while (it.hasNext()) fns.add(it.next());

        println("DECOMP " + base + " functions=" + fns.size());
        int written = 0;
        PrintWriter idx = new PrintWriter(new FileWriter(new File(outDir, base + ".functions.txt")));
        idx.println("# name\tentry\tsize\tcalls\tn_insns");

        Set<Function> seen = new HashSet<>();
        List<String> allC = new ArrayList<>();
        for (Function f : fns) {
            if (seen.add(f)) {
                Address e = f.getEntryPoint();
                long size = f.getBody().getNumAddresses();
                int nInsns = 0;
                var listing = currentProgram.getListing();
                var insns = listing.getInstructions(f.getBody(), true);
                while (insns.hasNext()) { insns.next(); nInsns++; }
                // real symbol: prefer demangled / source name over FUN_xxxx
                String name = f.getName();
                String dem = f.getSignature().getPrototypeString(true);
                idx.println(name + "\t" + e + "\t" + size + "\t" + nInsns + "\t" + dem);
                if (written < 40000) { // hard cap
                    DecompileResults res = di.decompileFunction(f, 120, monitor);
                    if (res != null && res.decompileCompleted()) {
                        String c = res.getDecompiledFunction().getC();
                        if (c != null) {
                            allC.add("// ==== " + name + " @ " + e + " (" + size + " bytes) ====\n" + c);
                            written++;
                        }
                    }
                }
            }
        }
        idx.close();
        PrintWriter pw = new PrintWriter(new FileWriter(new File(outDir, base + ".c")));
        for (String s : allC) { pw.println(s); pw.println(); }
        pw.close();
        di.dispose();
        println("DECOMP DONE " + base + " wrote=" + written);
    }
}