import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(__dirname, "..", "src");
/** Paths (relative to src) that may contain emoji because they render user or model content, not UI chrome. Keep this empty unless a file needs it. */
const ALLOWED: readonly string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("icons", () => {
  test("web UI source contains no emoji; icons come from the Capy or lucide sets", () => {
    const offenders = files(SRC).map(path => relative(SRC, path)).filter(path => !ALLOWED.includes(path))
      .flatMap(path => readFileSync(join(SRC, path), "utf8").split("\n").flatMap((line, index) => /\p{Extended_Pictographic}/u.test(line) ? [`${path}:${index + 1}`] : []));
    expect(offenders).toEqual([]);
  });
});
