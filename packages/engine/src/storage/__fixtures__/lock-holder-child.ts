// Holds the database write lock for a fixed time, then commits.
import { createShimmedDatabase } from "../wasm-shim.js";

const [path, holdMs] = process.argv.slice(2);
const db = createShimmedDatabase(path);
db.exec("BEGIN IMMEDIATE");
console.log("READY");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec("COMMIT");
db.close();
