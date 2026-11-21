import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LOCKFILES, type Component } from "./parsers.js";

const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 6;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage"]);

export interface Bom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: 1;
  metadata: { timestamp: string; tools: { components: Array<{ type: "application"; author: string; name: string; version: string }> }; component: { type: "application"; name: string } };
  components: Array<{ type: "library"; "bom-ref": string; name: string; version: string; purl: string; scope?: "excluded" }>;
}
export interface SbomResult { bom: Bom; lockfiles: Array<{ path: string; label: string; components: number }>; truncated: boolean }

/** The package URL for a component: how every SBOM consumer and advisory database names it. */
export function packageUrl(component: Component): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%2F/gi, "/").replace(/%40/g, "%40");
  switch (component.ecosystem) {
    case "npm": {
      const name = component.name.toLowerCase();
      const scoped = name.startsWith("@") ? `%40${encode(name.slice(1))}` : encode(name);
      return `pkg:npm/${scoped}@${encode(component.version)}`;
    }
    case "pypi": return `pkg:pypi/${encode(component.name.toLowerCase().replace(/[._]+/g, "-"))}@${encode(component.version)}`;
    case "cargo": return `pkg:cargo/${encode(component.name)}@${encode(component.version)}`;
    case "golang": return `pkg:golang/${component.name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(component.version)}`;
  }
}

function findLockfiles(folder: string): Array<{ path: string; label: string; parse: (source: string) => Component[] }> {
  const found: Array<{ path: string; label: string; parse: (source: string) => Component[] }> = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name);
      let info; try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) { if (depth < MAX_DEPTH && !SKIP.has(name) && !name.startsWith(".")) walk(path, depth + 1); continue; }
      const lock = LOCKFILES.find(candidate => candidate.file === name);
      if (lock && info.size <= MAX_LOCKFILE_BYTES) found.push({ path, label: lock.label, parse: lock.parse });
    }
  };
  walk(folder, 0);
  return found;
}

/** Build a CycloneDX 1.5 SBOM from the lockfiles under a folder. Sorted and de-duplicated, so the same lockfiles give the same SBOM. */
export function generateSbom(folder: string, options: { name?: string; toolVersion: string; now?: Date }): SbomResult {
  const locks = findLockfiles(folder);
  // A pinned requirements.txt next to a lock that already covers the same ecosystem adds noise, not facts.
  const byPurl = new Map<string, { component: Component; purl: string }>();
  const summary: SbomResult["lockfiles"] = [];
  for (const lock of locks) {
    let source: string;
    try { source = readFileSync(lock.path, "utf8"); } catch { continue; }
    const components = lock.parse(source);
    summary.push({ path: relative(folder, lock.path) || lock.path, label: lock.label, components: components.length });
    for (const component of components) {
      const purl = packageUrl(component);
      const existing = byPurl.get(purl);
      // A component is development-only only if every lockfile that lists it says so.
      if (!existing) byPurl.set(purl, { component: { ...component }, purl });
      else if (existing.component.dev && !component.dev) delete existing.component.dev;
    }
  }
  const sorted = [...byPurl.values()].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  const digest = createHash("sha256").update(sorted.map(item => item.purl).join("\n")).digest("hex");
  const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const bom: Bom = {
    bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: serial, version: 1,
    metadata: {
      timestamp: (options.now ?? new Date()).toISOString(),
      tools: { components: [{ type: "application", author: "0sec-labs", name: "0", version: options.toolVersion }] },
      component: { type: "application", name: options.name ?? (folder.split(/[\\/]/).filter(Boolean).pop() ?? "application") },
    },
    components: sorted.map(({ component, purl }) => ({ type: "library" as const, "bom-ref": purl, name: component.name, version: component.version, purl, ...(component.dev ? { scope: "excluded" as const } : {}) })),
  };
  return { bom, lockfiles: summary.sort((a, b) => (a.path < b.path ? -1 : 1)), truncated: false };
}
