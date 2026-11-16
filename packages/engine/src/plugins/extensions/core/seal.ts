/**
 * Seals: an HMAC of each approval-bearing record, keyed by a per-install secret that lives in a 0600 file next to the
 * state. Loading verifies the seal; an unsealed or mismatched record counts as unapproved (extensions) or as the
 * default (built-ins). Pure: the key is passed in.
 *
 * DEFENCE IN DEPTH, NOT A BOUNDARY. A process running as the same OS user can read the key and re-seal. The seal
 * stops the cheap attack (edit state.json, or an `approvedAt` field, by hand) and turns tampering into a visible,
 * audited re-approval. The sandbox and the protected-paths decider are the other layers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ExtensionEntry, ExtensionState } from "./state.js";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export const sealOf = (key: Buffer, subject: string, value: unknown): string => createHmac("sha256", key).update(`${subject}\0${canonical(value)}`).digest("hex");
const same = (a: string | undefined, b: string): boolean => a !== undefined && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Fresh seals for every record in `state`. */
export function sealAll(state: ExtensionState, key: Buffer): Record<string, string> {
  const seals: Record<string, string> = {};
  for (const [name, entry] of Object.entries(state.extensions)) seals[`ext:${name}`] = sealOf(key, `ext:${name}`, entry);
  for (const [name, record] of Object.entries(state.builtins)) seals[`builtin:${name}`] = sealOf(key, `builtin:${name}`, record);
  return seals;
}

const hasApproval = (e: ExtensionEntry): boolean => e.enabled.global || e.enabled.projects.length > 0 || e.approvedRevision !== null || Object.values(e.revisions).some(r => r.approvedAt !== null);

/** Drop every approval from an entry; it stays installed and must be approved again. */
export function stripApprovals(entry: ExtensionEntry): void {
  for (const r of Object.values(entry.revisions)) Object.assign(r, { approvedAt: null, approvedCapabilities: null, approvedCapabilityKey: null, approvedEnv: [] });
  entry.approvedRevision = null; entry.enabled = { global: false, projects: [] }; entry.sealBroken = true;
}

/** Apply the seals: records that do not verify lose their approvals (extensions) or are ignored (built-ins). `key` null = no key yet, nothing verifies. */
export function verifySeals(state: ExtensionState, key: Buffer | null): { state: ExtensionState; broken: string[] } {
  const broken: string[] = [];
  for (const [name, entry] of Object.entries(state.extensions)) {
    if (key && same(state.seals[`ext:${name}`], sealOf(key, `ext:${name}`, entry))) continue;
    if (hasApproval(entry)) { stripApprovals(entry); broken.push(name); }
  }
  for (const [name, record] of Object.entries(state.builtins)) {
    if (key && same(state.seals[`builtin:${name}`], sealOf(key, `builtin:${name}`, record))) continue;
    delete state.builtins[name]; broken.push(`builtin:${name}`);
  }
  return { state, broken };
}
