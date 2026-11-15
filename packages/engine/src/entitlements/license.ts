/**
 * Offline license verification for the enterprise edition.
 *
 * A license is JSON `{ payload, signature }`. The payload is signed with Ed25519 over its
 * canonical JSON (keys sorted recursively). The verifier needs public keys, which are
 * passed in; the binary pins them in {@link PINNED_LICENSE_KEYS}. That list is empty until the
 * company generates a signing key, so no license verifies today and nothing in the open-source
 * engine changes behavior. There is no network access and no phone-home.
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface LicenseKey {
  /** Matches the `keyId` field of a license, so keys can rotate. */
  id: string;
  /** Ed25519 public key as PEM (SPKI). */
  publicKeyPem: string;
}

/** Public keys the binary trusts. Intentionally empty until a signing key exists. */
export const PINNED_LICENSE_KEYS: readonly LicenseKey[] = [];

const FEATURE = /^[a-z][a-z0-9.-]{0,63}$/;
const payloadSchema = z.object({
  version: z.literal(1),
  keyId: z.string().min(1).max(64),
  licenseId: z.string().min(1).max(128),
  customer: z.string().min(1).max(256),
  features: z.array(z.string().regex(FEATURE)).max(100),
  notBefore: z.string().datetime(),
  expires: z.string().datetime(),
}).strict();
const licenseSchema = z.object({ payload: payloadSchema, signature: z.string().min(1).max(1024) }).strict();

export type LicensePayload = z.infer<typeof payloadSchema>;
export type LicenseResult =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: "missing" | "malformed" | "unknown-key" | "bad-signature" | "not-yet-valid" | "expired" };

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Verify license text against the given keys at the given time. Never throws. */
export function verifyLicense(licenseText: string | undefined, options: { keys?: readonly LicenseKey[]; now?: Date } = {}): LicenseResult {
  if (licenseText === undefined || licenseText.trim() === "") return { valid: false, reason: "missing" };
  let parsed;
  try { parsed = licenseSchema.safeParse(JSON.parse(licenseText)); } catch { return { valid: false, reason: "malformed" }; }
  if (!parsed.success) return { valid: false, reason: "malformed" };
  const { payload, signature } = parsed.data;
  const key = (options.keys ?? PINNED_LICENSE_KEYS).find(candidate => candidate.id === payload.keyId);
  if (!key) return { valid: false, reason: "unknown-key" };
  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(key.publicKeyPem), Buffer.from(signature, "base64"));
  } catch { signatureOk = false; }
  if (!signatureOk) return { valid: false, reason: "bad-signature" };
  const now = (options.now ?? new Date()).getTime();
  if (now < Date.parse(payload.notBefore)) return { valid: false, reason: "not-yet-valid" };
  if (now >= Date.parse(payload.expires)) return { valid: false, reason: "expired" };
  return { valid: true, payload };
}

export interface Entitlements {
  readonly licensed: boolean;
  readonly customer?: string;
  /** True only for a valid license that lists the feature. Always false without one. */
  has(feature: string): boolean;
  readonly reason?: Exclude<LicenseResult, { valid: true }>["reason"];
}

/** Default license location, overridable with ZERO_LICENSE_FILE. */
export function defaultLicensePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env["ZERO_LICENSE_FILE"]?.trim() || join(home, ".0", "license.json");
}

/** Load entitlements from disk. A missing or invalid license yields an unlicensed object, never an error. */
export function loadEntitlements(options: { path?: string; keys?: readonly LicenseKey[]; now?: Date; env?: NodeJS.ProcessEnv } = {}): Entitlements {
  let text: string | undefined;
  try { text = readFileSync(options.path ?? defaultLicensePath(options.env), "utf8"); } catch { text = undefined; }
  const result = verifyLicense(text, { keys: options.keys, now: options.now });
  if (!result.valid) return { licensed: false, reason: result.reason, has: () => false };
  const features = new Set(result.payload.features);
  return { licensed: true, customer: result.payload.customer, has: feature => features.has(feature) };
}
