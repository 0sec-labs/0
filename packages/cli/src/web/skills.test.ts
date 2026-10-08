import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillsStore } from "./skills.js";
let directory: string;
let store: SkillsStore;
const content = (name = "test-review", body = "Review evidence carefully.") => `---\nname: ${name}\ndescription: Review test evidence.\n---\n\n${body}\n`;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "zero-skills-")); mkdirSync(join(directory, "project")); store = new SkillsStore({ workspace: join(directory, "project"), stateDir: join(directory, "state"), team: true }); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe("shared skill library", () => {
  it("discovers created standard folders and passes shared roots to runtime", () => {
    const skill = store.create({ content: content() }); expect(skill.scope).toBe("workspace"); expect(skill.writable).toBe(true); expect(store.get(skill.id).content).toBe(content());
    expect(store.discoveryOptions().homeDir).toBeNull(); expect(store.discoveryOptions().mounts?.[0]?.id).toBe("workspace"); expect(store.list().skills.some(row => row.id === skill.id)).toBe(true);
  });
  it("rejects stale revisions while preserving resources on updates", () => {
    const bundle = { format: "agent-skill", version: 1, name: "test-review", files: [{ path: "SKILL.md", encoding: "base64", content: Buffer.from(content()).toString("base64") }, { path: "references/evidence.bin", encoding: "base64", content: Buffer.from([0, 255, 12]).toString("base64") }] };
    const original = store.import({ bundle }); const edited = store.update(original.id, { content: content("test-review", "New methodology."), expectedRevision: original.revision });
    expect(edited.revision).not.toBe(original.revision); expect(() => store.update(original.id, { content: content(), expectedRevision: original.revision })).toThrow("changed");
    expect(store.export(original.id).files.find(file => file.path.endsWith(".bin"))?.content).toBe("AP8M");
  });
  it("roundtrips supplementary binary and text files without execution", () => {
    const bundle = { format: "agent-skill", version: 1, name: "test-review", files: [{ path: "SKILL.md", encoding: "base64", content: Buffer.from(content()).toString("base64") }, { path: "scripts/proof.sh", encoding: "base64", content: Buffer.from("exit 99").toString("base64") }] };
    const imported = store.import({ bundle }); expect(store.export(imported.id)).toEqual({ ...bundle, files: expect.arrayContaining(bundle.files) }); expect(imported.files).toHaveLength(2);
  });
  it("mounts existing folders read only and detaches without deleting files", () => {
    const root = join(directory, "mounted"); mkdirSync(join(root, "test-review"), { recursive: true }); writeFileSync(join(root, "test-review", "SKILL.md"), content());
    const mount = store.mount({ path: root }); const skill = store.list().skills.find(row => row.scope === "mounted")!; expect(skill.writable).toBe(false); expect(() => store.update(skill.id, { content: content(), expectedRevision: skill.revision })).toThrow("read only");
    store.unmount(mount.id); expect(() => store.get(skill.id)).toThrow("not found"); expect(readFileSync(join(root, "test-review", "SKILL.md"), "utf8")).toBe(content());
  });
  it("rejects path traversal, duplicate files, invalid metadata and existing names", () => {
    const valid = { format: "agent-skill", version: 1, name: "test-review", files: [{ path: "SKILL.md", encoding: "base64", content: Buffer.from(content()).toString("base64") }] };
    expect(() => store.import({ bundle: { ...valid, files: [...valid.files, { path: "../escape", encoding: "base64", content: "" }] } })).toThrow("path");
    expect(() => store.import({ bundle: { ...valid, files: [...valid.files, ...valid.files] } })).toThrow("Duplicate");
    expect(() => store.create({ content: "---\nname: test-review\n---\nbody" })).toThrow("description"); store.create({ content: content() }); expect(() => store.create({ content: content() })).toThrow("already exists");
    expect(() => store.import({ bundle: { ...valid, name: "other-name" } })).toThrow("directory name");
  });
  it("never exports symlinked supplementary files outside a skill", () => {
    const root = join(directory, "mounted"); mkdirSync(join(root, "test-review"), { recursive: true }); writeFileSync(join(root, "test-review", "SKILL.md"), content()); store.mount({ path: root });
    symlinkSync(join(directory, "state"), join(root, "test-review", "private")); const inventory = store.list(); expect(inventory.skills.some(row => row.scope === "mounted")).toBe(false); expect(inventory.diagnostics.some(row => row.message.includes("symbolic"))).toBe(true);
  });
  it("shares built-in methodologies as portable standard skill copies", () => {
    const builtin = store.list().skills.find(row => row.scope === "builtin")!; expect(builtin.writable).toBe(false); const copy = store.import({ bundle: store.export(builtin.id) }); expect(copy.scope).toBe("workspace"); expect(copy.description).toBe(builtin.description);
  });
  it("recovers a dead writer lock while refusing to overwrite a live writer", () => {
    const state = join(directory, "state", "skills-library"); mkdirSync(state, { recursive: true });
    const lock = join(state, "write.lock"); writeFileSync(lock, String(process.pid));
    expect(() => store.create({ content: content() })).toThrow("in progress");
    writeFileSync(lock, "42424242"); const kill = vi.spyOn(process, "kill").mockImplementation(() => { const error = new Error("dead process") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; });
    try { expect(store.create({ content: content() }).scope).toBe("workspace"); } finally { kill.mockRestore(); }
  });
  it("isolates skills and mounts in separate team state directories", () => {
    store.create({ content: content() }); const other = new SkillsStore({ workspace: store.workspacePath, stateDir: join(directory, "other-team"), team: true }); expect(other.list().skills.filter(row => row.scope !== "builtin")).toEqual([]); expect(other.mounts()).toEqual([]);
  });
});
