/** The per-install seal key: 32 random bytes in a file readable only by the 0 process user (0600). See core/seal.ts. */
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const sealKeyPath = (root: string): string => join(root, ".seal-key");

export function readSealKey(root: string): Buffer | null {
  const path = sealKeyPath(root);
  try {
    if (!existsSync(path) || !lstatSync(path).isFile()) return null;
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    return key.length === 32 ? key : null;
  } catch { return null; }
}

/** Existing key, or a new one. Throws on I/O failure (callers treat that as "cannot record an approval"). */
export function ensureSealKey(root: string): Buffer {
  const existing = readSealKey(root); if (existing) return existing;
  const key = randomBytes(32); const path = sealKeyPath(root);
  writeFileSync(path, `${key.toString("hex")}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  return key;
}
