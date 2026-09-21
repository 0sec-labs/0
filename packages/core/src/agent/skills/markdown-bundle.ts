/**
 * Audit-skills Markdown bundle loader (#audit-skills).
 *
 * Reads the staged bundle manifest JSON (pointed to by
 * ZERO_AUDIT_SKILLS_MANIFEST), validates it strictly, verifies
 * sha256 integrity, and produces a Map<string, SkillDefinition>
 * keyed as "cloud/<skillId>" — making cloud skills impossible to
 * collide with or replace builtin IDs.
 *
 * Every SKILL.md file carries YAML frontmatter that maps to the
 * SkillDefinition fields. Additional .md files in a skill's file
 * list become supplementary reference sections appended under
 * "## Reference: <path>" headings.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition } from "./types.js";

// ── Contract types (mirrored from 0cloud contracts w/ limits) ──

interface BundleManifest {
  schema: string;
  skills: AuditSkillSnapshot[];
}

interface AuditSkillSnapshot {
  skillId: string;
  revisionId: string;
  revision: number;
  name: string;
  description: string;
  sha256: string;
  entrypoint: string;
  files: AuditSkillFile[];
}

interface AuditSkillFile {
  path: string;
  content: string;
}

// ── Validation constants ──

const SCHEMA_TAG = "0sec-audit-skills-v1";
const MAX_SKILLS = 8;
const MAX_FILES_PER_SKILL = 64;
const MAX_BYTES_PER_FILE = 131_072; // 128 KiB
const MAX_BYTES_PER_SKILL = 524_288; // 512 KiB
const POSIX_RELATIVE = /^(?!\/)(?!\.\.\/)(?!\.$)(?!.*\/\.\.(?:\/|$))[a-zA-Z0-9_.\-/]+$/;
const ENTRYPOINT = "SKILL.md";

// ── Frontmatter defaults ──

const DEFAULT_VERSION = 1;
const DEFAULT_TAGS: string[] = [];
const DEFAULT_TRIGGERS: string[] = [];

/** Rough token estimate: ~4 chars per token for English Markdown. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ── Parsing ──

interface SkillFrontmatter {
  name: string;
  description: string;
  version?: number;
  tags?: string[];
  triggers?: string[];
  estimated_tokens?: number;
}

/** Parse YAML frontmatter from a Markdown file's leading `---` block. */
function parseFrontmatter(
  raw: string,
  snapshot: AuditSkillSnapshot,
): { frontmatter: SkillFrontmatter; body: string } {
  const { skillId } = snapshot;
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return {
      frontmatter: { name: snapshot.name, description: snapshot.description, version: DEFAULT_VERSION, tags: DEFAULT_TAGS, triggers: DEFAULT_TRIGGERS },
      body: raw,
    };
  }

  const end = trimmed.indexOf("---", 3);
  if (end === -1) {
    throw new Error(
      `Skill ${skillId}: SKILL.md frontmatter missing closing ---`,
    );
  }

  const yamlBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trimStart();

  if (!yamlBlock) {
    throw new Error(
      `Skill ${skillId}: SKILL.md frontmatter is empty`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(yamlBlock) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Skill ${skillId}: SKILL.md frontmatter parse error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Skill ${skillId}: SKILL.md frontmatter did not produce a map`,
    );
  }

  const name = parsed.name === undefined ? snapshot.name
    : typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
  if (!name) {
    throw new Error(`Skill ${skillId}: SKILL.md frontmatter "name" is required`);
  }

  const description = parsed.description === undefined ? snapshot.description
    : typeof parsed.description === "string" ? parsed.description.trim() : undefined;
  if (description === undefined) {
    throw new Error(
      `Skill ${skillId}: SKILL.md frontmatter "description" must be a string`,
    );
  }

  const version =
    typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version > 0
      ? parsed.version
      : DEFAULT_VERSION;

  const tags: string[] =
    Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string")
      : DEFAULT_TAGS;

  const triggers: string[] =
    Array.isArray(parsed.triggers)
      ? parsed.triggers.filter((t): t is string => typeof t === "string")
      : DEFAULT_TRIGGERS;

  // Validate regex triggers
  for (const pattern of triggers) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(
        `Skill ${skillId}: invalid trigger regex "${pattern}"`,
      );
    }
  }

  const estimated_tokens =
    typeof parsed.estimated_tokens === "number" && parsed.estimated_tokens > 0
      ? parsed.estimated_tokens
      : undefined;

  return {
    frontmatter: { name, description, version, tags, triggers, estimated_tokens },
    body,
  };
}

/** Build the full content string for a SkillDefinition from a snapshot's files. */
function buildSkillContent(
  snapshot: AuditSkillSnapshot,
  body: string,
): string {
  const parts: string[] = [body.trim()];

  // Sort files alphabetically so supplementary references are deterministic
  const sorted = [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    if (file.path === ENTRYPOINT) continue;
    parts.push(`\n\n## Reference: ${file.path}\n\n${file.content}`);
  }

  return parts.join("").trim();
}

/** Convert the parsed snapshot + frontmatter to a SkillDefinition. */
function buildSkillDefinition(
  snapshot: AuditSkillSnapshot,
  fm: SkillFrontmatter,
  body: string,
): SkillDefinition {
  const content = buildSkillContent(snapshot, body);
  const tokens = fm.estimated_tokens ?? estimateTokens(content);

  return {
    id: `cloud/${snapshot.skillId}`,
    name: fm.name,
    description: fm.description,
    version: fm.version ?? DEFAULT_VERSION,
    applicable_roles: ["audit"],
    tags: fm.tags ?? DEFAULT_TAGS,
    triggers: fm.triggers ?? DEFAULT_TRIGGERS,
    estimated_tokens: tokens,
    content,
  };
}

