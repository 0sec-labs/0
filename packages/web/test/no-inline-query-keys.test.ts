import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("query keys", () => {
  test("every queryKey comes from queryKeys in queries.ts, never an inline array", () => {
    const offenders = files(SRC).filter(path => relative(SRC, path) !== "queries.ts")
      .flatMap(path => readFileSync(path, "utf8").split("\n").flatMap((line, index) => /queryKey\s*[:=]\s*\[/.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
  });
});
