import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { discoverAgentSkills, loadSkillRegistry, validateAgentSkillContent, type AgentSkillMetadata, type AgentSkillDiscoveryOptions } from "@0/core";
import { z } from "zod";

export class SkillsError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;
const mountSchema = z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096) }).strict();
const bundleSchema = z.object({ format: z.literal("agent-skill"), version: z.literal(1), name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), files: z.array(z.object({ path: z.string().min(1).max(1024), encoding: z.literal("base64"), content: z.string().max(MAX_BYTES * 2) }).strict()).min(1).max(MAX_FILES) }).strict();
export type SkillBundle = z.infer<typeof bundleSchema>;
type SkillFile = { path: string; bytes: Buffer };
type Mount = z.infer<typeof mountSchema>;
export type WebSkill = { id: string; name: string; description: string; scope: "workspace" | "mounted" | "project" | "personal" | "builtin"; revision: string; writable: boolean; fileCount: number; source: string };
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> { const value = schema.safeParse(input); if (!value.success) throw new SkillsError("Invalid skill request."); return value.data; }
function filePath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(path)) throw new SkillsError("Invalid skill file path.");
}
function readFiles(root: string): SkillFile[] {
  const files: SkillFile[] = []; let bytes = 0; let entries = 0;
  function visit(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 1024 || prefix.split("/").length > 16) throw new SkillsError("Skill bundle has too many folders.");
      const name = prefix + entry.name; filePath(name); const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new SkillsError("Skill bundles cannot include symbolic links.");
      if (entry.isDirectory()) visit(path, name + "/");
      else if (entry.isFile()) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size + bytes > MAX_BYTES) throw new SkillsError("Skill bundle exceeds 8 MB."); const data = readFileSync(fd); bytes += data.length; if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new SkillsError("Skill bundle is too large."); files.push({ path: name, bytes: data }); }
        finally { closeSync(fd); }
      } else throw new SkillsError("Only regular files may be shared in skills.");
    }
  }
  visit(root, ""); return files;
}
function revision(files: SkillFile[]): string { const hash = createHash("sha256"); for (const file of files) { hash.update(file.path); hash.update("\0"); hash.update(String(file.bytes.length)); hash.update("\0"); hash.update(file.bytes); } return hash.digest("hex"); }

