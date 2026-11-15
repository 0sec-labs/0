import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) && entry.name !== "no-engine-dist-imports.test.ts" ? [path] : [];
  });
}

describe("engine imports", () => {
  test("web reaches the engine through its exports map (@0/engine/shared), never a /dist/ path", () => {
    const offenders = [...files(join(ROOT, "src")), ...files(join(ROOT, "test"))]
      .flatMap(path => readFileSync(path, "utf8").split("\n").flatMap((line, index) => /@0\/engine\/dist\//.test(line) ? [`${relative(ROOT, path)}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
  });
});
