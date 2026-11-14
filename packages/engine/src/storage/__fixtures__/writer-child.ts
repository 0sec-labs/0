// Child process used by storage-robustness tests: writes scans/findings in a loop.
import { osecDB } from "../database.js";

const [path, tag, countArg, hangAfter] = process.argv.slice(2);
const count = Number(countArg);
const deadline = Date.now() + 100_000;
let db: osecDB | undefined;
while (!db) {
  try { db = new osecDB(path); } catch (error) {
    if (Date.now() > deadline) { console.error(String(error)); process.exit(3); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
let done = 0;
for (let i = 0; i < count; i++) {
  for (;;) {
    try {
      const scanId = `${tag}-scan-${i}`;
      if (!db.getScan(scanId)) db.createScan({ target: `https://${tag}.example/${i}`, depth: "default", format: "json" } as never, scanId);
      db.saveFinding(scanId, { id: `${tag}-f-${i}`, templateId: "t", title: `T ${tag} ${i}`, description: "d", severity: "low", category: "xss", status: "discovered", evidence: { request: "r", response: "p" }, timestamp: Date.now() } as never);
      break;
    } catch (error) {
      if (!/locked|busy/i.test(String(error)) || Date.now() > deadline) { console.error(String(error)); process.exit(2); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  done++;
  if (hangAfter && done >= Number(hangAfter)) { console.log("READY"); setInterval(() => undefined, 1000); await new Promise(() => undefined); }
}
db.close();
console.log("DONE");