/** Standard skill folders plus explicit operator mounts; no resource is executed here. */
export class SkillsStore {
  readonly workspacePath: string;
  readonly #state: string;
  readonly #shared: string;
  readonly #team: boolean;
  constructor(options: { workspace: string; stateDir: string; team?: boolean }) {
    this.workspacePath = realpathSync(options.workspace); mkdirSync(options.stateDir, { recursive: true, mode: 0o700 }); this.#state = join(realpathSync(options.stateDir), "skills-library"); this.#shared = join(this.#state, "skills"); this.#team = Boolean(options.team);
  }
  discoveryOptions(): AgentSkillDiscoveryOptions { return { projectRoot: this.workspacePath, homeDir: this.#team ? null : homedir(), mounts: [{ id: "workspace", path: this.#shared }, ...this.mounts()] }; }
  mounts(): Mount[] {
    try {
      const fd = openSync(join(this.#state, "mounts.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 1024 * 1024) throw new SkillsError("Invalid mount registry.", 500); return parse(z.array(mountSchema).max(100), JSON.parse(readFileSync(fd, "utf8"))); }
      finally { closeSync(fd); }
    }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
  }
  #discovery() { return discoverAgentSkills(this.discoveryOptions()); }
  #builtin(id: string): { metadata: WebSkill; files: SkillFile[] } | undefined {
    if (!id.startsWith("builtin/")) return;
    const skill = loadSkillRegistry().get(id.slice(8)); if (!skill) return;
    const name = skill.id; const content = `---\nname: ${name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`;
    const files = [{ path: "SKILL.md", bytes: Buffer.from(content) }];
    return { metadata: { id, name, description: skill.description, scope: "builtin", revision: revision(files), writable: false, fileCount: 1, source: "Built in" }, files };
  }
  #entry(id: string): { metadata: WebSkill; files: SkillFile[]; directory?: string } {
    const built = this.#builtin(id); if (built) return built;
    const skill = this.#discovery().skills.find((row: AgentSkillMetadata) => row.id === id); if (!skill) throw new SkillsError("Skill not found.", 404);
    return this.#describe(skill);
  }
  #describe(skill: AgentSkillMetadata) {
    const id = skill.id;
    const files = readFiles(skill.directory); const shared = skill.root === this.#shared || skill.directory.startsWith(this.#shared + "/");
    return { metadata: { id, name: skill.name, description: skill.description, scope: (shared ? "workspace" : skill.source === "mount" ? "mounted" : skill.source) as WebSkill["scope"], revision: revision(files), writable: shared, fileCount: files.length, source: shared ? "Workspace" : skill.directory }, files, directory: skill.directory };
  }
  list() {
    const found = this.#discovery(); const diagnostics = [...found.diagnostics]; const skills: WebSkill[] = [];
    for (const item of found.skills) { try { skills.push(this.#describe(item).metadata); } catch (cause) { diagnostics.push({ path: item.directory, message: cause instanceof Error ? cause.message : "Skill cannot be read." }); } }
    for (const skill of loadSkillRegistry().values()) skills.push(this.#builtin(`builtin/${skill.id}`)!.metadata);
    return { skills, mounts: this.mounts(), diagnostics, workspacePath: this.workspacePath };
  }
  get(id: string) { const row = this.#entry(id); return { ...row.metadata, content: row.files.find(file => file.path === "SKILL.md")!.bytes.toString("utf8"), files: row.files.map(file => ({ path: file.path, size: file.bytes.length })) }; }
  export(id: string): SkillBundle { const row = this.#entry(id); return { format: "agent-skill", version: 1, name: row.metadata.name, files: row.files.map(file => ({ path: file.path, encoding: "base64", content: file.bytes.toString("base64") })) }; }
  #validate(content: string, name?: string) { try { return validateAgentSkillContent(content, name); } catch (cause) { throw new SkillsError(cause instanceof Error ? cause.message : "Invalid SKILL.md."); } }
  #transaction<T>(apply: () => T): T {
    mkdirSync(this.#state, { recursive: true, mode: 0o700 }); const path = join(this.#state, "write.lock"); let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      let recovery: number;
      try { recovery = openSync(`${path}.recovery`, "wx", 0o600); } catch { throw new SkillsError("Another skill edit is in progress. Retry after it finishes.", 409); }
      try {
        let pid: number;
        try { pid = Number(readFileSync(path, "utf8")); if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(); } catch { throw new SkillsError("Skill storage lock needs operator recovery.", 503); }
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(path); return this.#transaction(apply); } }
        throw new SkillsError("Another skill edit is in progress. Retry after it finishes.", 409);
      } finally { closeSync(recovery); unlinkSync(`${path}.recovery`); }
    }
    try { writeFileSync(fd, String(process.pid)); return apply(); } finally { closeSync(fd); unlinkSync(path); }
  }
  #write(files: SkillFile[], name: string): string { return this.#transaction(() => this.#writeUnlocked(files, name)); }
  #writeUnlocked(files: SkillFile[], name: string): string {
    this.#validate(files.find(file => file.path === "SKILL.md")?.bytes.toString("utf8") ?? "", name);
    mkdirSync(this.#shared, { recursive: true, mode: 0o700 }); const destination = join(this.#shared, name);
    try { lstatSync(destination); throw new SkillsError("A skill with this name already exists.", 409); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    const temporary = join(this.#state, `.import-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 });
    try {
      for (const file of files) { filePath(file.path); const target = join(temporary, file.path); mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 }); writeFileSync(target, file.bytes, { mode: 0o600, flag: "wx" }); }
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    const created = this.#discovery().skills.find(skill => skill.directory === destination); if (!created) throw new SkillsError("Created skill could not be discovered.", 500); return created.id;
  }
  create(input: unknown) {
    const { content } = parse(z.object({ content: z.string().min(1).max(MAX_BYTES) }).strict(), input);
    const { name } = this.#validate(content);
    return this.get(this.#write([{ path: "SKILL.md", bytes: Buffer.from(content) }], name));
  }
  import(input: unknown) {
    const { bundle } = parse(z.object({ bundle: bundleSchema }).strict(), input); let total = 0; const names = new Set<string>();
    const files = bundle.files.map(file => { filePath(file.path); if (names.has(file.path)) throw new SkillsError("Duplicate skill file path."); names.add(file.path); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new SkillsError("Invalid file encoding."); const bytes = Buffer.from(file.content, "base64"); total += bytes.length; if (total > MAX_BYTES) throw new SkillsError("Skill bundle exceeds 8 MB."); return { path: file.path, bytes }; });
    if (!names.has("SKILL.md")) throw new SkillsError("Skill bundle needs SKILL.md."); return this.get(this.#write(files, bundle.name));
  }
  update(id: string, input: unknown) { return this.#transaction(() => this.#update(id, input)); }
  #update(id: string, input: unknown) {
    const { content, expectedRevision } = parse(z.object({ content: z.string().min(1).max(MAX_BYTES), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), input);
    const row = this.#entry(id); if (!row.metadata.writable) throw new SkillsError("Mounted and built-in skills are read only. Import a copy to edit.", 403);
    if (row.metadata.revision !== expectedRevision) throw new SkillsError("This skill changed. Reload it before saving.", 409);
    this.#validate(content, row.metadata.name);
    const target = join(row.directory!, "SKILL.md"); const pending = join(this.#state, `.edit-${randomUUID()}`); try { writeFileSync(pending, content, { flag: "wx", mode: 0o600 }); renameSync(pending, target); } finally { rmSync(pending, { force: true }); } return this.get(id);
  }
  mount(input: unknown) { return this.#transaction(() => this.#mount(input)); }
  #mount(input: unknown) {
    const { path } = parse(z.object({ path: z.string().trim().min(1).max(4096) }).strict(), input); let canonical: string;
    try { canonical = realpathSync(resolve(this.workspacePath, path)); if (!lstatSync(canonical).isDirectory()) throw new Error(); } catch { throw new SkillsError("Choose an existing skills folder."); }
    const mounts = this.mounts(); if (mounts.length >= 100) throw new SkillsError("At most 100 folders can be mounted.", 409); if (mounts.some(item => item.path === canonical)) throw new SkillsError("This folder is already mounted.", 409);
    const mount = { id: randomUUID(), path: canonical }; const found = discoverAgentSkills({ homeDir: null, mounts: [mount] }); if (!found.skills.length) throw new SkillsError("No valid SKILL.md folders found.");
    mounts.push(mount); this.#saveMounts(mounts); return mount;
  }
  unmount(id: string) { return this.#transaction(() => this.#unmount(id)); }
  #unmount(id: string) { const mounts = this.mounts(); if (!mounts.some(item => item.id === id)) throw new SkillsError("Mount not found.", 404); this.#saveMounts(mounts.filter(item => item.id !== id)); }
  #saveMounts(mounts: Mount[]) { mkdirSync(this.#state, { recursive: true, mode: 0o700 }); const temporary = join(this.#state, `.mounts-${randomUUID()}`); try { writeFileSync(temporary, JSON.stringify(mounts), { flag: "wx", mode: 0o600 }); renameSync(temporary, join(this.#state, "mounts.json")); } finally { rmSync(temporary, { force: true }); } }
}
