import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_LICENSE_KEYS, canonicalJson, loadEntitlements, verifyLicense, type LicenseKey, type LicensePayload } from "./license.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const key: LicenseKey = { id: "k1", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
const payload: LicensePayload = { version: 1, keyId: "k1", licenseId: "L-1", customer: "Example Corp", features: ["saml", "audit-export"], notBefore: "2026-01-01T00:00:00.000Z", expires: "2027-01-01T00:00:00.000Z" };
const issue = (p: unknown = payload, signer = privateKey) => JSON.stringify({ payload: p, signature: sign(null, Buffer.from(canonicalJson(p)), signer).toString("base64") });
const now = new Date("2026-06-01T00:00:00.000Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("verifyLicense", () => {
  it("accepts a correctly signed license inside its validity window", () => {
    const result = verifyLicense(issue(), { keys: [key], now });
    expect(result).toEqual({ valid: true, payload });
  });
  it("is independent of key order in the signed payload", () => {
    const shuffled = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse());
    const text = JSON.stringify({ payload: reordered, signature: JSON.parse(issue()).signature });
    expect(verifyLicense(text, { keys: [key], now }).valid).toBe(true);
  });
  it("rejects tampering, a wrong signer and an unknown key", () => {
    const tampered = JSON.parse(issue()) as { payload: LicensePayload; signature: string };
    tampered.payload.features = ["saml", "audit-export", "everything"];
    expect(verifyLicense(JSON.stringify(tampered), { keys: [key], now })).toEqual({ valid: false, reason: "bad-signature" });
    expect(verifyLicense(issue(payload, other.privateKey), { keys: [key], now })).toEqual({ valid: false, reason: "bad-signature" });
    expect(verifyLicense(issue({ ...payload, keyId: "k2" }), { keys: [key], now })).toEqual({ valid: false, reason: "unknown-key" });
  });
  it("enforces the validity window", () => {
    expect(verifyLicense(issue(), { keys: [key], now: new Date("2025-12-31T23:59:59.000Z") })).toEqual({ valid: false, reason: "not-yet-valid" });
    expect(verifyLicense(issue(), { keys: [key], now: new Date("2027-01-01T00:00:00.000Z") })).toEqual({ valid: false, reason: "expired" });
  });
  it("reports missing and malformed input without throwing", () => {
    expect(verifyLicense(undefined, { keys: [key] })).toEqual({ valid: false, reason: "missing" });
    expect(verifyLicense("{not json", { keys: [key] })).toEqual({ valid: false, reason: "malformed" });
    expect(verifyLicense(JSON.stringify({ payload: { ...payload, extra: 1 }, signature: "x" }), { keys: [key] })).toEqual({ valid: false, reason: "malformed" });
    expect(verifyLicense(issue({ ...payload, features: ["Bad Feature!"] }), { keys: [key], now })).toEqual({ valid: false, reason: "malformed" });
  });
  it("trusts nothing by default: no key is pinned yet", () => {
    expect(PINNED_LICENSE_KEYS).toHaveLength(0);
    expect(verifyLicense(issue(), { now })).toEqual({ valid: false, reason: "unknown-key" });
  });
});

describe("loadEntitlements", () => {
  const write = (text: string) => { const dir = mkdtempSync(join(tmpdir(), "zero-license-")); dirs.push(dir); const path = join(dir, "license.json"); writeFileSync(path, text); return path; };
  it("grants only the licensed features", () => {
    const e = loadEntitlements({ path: write(issue()), keys: [key], now });
    expect(e.licensed).toBe(true); expect(e.customer).toBe("Example Corp");
    expect(e.has("saml")).toBe(true); expect(e.has("scim")).toBe(false);
  });
  it("is unlicensed, and never throws, when the file is absent or invalid", () => {
    expect(loadEntitlements({ path: "/nonexistent/license.json", keys: [key], now })).toMatchObject({ licensed: false, reason: "missing" });
    const bad = loadEntitlements({ path: write("garbage"), keys: [key], now });
    expect(bad.licensed).toBe(false); expect(bad.has("saml")).toBe(false);
  });
});
