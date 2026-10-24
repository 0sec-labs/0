import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { auditEvolutionCorpusRotation, evolutionToolImplementationDigest, observedEvolutionModelRevision } from "./provenance.js";
import { compareEvolutionIdentities, createEvolutionComparisonIdentity } from "./safety.js";
import type { EvolutionConfig } from "./types.js";
const digest = (n: string) => "sha256:" + n.repeat(64);
const config = { cases: [
  { id: "dev", lane: "development", input: 1, expected: true },
  { id: "hold", lane: "held-out", input: 2, expected: true },
  { id: "negative", lane: "negative-control", input: 3, expected: false },
], command: ["node", "worker.js"], image: digest("a"), timeoutMs: 100, memoryMb: 128, cpus: 1, maxOutputBytes: 1024,
  safety: { enabled: true, holdoutExposureLimit: 10, workerModel: { provider: "p", model: "alias", maxCostUsdPerExecution: 1 } },
} as EvolutionConfig;
const generator = { provider: "proposal-provider", model: "proposal-alias" };
const worker = { provider: "p", model: "alias", modelVersionStatus: "pinned" as const, modelRevision: "immutable-release-7", decodingDigest: digest("b") };
const identity = (observed = worker) => createEvolutionComparisonIdentity(config, digest("c"), {
  sourceRevision: digest("d"), provider: generator.provider, resolvedModel: generator.model, generatorIdentity: generator, workerIdentity: observed,
});
describe("observed evolution provenance", () => {
  it("never infers a pinned version from a model alias or incomplete pinned assertion", () => {
    expect(observedEvolutionModelRevision({ provider: "p", model: "alias" })).toEqual({ status: "unavailable", revision: null, decodingDigest: null });
    expect(observedEvolutionModelRevision({ ...worker, modelVersionStatus: "floating" }).status).toBe("floating");
    expect(observedEvolutionModelRevision({ ...worker, decodingDigest: undefined }).status).toBe("unavailable");
  });
  it("separates proposal aliases from actual pinned evaluated worker identity", () => {
    const observed = identity();
    expect(observed.proposalModelRevision?.status).toBe("unavailable");
    expect(observed.evaluatedWorker).toMatchObject({ kind: "model", provider: "p", model: "alias", revision: { status: "pinned", revision: worker.modelRevision } });
    expect(compareEvolutionIdentities(observed, observed).status).toBe("compatible");
  });
  it.each(["floating", "unavailable"] as const)("fails closed for %s actual worker versions", status => {
    const observed = identity({ ...worker, modelVersionStatus: status } as typeof worker);
    expect(compareEvolutionIdentities(observed, observed).status).toBe("unknown");
  });
  it("rejects model release and decoding changes even when provider aliases are unchanged", () => {
    expect(compareEvolutionIdentities(identity(), identity({ ...worker, modelRevision: "release-8" })).status).toBe("incompatible");
    expect(compareEvolutionIdentities(identity(), identity({ ...worker, decodingDigest: digest("e") })).status).toBe("incompatible");
    const legacy = { ...identity() }; delete legacy.evaluatedWorker;
    expect(compareEvolutionIdentities(legacy, legacy).status).toBe("unknown");
  });
  it("rejects malformed or missing source/tool/evaluator byte identities", () => {
    for (const key of ["sourceRevision", "toolRevision", "evaluatorDigest", "harnessRevision"] as const) {
      const malformed = { ...identity(), [key]: "requested-path-not-observed-bytes" };
      expect(compareEvolutionIdentities(malformed, malformed).status).toBe("unknown");
    }
  });
  it("records bounded actual tool module bytes and reuses the same content identity", () => {
    const observed = evolutionToolImplementationDigest();
    expect(observed).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evolutionToolImplementationDigest()).toBe(observed);
  });
  it("attests bounded bundled chunks and refuses to relabel changed disk bytes as loaded code", () => {
    const root = mkdtempSync(join(tmpdir(), "0-bundled-identity-"));
    try {
      const chunks = join(root, "chunks"); mkdirSync(chunks);
      const module = join(chunks, "chunk-controller.js"), dependency = join(chunks, "chunk-sandbox.js");
      writeFileSync(module, "export const controller = 1;\n"); writeFileSync(dependency, "export const sandbox = 1;\n");
      writeFileSync(join(root, "0.js"), "import './chunks/chunk-controller.js';\n");
      const observed = evolutionToolImplementationDigest(pathToFileURL(module));
      expect(observed).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(evolutionToolImplementationDigest(pathToFileURL(module))).toBe(observed);
      writeFileSync(dependency, "export const sandbox = 2;\n");
      expect(() => evolutionToolImplementationDigest(pathToFileURL(module))).toThrow(/restart before evaluation/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("observes a real esbuild-bundled controller without source sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "0-real-bundle-identity-"));
    try {
      symlinkSync(new URL("../../node_modules", import.meta.url), join(root, "node_modules"), "dir");
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      const output = join(root, "controller.js");
      await build({ entryPoints: [new URL("./provenance.ts", import.meta.url).pathname], outfile: output, bundle: true,
        format: "esm", platform: "node", target: "node24", packages: "external", logLevel: "silent" });
      const script = `const m = await import(${JSON.stringify(pathToFileURL(output).href)}); process.stdout.write(m.evolutionToolImplementationDigest());`;
      const observed = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
      expect(observed).toMatch(/^sha256:[a-f0-9]{64}$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("audits content additions and retirements without age-based correctness claims", () => {
    expect(auditEvolutionCorpusRotation([digest("a"), digest("b")], [digest("b"), digest("c")])).toEqual({
      retained: [digest("b")], retired: [digest("a")], added: [digest("c")], policy: "operator-curated-rotation-required",
    });
    expect(() => auditEvolutionCorpusRotation([digest("a"), digest("a")], [])).toThrow(/unique/);
  });
});
