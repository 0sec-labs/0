import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read-only early rejection. The native flock remains the admission authority. */
export async function assertSmolvmAdmissionAvailable(stateRoot: string): Promise<void> {
  let lease: { root?: string; token?: string };
  try { lease = JSON.parse(await readFile(join(stateRoot, "active-run.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!lease.root || !/^\/tmp\/0w-[A-Za-z0-9]+$/.test(lease.root) || !lease.token || !/^[a-f0-9]{64}$/.test(lease.token)) throw new Error("Invalid retained workbench admission record; inspect it before admitting another guest");
  try {
    const proof = JSON.parse(await readFile(join(lease.root, "complete.json"), "utf8"));
    if (proof.schemaVersion !== 1 || proof.cleanupFailed !== false) throw new Error("Previous workspace teardown is unconfirmed; inspect the retained run before retrying");
    // Completed leases are recovered under native admission, never here.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Another chat is using the isolated workspace. Stop or close that chat before trying again.");
    throw error;
  }
}
