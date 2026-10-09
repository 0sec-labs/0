import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SkillsStore } from "./skills.js";
// Exercise the real skill modules without bootstrapping unrelated research engines.
vi.mock("@0/core", async () => ({
  ...await import("@0/core/dist/agent/skills/agent-skills.js"),
  loadSkillRegistry: (await import("@0/core/dist/agent/skills/index.js")).loadSkillRegistry,
}));
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
    const mount = store.mount({ path: root }); const skill = store.list().skills.find(row => row.scope === "mounted")!; expect(skill.writable).toBe(false); expect(() => store.update(skill.id, { content: content(), expectedRevision: skill.revision })).toThrow("cannot edit");
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
  it("edits mounted skills in place for authorized owners with CAS and intact resources", () => {
    const root = join(directory, "host-skills"); const folder = join(root, "test-review"); mkdirSync(join(folder, "references"), { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), content()); writeFileSync(join(folder, "references", "proof.bin"), Buffer.from([0, 255, 12]));
    store.mount({ path: root }); const original = store.list({ allowHostEdits: true }).skills.find(row => row.scope === "mounted")!;
    expect(original.writable).toBe(true); expect(store.get(original.id).writable).toBe(false);
    const edited = store.update(original.id, { content: content("test-review", "Owner edits source."), expectedRevision: original.revision }, { allowHostEdits: true });
    expect(edited.writable).toBe(true); expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("Owner edits source.");
    expect(readFileSync(join(folder, "references", "proof.bin"))).toEqual(Buffer.from([0, 255, 12]));
    expect(() => store.update(original.id, { content: content(), expectedRevision: original.revision }, { allowHostEdits: true })).toThrow("changed");
  });
  it("saves built-in and mounted edits as portable workspace copies without mutating originals", () => {
    const builtin = store.list().skills.find(row => row.scope === "builtin")!; const before = store.get(builtin.id);
    expect(store.authoring().read(builtin.id.slice(8)).content).toBe(before.content);
    const editedContent = before.content.replace(`name: ${before.name}`, "name: custom-review");
    const copy = store.copy(builtin.id, { content: editedContent, expectedRevision: builtin.revision });
    expect(copy.scope).toBe("workspace"); expect(copy.name).toBe("custom-review"); expect(store.get(builtin.id).content).toBe(before.content);
    expect(() => store.update(builtin.id, { content: editedContent, expectedRevision: builtin.revision }, { allowHostEdits: true })).toThrow("workspace copy");
    expect(() => store.copy(builtin.id, { content: editedContent, expectedRevision: "a".repeat(64) })).toThrow("changed");
    const folder = join(directory, "mounted-copy", "test-review"); mkdirSync(join(folder, "references"), { recursive: true }); writeFileSync(join(folder, "SKILL.md"), content()); writeFileSync(join(folder, "references", "proof.bin"), Buffer.from([0, 255]));
    store.mount({ path: resolve(folder, "..") }); const source = store.list().skills.find(row => row.scope === "mounted")!;
    const portable = store.copy(source.id, { content: content("copied-review"), expectedRevision: source.revision });
    expect(portable.fileCount).toBe(2); expect(store.export(portable.id).files.find(row => row.path === "references/proof.bin")?.content).toBe("AP8=");
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(content());
  });
  it("restricts server authoring capabilities by actor rather than model-supplied permissions", () => {
    const original = store.create({ content: content() }); const viewer = store.authoring({ canWrite: false, allowHostEdits: true });
    expect(viewer.read(original.id).writable).toBe(false); expect(viewer.list().skills.find(row => row.id === original.id)?.writable).toBe(false);
    expect(() => viewer.create(content("new-review"))).toThrow("read-only"); expect(() => viewer.update(original.id, { content: content(), expectedRevision: original.revision })).toThrow("read-only");
    expect(() => viewer.copy(original.id, { content: content("copied-review"), expectedRevision: original.revision })).toThrow("read-only");
    const editor = store.authoring({ canWrite: true, allowHostEdits: false }); expect(editor.update(original.id, { content: content("test-review", "Editor updates shared skill."), expectedRevision: original.revision }).writable).toBe(true);
    const folder = join(directory, "owner-folder", "host-review"); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "SKILL.md"), content("host-review")); store.mount({ path: folder });
    const host = store.list().skills.find(row => row.scope === "mounted")!; expect(() => editor.update(host.id, { content: content("host-review"), expectedRevision: host.revision })).toThrow("cannot edit");
    expect(store.authoring({ allowHostEdits: true }).update(host.id, { content: content("host-review", "Owner updates host skill."), expectedRevision: host.revision }).writable).toBe(true);
  });
  it("uses the actual personal chat project while keeping team discovery fixed", () => {
    const otherProject = join(directory, "other-project"); const skillFolder = join(otherProject, ".agents", "skills", "switched-review"); mkdirSync(skillFolder, { recursive: true }); writeFileSync(join(skillFolder, "SKILL.md"), content("switched-review"));
    const personal = new SkillsStore({ workspace: store.workspacePath, stateDir: join(directory, "personal-state") });
    expect(personal.authoring({ allowHostEdits: true }, otherProject).read("project/switched-review").name).toBe("switched-review");
    const created = personal.authoring({}, otherProject).create(content("shared-review")); expect(personal.get(created.id).scope).toBe("workspace");
    expect(() => store.authoring({ allowHostEdits: true }, otherProject).read("project/switched-review")).toThrow("not found");
  });
  it("rejects edits that would exceed the bundle quota before changing source files", () => {
    const folder = join(directory, "quota-review"); mkdirSync(folder); const original = content("quota-review");
    writeFileSync(join(folder, "SKILL.md"), original); writeFileSync(join(folder, "large.bin"), Buffer.alloc(8 * 1024 * 1024 - Buffer.byteLength(original)));
    store.mount({ path: folder }); const source = store.list().skills.find(row => row.scope === "mounted")!;
    expect(() => store.update(source.id, { content: content("quota-review", "x".repeat(1000)), expectedRevision: source.revision }, { allowHostEdits: true })).toThrow("size limit");
    expect(() => store.copy(source.id, { content: content("quota-copy", "x".repeat(1000)), expectedRevision: source.revision })).toThrow("size limit");
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(original);
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
