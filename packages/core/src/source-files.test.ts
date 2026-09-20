import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectScopeFiles, countScopeFilesUpTo } from "./source-files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")("does not expose outside source through file, directory, or hard-link aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "0sec-source-scope-"));
  roots.push(root);
  const target = join(root, "target");
  const outside = join(root, "outside");
  mkdirSync(target);
  mkdirSync(outside);
  const safe = join(target, "safe.ts");
  const canary = join(outside, "canary.ts");
  writeFileSync(safe, "export const safe = true;\n");
  writeFileSync(canary, "OUTSIDE_SCOPE_CANARY\n");
  symlinkSync(canary, join(target, "file-alias.ts"));
  symlinkSync(outside, join(target, "directory-alias"));
  symlinkSync(target, join(target, "cycle"));
  linkSync(canary, join(target, "hard-alias.ts"));

  expect(collectScopeFiles(target)).toEqual([safe]);
  expect(countScopeFilesUpTo(target, 1)).toBe(1);
});

it("still counts nested source and detects when the review cap is exceeded", () => {
  const root = mkdtempSync(join(tmpdir(), "0sec-source-count-"));
  roots.push(root);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "first.ts"), "export const first = 1;\n");
  writeFileSync(join(root, "nested", "second.ts"), "export const second = 2;\n");
  expect(collectScopeFiles(root)).toEqual([join(root, "first.ts"), join(root, "nested", "second.ts")]);
  expect(countScopeFilesUpTo(root, 1)).toBe(2);
});

it("collects C#/.NET source (issue #74) alongside other languages", () => {
  const dir = mkdtempSync(join(tmpdir(), "srcfiles-cs-"));
  roots.push(dir);
  writeFileSync(join(dir, "HttpClientHandler.cs"), "namespace System.Net.Http;\n");
  writeFileSync(join(dir, "Program.fs"), "module Program\n");
  writeFileSync(join(dir, "Legacy.vb"), "Module Legacy\n");
  writeFileSync(join(dir, "View.swift"), "import Foundation\n");
  writeFileSync(join(dir, "init.lua"), "return {}\n");
  writeFileSync(join(dir, "notes.md"), "# not source\n");

  const found = collectScopeFiles(dir).map((f) => f.split("/").pop()).sort();

  expect(found).toEqual([
    "HttpClientHandler.cs",
    "Legacy.vb",
    "Program.fs",
    "View.swift",
    "init.lua",
  ]);
});

