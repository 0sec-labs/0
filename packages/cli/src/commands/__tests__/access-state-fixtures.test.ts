import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAccessControlFixturesFile } from "../scan.js";

describe("operator-owned disposable state contracts", () => {
  const fixture = { url: "https://target.test/state", ownerIdentity: "owner", comparisonIdentities: ["actor"], ownershipMarker: "PRIVATE_SYNTHETIC_STATE_MARKER",
    stateChange: { disposable: true, jsonPointer: "/marker", stepUrls: ["https://target.test/state"] } };
  function parse(value: unknown) {
    const root = mkdtempSync(join(tmpdir(), "0-state-fixtures-")), path = join(root, "fixtures.json");
    try { writeFileSync(path, JSON.stringify([value])); return parseAccessControlFixturesFile(path); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
  it("preserves an explicit restricted disposable-state contract", () => {
    expect(parse(fixture)[0]).toEqual(fixture);
  });
  it.each([
    { ...fixture, stateChange: { ...fixture.stateChange, disposable: false } },
    { ...fixture, stateChange: { ...fixture.stateChange, stepUrls: ["https://outside.test/state"] } },
    { ...fixture, stateChange: { ...fixture.stateChange, jsonPointer: "/invalid~pointer" } },
    { ...fixture, url: "https://secret:credential@target.test/state" },
    { ...fixture, stateChange: { ...fixture.stateChange, cleanupBaseline: "model-claim" } },
  ])("rejects undeclared authority without echoing private values", invalid => {
    expect(() => parse(invalid)).toThrow(/Invalid --access-control-fixtures/);
    try { parse(invalid); } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_SYNTHETIC_STATE_MARKER");
      expect(String(error)).not.toContain("credential@");
    }
  });
});
