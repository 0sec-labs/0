import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config.js", () => ({ canonicalEvolutionJson: (value: unknown) => JSON.stringify(value) }));
import { ensureEvolutionDirectory, publishEvolutionArtifact, readEvolutionArtifact } from "./artifacts.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const path = mkdtempSync(join(homedir(), "zero-private-storage-")); roots.push(path); return path; }
function grant(path: string, principal: string): void { execFileSync("icacls.exe", [path, "/grant", `*${principal}:(R)`], { stdio: "pipe", windowsHide: true }); }
describe.skipIf(process.platform !== "win32")("native Windows storage ACLs", () => {
  it("creates executable-plugin storage under the normal user profile without POSIX mode assumptions", () => {
    const path = join(root(), ".0", "executable-plugins");
    expect(ensureEvolutionDirectory(path)).toBe(path);
  });
  it("treats spaces, quotes, brackets and dollar expressions as literal path data", () => {
    const directory = ensureEvolutionDirectory(join(root(), "literal space ' quote $(whoami) [x]"));
    const path = join(directory, "record ' $().json");
    publishEvolutionArtifact(path, { literal: true });
    expect(readEvolutionArtifact(path)).toEqual({ literal: true });
  });
  it("publishes and replays an artifact using real Windows ACLs", () => {
    const path = join(root(), "receipts", "record.json");
    publishEvolutionArtifact(path, { passed: true });
    expect(readEvolutionArtifact(path)).toEqual({ passed: true });
    publishEvolutionArtifact(path, { passed: true });
    expect(() => publishEvolutionArtifact(path, { passed: false })).toThrow("collision");
  });
  it("rejects a directory granting ordinary Users read access", () => {
    const path = ensureEvolutionDirectory(join(root(), "private"));
    grant(path, "S-1-5-32-545");
    expect(() => ensureEvolutionDirectory(path)).toThrow("private Windows ACL");
  });
  it("rejects broad inherit-only grants before publishing child payloads", () => {
    const directory = ensureEvolutionDirectory(join(root(), "private"));
    execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)(IO)(R)"], { stdio: "pipe", windowsHide: true });
    expect(() => publishEvolutionArtifact(join(directory, "never-written.json"), { secret: "fixture" })).toThrow("private Windows ACL");
  });
  it("rejects a broadly readable artifact inside a private directory", () => {
    const path = join(root(), "receipts", "record.json");
    publishEvolutionArtifact(path, { passed: true });
    grant(path, "S-1-1-0");
    expect(() => readEvolutionArtifact(path)).toThrow("private Windows ACL");
  });
  it("rejects junction ancestors even when their target is private", () => {
    const directory = root();
    const target = ensureEvolutionDirectory(join(directory, "target"));
    symlinkSync(target, join(directory, "junction"), "junction");
    expect(() => ensureEvolutionDirectory(join(directory, "junction", "nested"))).toThrow("unsafe evolution directory");
  });
});
