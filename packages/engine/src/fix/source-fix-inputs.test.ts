import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSourceFixProjectInputs, resolveSourceFixRepository, saveSourceFixProjectInputs } from "./source-fix-inputs.js";

const fixtures: string[] = [];
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "0-fix-inputs-")));
  fixtures.push(directory);
  return directory;
}
function repository() {
  const directory = fixture();
  execFileSync("git", ["init", "-q"], { cwd: directory });
  return directory;
}
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("operator-owned source-fix setup", () => {
  it("suggests the canonical Git root but never runs repository scripts or treats URLs/non-repositories as checkouts", async () => {
    const root = repository();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "touch unauthorized-script-ran" } }));
    expect(await resolveSourceFixRepository(join(root, "src"))).toBe(root);
    expect(await resolveSourceFixRepository("https://github.com/example/repo")).toBeUndefined();
    expect(await resolveSourceFixRepository(fixture())).toBeUndefined();
    expect(existsSync(join(root, "unauthorized-script-ran"))).toBe(false);
  });

  it("ignores checked-in project setup, remembers approved inputs privately, and isolates projects", () => {
    const root = repository();
    const home = fixture();
    const projectState = join(root, ".0", "source-fix");
    mkdirSync(projectState, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(root).digest("hex");
    writeFileSync(join(projectState, `${key}.json`), JSON.stringify({ schema: 1, repoRoot: root, testCommand: "untrusted checked-in command" }), { mode: 0o600 });
    expect(loadSourceFixProjectInputs(root, home)).toBeUndefined();
    saveSourceFixProjectInputs({ repoRoot: root, testCommand: "node security-regression.js" }, home);
    expect(loadSourceFixProjectInputs(root, home)).toEqual({ repoRoot: root, testCommand: "node security-regression.js" });
    expect(loadSourceFixProjectInputs(repository(), home)).toBeUndefined();
    saveSourceFixProjectInputs({ repoRoot: root, testCommand: "node updated-regression.js" }, home);
    expect(loadSourceFixProjectInputs(root, home)?.testCommand).toBe("node updated-regression.js");
  });

  it("uses owner-only storage and refuses preferences made readable by other users", () => {
    const root = repository();
    const home = fixture();
    saveSourceFixProjectInputs({ repoRoot: root, testCommand: "node test.js" }, home);
    const directory = join(home, ".0", "source-fix");
    const record = join(directory, readdirSync(directory)[0]!);
    expect(statSync(directory).mode & 0o077).toBe(0);
    expect(statSync(record).mode & 0o077).toBe(0);
    chmodSync(record, 0o644);
    expect(() => loadSourceFixProjectInputs(root, home)).toThrow(/unsafe evolution artifact/);
  });

  it("cannot follow a source-fix storage symlink into project-controlled configuration", () => {
    const root = repository();
    const home = fixture();
    mkdirSync(join(home, ".0"), { mode: 0o700 });
    symlinkSync(root, join(home, ".0", "source-fix"));
    expect(() => loadSourceFixProjectInputs(root, home)).toThrow(/unsafe evolution directory/);
    expect(() => saveSourceFixProjectInputs({ repoRoot: root, testCommand: "node test.js" }, home)).toThrow(/unsafe evolution directory/);
  });
});
