import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixDependencies } from "../deps.js";

describe("fixDependencies", () => {
  it("only reports the command unless apply is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deps-fix-"));
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    const result = await fixDependencies(dir, undefined, false);
    expect(result).toMatchObject({ ecosystem: "pnpm", command: "pnpm audit --fix", exitCode: 0, applied: false });
  });
});