// ── Integrity verification ──

/**
 * Compute the canonical sha256 of a skill file list per contract:
 * JSON.stringify of files sorted by path, each object constructed
 * as {path, content} with no other fields.
 */
function computeSha256(files: AuditSkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = sorted.map((f) => ({ path: f.path, content: f.content }));
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized, "utf-8").digest("hex");
}

// ── Single-skill validation ──

function validateSkillSnapshot(snapshot: AuditSkillSnapshot): void {
  const { skillId, sha256, entrypoint, files, name, description } = snapshot;

  // Basic field presence
  if (!skillId || typeof skillId !== "string") {
    throw new Error("Bundle validation: each skill must have a non-empty 'skillId'");
  }
  if (!name || typeof name !== "string") {
    throw new Error(`Skill ${skillId}: non-empty 'name' required`);
  }
  if (typeof description !== "string") {
    throw new Error(`Skill ${skillId}: 'description' must be a string`);
  }

  // Entrypoint
  if (entrypoint !== ENTRYPOINT) {
    throw new Error(
      `Skill ${skillId}: entrypoint must be "${ENTRYPOINT}" (got "${entrypoint}")`,
    );
  }

  // File count
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Skill ${skillId}: at least one file required (${ENTRYPOINT})`);
  }
  if (files.length > MAX_FILES_PER_SKILL) {
    throw new Error(
      `Skill ${skillId}: too many files (${files.length}, max ${MAX_FILES_PER_SKILL})`,
    );
  }

  let totalBytes = 0;

  for (const file of files) {
    // Path validation
    if (!file.path || typeof file.path !== "string") {
      throw new Error(`Skill ${skillId}: file "path" must be a non-empty string`);
    }
    if (!POSIX_RELATIVE.test(file.path)) {
      throw new Error(
        `Skill ${skillId}: invalid file path "${file.path}" — must be a POSIX relative path`,
      );
    }

    // Content validation
    if (typeof file.content !== "string") {
      throw new Error(`Skill ${skillId}: file "${file.path}" content must be a string`);
    }

    const byteLen = Buffer.byteLength(file.content, "utf-8");
    if (byteLen > MAX_BYTES_PER_FILE) {
      throw new Error(
        `Skill ${skillId}: file "${file.path}" exceeds ${MAX_BYTES_PER_FILE} bytes (${byteLen})`,
      );
    }

    totalBytes += byteLen;
  }

  if (totalBytes > MAX_BYTES_PER_SKILL) {
    throw new Error(
      `Skill ${skillId}: total size ${totalBytes} exceeds ${MAX_BYTES_PER_SKILL} bytes`,
    );
  }

  // Ensure SKILL.md is present
  const hasEntrypoint = files.some((f) => f.path === ENTRYPOINT);
  if (!hasEntrypoint) {
    throw new Error(
      `Skill ${skillId}: file list must include ${ENTRYPOINT}`,
    );
  }

  // SHA-256 verification
  if (!sha256 || typeof sha256 !== "string" || sha256.length === 0) {
    throw new Error(`Skill ${skillId}: non-empty 'sha256' required`);
  }
  const computed = computeSha256(files);
  if (computed !== sha256) {
    throw new Error(
      `Skill ${skillId}: sha256 mismatch (expected ${sha256}, computed ${computed})`,
    );
  }
}

// ── Public entry point ──

/**
 * Load an audit-skills bundle from a staged manifest JSON file.
 *
 * Reads, validates schema tag and limits, verifies sha256 integrity
 * for every skill, parses SKILL.md frontmatter, and returns a Map
 * keyed by namespaced id ("cloud/<skillId>").
 *
 * Throws on ANY invalid input — the loader MUST fail closed.
 */
export function loadSkillBundleFromManifest(
  manifestPath: string,
): Map<string, SkillDefinition> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (e) {
    throw new Error(
      `Failed to read manifest at "${manifestPath}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(raw) as BundleManifest;
  } catch (e) {
    throw new Error(
      `Invalid manifest JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Schema tag
  if (manifest.schema !== SCHEMA_TAG) {
    throw new Error(
      `Unsupported manifest schema "${manifest.schema}" (expected "${SCHEMA_TAG}")`,
    );
  }

  // Skills array
  if (!Array.isArray(manifest.skills)) {
    throw new Error('Manifest must contain a "skills" array');
  }

  if (manifest.skills.length === 0) {
    // Empty is valid — no cloud skills to load
    return new Map();
  }

  if (manifest.skills.length > MAX_SKILLS) {
    throw new Error(
      `Too many skills in manifest (${manifest.skills.length}, max ${MAX_SKILLS})`,
    );
  }

  // Validate each snapshot, parse frontmatter, build SkillDefinition
  const result = new Map<string, SkillDefinition>();

  for (const snapshot of manifest.skills) {
    validateSkillSnapshot(snapshot);

    // Find the SKILL.md entry and parse its frontmatter
    const skillMd = snapshot.files.find((f) => f.path === ENTRYPOINT)!;
    const { frontmatter, body } = parseFrontmatter(skillMd.content, snapshot);

    const def = buildSkillDefinition(snapshot, frontmatter, body);
    result.set(def.id, def);
  }

  return result;
}