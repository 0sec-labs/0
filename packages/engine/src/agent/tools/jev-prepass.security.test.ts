import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ToolContext } from "../types.js";
import { executeJevPrepass } from "./jev-prepass.js";

it("reads commit history and diff stats from literal paths without executing shell substitutions", async () => {
  const parent = mkdtempSync(join(tmpdir(), "0-jev-literal-"));
  const dollarMarker = `zero-jev-dollar-${randomUUID()}`;
  const backtickMarker = `zero-jev-backtick-${randomUUID()}`;
  const markerPaths = [dollarMarker, backtickMarker].map((name) => join(process.cwd(), name));
  try {
    for (const name of ["ordinary repository", `repository $(touch ${dollarMarker}) \`touch ${backtickMarker}\``]) {
      const root = join(parent, name);
      mkdirSync(root);
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(root, "entry.ts"), "initial line\n");
      git("add", "entry.ts");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
      writeFileSync(join(root, "entry.ts"), "initial line\nnew line\n");
      git("add", "entry.ts");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "source change");
      const ctx: ToolContext = { target: root, scopePath: root, scanId: "literal-path", findings: [], attackResults: [], targetInfo: {} };
      const result = await executeJevPrepass(ctx, { operation: "commit", target: root, max_candidates: 1 });
      expect(markerPaths.map((path) => existsSync(path))).toEqual([false, false]);
      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({ operation: "commit", evaluated: 0, candidates: [{ subject: "source change", filesChanged: 1, insertions: 1, deletions: 0 }] });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    for (const path of markerPaths) rmSync(path, { force: true });
  }
});
