import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition } from "./types.js";

export interface AgentSkillDiscoveryOptions {
  projectRoot?: string;
  /** null excludes personal skills (for a shared workspace). */
  homeDir?: string | null;
  mounts?: Array<{ path: string; id?: string }>;
  includeCompatibility?: boolean;
}

export interface AgentSkillMetadata {
  id: string;
  name: string;
  description: string;
  source: "project" | "personal" | "mount";
  directory: string;
  entrypoint: string;
  root: string;
  tags: string[];
  estimated_tokens: number;
}

export interface AgentSkillDiscovery {
  skills: AgentSkillMetadata[];
  diagnostics: Array<{ path: string; message: string }>;
}

const MAX_SKILL_BYTES = 131_072;
const MAX_SKILLS = 512;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Reads only the entry point; scripts and references are never executed or inlined. */
function parseEntry(entrypoint: string) {
  const stat = statSync(entrypoint);
  if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) throw new Error("SKILL.md must be a file of at most 128 KiB.");
  return validateAgentSkillContent(readFileSync(entrypoint, "utf8"));
}

/** Validate standard SKILL.md contents for folder imports and browser editing. */
export function validateAgentSkillContent(content: string, expectedFolderName?: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("SKILL.md must be at most 128 KiB.");
  const raw = content.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter with name and description.");
  const fm = parseYaml(match[1]!) as Record<string, unknown>;
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new Error("Invalid skill frontmatter.");
  if (typeof fm.name !== "string" || fm.name.length > 64 || !NAME.test(fm.name)) throw new Error("Skill name must be lowercase letters, numbers and single hyphens (1–64 characters).");
  if (expectedFolderName && fm.name !== expectedFolderName) throw new Error("Skill name must match its directory name.");
  if (typeof fm.description !== "string" || !fm.description.trim() || fm.description.length > 1024) throw new Error("Skill description must contain 1–1024 characters.");
  const body = match[2]!.trim();
  if (!body) throw new Error("SKILL.md requires instructions after the frontmatter.");
  return {
    name: fm.name,
    description: fm.description.trim(),
    body,
    tags: Array.isArray(fm.tags) ? fm.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

/**
 * Discover standard Agent Skills folders. The standard .agents location takes
 * precedence over .claude compatibility folders within each scope. Sources
 * remain namespaced, so a project skill cannot replace built-in/cloud skills.
 * Supplying homeDir:null and explicit mounts isolates team workspace discovery.
 */
export function discoverAgentSkills(options: AgentSkillDiscoveryOptions = {}): AgentSkillDiscovery {
  const result: AgentSkillDiscovery = { skills: [], diagnostics: [] };
  const roots: Array<{ path: string; source: AgentSkillMetadata["source"]; namespace: string }> = [];
  const addScope = (base: string, source: "project" | "personal") => {
    roots.push({ path: join(base, ".agents", "skills"), source, namespace: source });
    if (options.includeCompatibility !== false) roots.push({ path: join(base, ".claude", "skills"), source, namespace: source });
  };
  if (options.projectRoot) addScope(resolve(options.projectRoot), "project");
  if (options.homeDir !== null) addScope(resolve(options.homeDir ?? homedir()), "personal");
  for (const mount of options.mounts ?? []) {
    const mountPath = resolve(mount.path);
    const id = mount.id ?? createHash("sha256").update(mountPath).digest("hex").slice(0, 12);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      result.diagnostics.push({ path: mountPath, message: "Invalid skill mount ID." });
      continue;
    }
    roots.push({ path: mountPath, source: "mount", namespace: `mount/${id}` });
  }
  const seen = new Set<string>();
  const scopedNames = new Set<string>();
  for (const spec of roots) {
    if (!existsSync(spec.path)) continue;
    try {
      const root = realpathSync(spec.path);
      const directories = existsSync(join(root, "SKILL.md")) ? [root] :
        readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => join(root, entry.name));
      for (const candidate of directories) {
        try {
          const directory = realpathSync(candidate);
          if (!contained(root, directory)) throw new Error("Skill directory points outside its mounted root.");
          const entry = join(directory, "SKILL.md");
          if (!existsSync(entry)) continue;
          const entrypoint = realpathSync(entry);
          if (!contained(directory, entrypoint)) throw new Error("SKILL.md points outside its skill directory.");
          const parsed = parseEntry(entrypoint);
          if (parsed.name !== basename(directory)) result.diagnostics.push({ path: entrypoint, message: "Skill name differs from its directory name." });
          const id = `${spec.namespace}/${parsed.name}`;
          if (seen.has(id)) {
            result.diagnostics.push({ path: entrypoint, message: `Duplicate skill ${id}; using the first location.` });
            continue;
          }
          if (spec.source === "personal" && scopedNames.has(parsed.name)) {
            result.diagnostics.push({ path: entrypoint, message: `Project skill ${parsed.name} takes precedence over the personal skill.` });
            continue;
          }
          if (result.skills.length >= MAX_SKILLS) throw new Error("Skill discovery limit reached (512).");
          seen.add(id);
          if (spec.source === "project" || spec.source === "personal") scopedNames.add(parsed.name);
          result.skills.push({ id, name: parsed.name, description: parsed.description, source: spec.source,
            directory, entrypoint, root, tags: parsed.tags, estimated_tokens: Math.max(1, Math.ceil(parsed.body.length / 4)) });
        } catch (error) {
          result.diagnostics.push({ path: candidate, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      result.diagnostics.push({ path: spec.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Re-read and validate on demand, so folder edits are available without restart. */
export function loadAgentSkill(skill: AgentSkillMetadata): SkillDefinition {
  const root = realpathSync(skill.root);
  const directory = realpathSync(skill.directory);
  const entrypoint = realpathSync(skill.entrypoint);
  if (root !== skill.root || directory !== skill.directory || entrypoint !== skill.entrypoint ||
      !contained(root, directory) || !contained(directory, entrypoint)) throw new Error("Skill location changed; rediscover skills before loading.");
  const parsed = parseEntry(entrypoint);
  if (parsed.name !== skill.name) throw new Error("Skill name changed; rediscover skills before loading.");
  return {
    id: skill.id, name: parsed.name, description: parsed.description, version: 1,
    applicable_roles: ["attack", "audit", "review"], tags: parsed.tags, triggers: [],
    estimated_tokens: Math.max(1, Math.ceil(parsed.body.length / 4)),
    content: `Skill directory: ${directory}\nResolve relative resource paths against this directory. Read referenced resources only when needed. Scripts are resources; loading this skill does not execute them.\n\n${parsed.body}`,
  };
}
