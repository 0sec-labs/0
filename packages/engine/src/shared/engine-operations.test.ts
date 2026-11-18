import { describe, expect, it } from "vitest";
import { ENGINE_OPERATION_DEFINITIONS, EngineCapabilityManifestSchema, createEngineCapabilityManifest, requireEngineOperation } from "./engine-operations.js";

describe("shared engine operation capability manifest", () => {
  it("advertises only host-registered operations and report formats", () => {
    const manifest = createEngineCapabilityManifest({ operations: ["get_run", "resume_session"], reportFormats: ["json", "sarif"] });
    expect(manifest).toEqual({ schemaVersion: 1, operations: ["get_run", "resume_session"], reportExport: { formats: ["json", "sarif"] }, resume: { session: true, scan: false, workflow: false } });
    expect(() => requireEngineOperation(manifest, "resume_session")).not.toThrow();
    expect(() => requireEngineOperation(manifest, "start_run")).toThrow("does not support");
    expect(createEngineCapabilityManifest({ operations: [] }).reportExport.formats).toEqual([]);
  });
  it("cannot claim workflow replay, unregistered resume, unknown operations, or credentials", () => {
    const manifest = createEngineCapabilityManifest({ operations: [] });
    for (const invalid of [
      { ...manifest, operations: ["arbitrary_shell"] }, { ...manifest, operations: ["get_run", "get_run"] },
      { ...manifest, resume: { ...manifest.resume, scan: true } }, { ...manifest, resume: { ...manifest.resume, workflow: true } },
      { ...manifest, bearerToken: "secret" }, { ...manifest, reportExport: { formats: ["json", "json"] } },
    ]) expect(EngineCapabilityManifestSchema.safeParse(invalid).success).toBe(false);
    expect(createEngineCapabilityManifest({ operations: ["resume_scan"] }).resume).toEqual({ session: false, scan: true, workflow: false });
  });
  it("keeps operation ids unique", () => {
    expect(new Set(ENGINE_OPERATION_DEFINITIONS.map(operation => operation.id)).size).toBe(ENGINE_OPERATION_DEFINITIONS.length);
  });
});
