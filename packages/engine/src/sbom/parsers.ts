/**
 * Lockfile parsers. Each takes the text of one lockfile and returns the packages it pins. They read text only:
 * nothing is executed, installed or fetched, and a file that does not parse gives no packages rather than a guess.
 */
import { parse as parseYaml } from "yaml";

export interface Component {
  ecosystem: "npm" | "cargo" | "golang" | "pypi";
  name: string;
  version: string;
  /** Marked as a development-only dependency by the lockfile, so not part of what ships. */
  dev?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function parseNpmLock(source: string): Component[] {
  let lock: unknown;
  try { lock = JSON.parse(source); } catch { return []; }
  if (!isObject(lock)) return [];
  const found: Component[] = [];
  if (isObject(lock.packages)) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || !isObject(entry) || entry.link === true) continue;
      const name = text(entry.name) || path.split("node_modules/").pop() || "";
      const version = text(entry.version);
      if (name && version) found.push({ ecosystem: "npm", name, version, ...(entry.dev === true ? { dev: true } : {}) });
    }
    return found;
  }
  const walk = (dependencies: unknown): void => {
    if (!isObject(dependencies)) return;
    for (const [name, entry] of Object.entries(dependencies)) {
      if (!isObject(entry)) continue;
      const version = text(entry.version);
      if (version && !/^(file:|link:|git|https?:)/.test(version)) found.push({ ecosystem: "npm", name, version, ...(entry.dev === true ? { dev: true } : {}) });
      walk(entry.dependencies);
    }
  };
  walk(lock.dependencies);
  return found;
}

/** `name@1.2.3`, `@scope/name@1.2.3(peer@2)`, `/name@1.2.3`, or the older `/name/1.2.3`. */
function pnpmKey(raw: string): { name: string; version: string } | undefined {
  let key = raw.replace(/^\//, "").replace(/\(.*$/, "").replace(/_.*$/, (match) => (match.includes("@") ? "" : match));
  const at = key.lastIndexOf("@");
  if (at > 0) return { name: key.slice(0, at), version: key.slice(at + 1) };
  const slash = key.lastIndexOf("/");
  if (slash > 0) return { name: key.slice(0, slash), version: key.slice(slash + 1) };
  return undefined;
}
export function parsePnpmLock(source: string): Component[] {
  let lock: unknown;
  try { lock = parseYaml(source, { schema: "core" }); } catch { return []; }
  if (!isObject(lock) || !isObject(lock.packages)) return [];
  const found: Component[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const parsed = pnpmKey(key);
    if (parsed && /^\d/.test(parsed.version)) found.push({ ecosystem: "npm", name: parsed.name, version: parsed.version, ...(isObject(entry) && entry.dev === true ? { dev: true } : {}) });
  }
  return found;
}

export function parseYarnLock(source: string): Component[] {
  const found: Component[] = [];
  let names: string[] = [];
  for (const line of source.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(line) && line.endsWith(":")) {
      names = line.slice(0, -1).split(",").map(spec => spec.trim().replace(/^"|"$/g, "")).map(spec => { const at = spec.lastIndexOf("@"); return at > 0 ? spec.slice(0, at) : ""; }).filter(Boolean);
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (version && names.length) { found.push({ ecosystem: "npm", name: names[0]!, version: version[1]! }); names = []; }
  }
  return found;
}

/** `[[package]]` tables with `name = "..."` and `version = "..."`, as in Cargo.lock and poetry.lock. */
function parsePackageTables(source: string, wanted: (table: Record<string, string>) => boolean): Array<Record<string, string>> {
  const tables: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const line of source.split("\n")) {
    if (line.trim() === "[[package]]") { current = {}; tables.push(current); continue; }
    if (line.startsWith("[")) { current = undefined; continue; }
    const pair = /^(\w+)\s*=\s*"([^"]*)"/.exec(line);
    if (pair && current) current[pair[1]!] = pair[2]!;
  }
  return tables.filter(table => table.name && table.version && wanted(table));
}
// A package with no source is the workspace's own crate, not a dependency.
export const parseCargoLock = (source: string): Component[] => parsePackageTables(source, table => !!table.source).map(table => ({ ecosystem: "cargo" as const, name: table.name!, version: table.version! }));
export const parsePoetryLock = (source: string): Component[] => parsePackageTables(source, () => true).map(table => ({ ecosystem: "pypi" as const, name: table.name!, version: table.version! }));

export function parseGoMod(source: string): Component[] {
  const found: Component[] = [];
  let block = false;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "require (") { block = true; continue; }
    if (block && line === ")") { block = false; continue; }
    const match = block ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
    if (match) found.push({ ecosystem: "golang", name: match[1]!, version: match[2]! });
  }
  return found;
}

export function parsePipfileLock(source: string): Component[] {
  let lock: unknown;
  try { lock = JSON.parse(source); } catch { return []; }
  if (!isObject(lock)) return [];
  const found: Component[] = [];
  for (const [section, dev] of [["default", false], ["develop", true]] as const) {
    const packages = lock[section];
    if (!isObject(packages)) continue;
    for (const [name, entry] of Object.entries(packages)) {
      const version = isObject(entry) ? text(entry.version).replace(/^==/, "") : "";
      if (version) found.push({ ecosystem: "pypi", name, version, ...(dev ? { dev: true } : {}) });
    }
  }
  return found;
}

export function parseRequirements(source: string): Component[] {
  const found: Component[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s*\\$/, "").split(";")[0]!.trim();
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9][A-Za-z0-9._+!-]*)$/.exec(line);
    if (match) found.push({ ecosystem: "pypi", name: match[1]!, version: match[2]! });
  }
  return found;
}

/** Lockfile name to parser, with the ecosystem label shown to the user. */
export const LOCKFILES: ReadonlyArray<{ file: string; label: string; parse: (source: string) => Component[] }> = [
  { file: "package-lock.json", label: "npm", parse: parseNpmLock },
  { file: "npm-shrinkwrap.json", label: "npm", parse: parseNpmLock },
  { file: "pnpm-lock.yaml", label: "pnpm", parse: parsePnpmLock },
  { file: "yarn.lock", label: "yarn", parse: parseYarnLock },
  { file: "Cargo.lock", label: "Cargo", parse: parseCargoLock },
  { file: "go.mod", label: "Go", parse: parseGoMod },
  { file: "poetry.lock", label: "Poetry", parse: parsePoetryLock },
  { file: "Pipfile.lock", label: "Pipenv", parse: parsePipfileLock },
  { file: "requirements.txt", label: "pip (pinned)", parse: parseRequirements },
];
