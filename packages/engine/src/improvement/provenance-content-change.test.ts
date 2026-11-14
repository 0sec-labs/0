import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { snapshots } = vi.hoisted(() => ({ snapshots: new Map<string, unknown>() }));
// Reproduce a same-length write within one filesystem timestamp tick without
// relying on scheduler timing or changing the contents the digest reads.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, statSync: (...args: Parameters<typeof actual.statSync>) => {
    const key = String(args[0]);
    if (!snapshots.has(key)) snapshots.set(key, actual.statSync(...args));
    return snapshots.get(key);
  } };
});
import { evolutionToolImplementationDigest } from "./provenance.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  snapshots.clear();
});

describe("controller content attestation with unchanged file metadata", () => {
  it.each(["bundled", "campaign-validation-budget", "../bench/task-routing"])("rejects changed %s bytes even when all stat fields are unchanged", kind => {
    const root = mkdtempSync(join(tmpdir(), "0-provenance-stamp-collision-"));
    roots.push(root);
    const modules = join(root, kind === "bundled" ? "chunks" : "improvement");
    mkdirSync(modules); mkdirSync(join(root, "bench"));
    let entry: string, changed: string;
    if (kind === "bundled") {
      entry = join(modules, "chunk-controller.js");
      changed = join(modules, "chunk-sandbox.js");
      writeFileSync(entry, "export const controller = 1;\n");
    } else {
      for (const name of ["sandbox", "controller-lock", "config", "registry", "evaluation", "safety", "curation-lineage", "retention", "provenance", "rewrite", "loop", "campaign-validation-budget", "../bench/task-routing"]) {
        writeFileSync(join(modules, `${name}.ts`), "export const fixtureRevision = 1;\n");
      }
      entry = join(modules, "provenance.ts");
      changed = join(modules, `${kind}.ts`);
    }
    writeFileSync(changed, "export const fixtureRevision = 1;\n");
    const url = pathToFileURL(entry);
    const observed = evolutionToolImplementationDigest(url);
    expect(evolutionToolImplementationDigest(url)).toBe(observed);
    const original = readFileSync(changed);
    writeFileSync(changed, "export const fixtureRevision = 2;\n");
    const updated = readFileSync(changed);
    expect(updated.length).toBe(original.length);
    expect(updated.equals(original)).toBe(false);
    expect(() => evolutionToolImplementationDigest(url)).toThrow(/restart before evaluation/);
  });
});
