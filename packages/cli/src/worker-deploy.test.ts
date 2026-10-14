import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolveWorkerRepoRoot, validateWorkerOptions } from "./worker-deploy.js";

describe("worker deployment assets", () => {
  it("resolves both source and split bundle modules to their package root", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-assets-"));
    try {
      mkdirSync(join(root, "dist")); mkdirSync(join(root, "vendor"));
      writeFileSync(join(root, "dist/0.js"), "");
      writeFileSync(join(root, "vendor/tree-sitter-0.21.1-node24.tgz"), "");
      for (const path of ["packages/cli/src/worker-deploy.ts", "dist/chunks/worker-deploy.js"]) {
        expect(resolveWorkerRepoRoot(pathToFileURL(join(root, path)).href)).toBe(root);
      }
      rmSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "0.js"), "");
      expect(resolveWorkerRepoRoot(pathToFileURL(join(root, "chunks/worker-deploy.js")).href)).toBe(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects invalid ports before invoking the worker", () => {
    for (const enginePort of [0, 65536, 1.5]) expect(() => validateWorkerOptions({ ssh: "worker", enginePort })).toThrow("enginePort");
  });
});
