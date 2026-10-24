/** Bounded controller observations, evaluated only at explicit evolution boundaries. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { canonicalEvolutionJson } from "./config.js";
import type { EvolutionModelIdentity } from "./types.js";

export interface EvolutionModelRevision {
  status: "pinned" | "floating" | "unavailable";
  revision: string | null;
  decodingDigest: string | null;
}
const sha256 = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
/** A requested model name cannot become a pinned revision by inference. */
export function observedEvolutionModelRevision(identity?: EvolutionModelIdentity): EvolutionModelRevision {
  const status = identity?.modelVersionStatus ?? "unavailable";
  const revision = typeof identity?.modelRevision === "string" && identity.modelRevision.length > 0 && identity.modelRevision.length <= 256
    ? identity.modelRevision : null;
  const decodingDigest = digestPattern.test(identity?.decodingDigest ?? "") ? identity!.decodingDigest! : null;
  return { status: status === "pinned" && (!revision || !decodingDigest) ? "unavailable" : status, revision, decodingDigest };
}

const cache = new Map<string, { stamp: string; digest: string }>();
/** Hash actual bounded controller module bytes, not a function name or objective.
 * Changed size/mtime/ctime/inode invalidates the loaded controller observation
 * and requires restart; disk bytes must not impersonate already-loaded code. */
export function evolutionToolImplementationDigest(moduleUrl: URL = new URL(import.meta.url)): string {
  const modules = ["sandbox", "controller-lock", "config", "registry", "evaluation", "safety", "curation-lineage", "retention", "provenance", "rewrite", "loop"];
  const directory = new URL("./", moduleUrl);
  const sourceFiles = modules.map(name => {
    const compiled = new URL(`./${name}.js`, directory);
    return existsSync(compiled) ? compiled : new URL(`./${name}.ts`, directory);
  });
  let files: Array<{ name: string; file: URL }>;
  let maximumFileBytes = 2n * 1024n * 1024n;
  if (sourceFiles.every(file => existsSync(file))) files = modules.map((name, index) => ({ name, file: sourceFiles[index]! }));
  else {
    // esbuild distributes this module among flat code chunks. Attest the bounded
    // packaged code directory plus the entry loader, rather than guessing a
    // missing source sidecar. No package/workspace walk or remote metadata lookup.
    if (!moduleUrl.pathname.endsWith(".js") || !existsSync(moduleUrl)) throw new Error("evolution loaded implementation bytes unavailable");
    files = readdirSync(directory).filter(name => name.endsWith(".js")).sort().map(name => ({ name, file: new URL(name, directory) }));
    const entry = new URL("../0.js", directory);
    if (existsSync(entry)) files.push({ name: "entry:0.js", file: entry });
    if (!files.length || files.length > 512) throw new Error("evolution packaged implementation file bound exceeded");
    maximumFileBytes = 32n * 1024n * 1024n;
  }
  let totalBytes = 0n;
  const identities = files.map(({ name, file }) => {
    const stat = statSync(file, { bigint: true });
    totalBytes += stat.size;
    if (!stat.isFile() || stat.size > maximumFileBytes || totalBytes > 64n * 1024n * 1024n) throw new Error("invalid bounded evolution implementation module");
    const stamp = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const key = file.href;
    let entry = cache.get(key);
    if (entry && entry.stamp !== stamp) throw new Error("evolution controller implementation changed after observation; restart before evaluation");
    if (!entry) { entry = { stamp, digest: sha256(readFileSync(file)) }; cache.set(key, entry); }
    return [{ name, digest: entry.digest }];
  });
  return sha256(canonicalEvolutionJson(identities));
}

/** Explicit fixture-content change audit; names and case-level expected outputs stay private. */
export function auditEvolutionCorpusRotation(previous: readonly string[], current: readonly string[]) {
  const before = new Set(previous), after = new Set(current);
  if (before.size !== previous.length || after.size !== current.length || [...before, ...after].some(v => !digestPattern.test(v))) {
    throw new Error("corpus audit requires unique immutable content digests");
  }
  return { retained: [...after].filter(v => before.has(v)).sort(), added: [...after].filter(v => !before.has(v)).sort(), retired: [...before].filter(v => !after.has(v)).sort(),
    policy: "operator-curated-rotation-required" as const };
}
