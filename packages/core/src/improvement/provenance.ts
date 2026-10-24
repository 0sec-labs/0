/** Bounded controller observations, evaluated only at explicit evolution boundaries. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
 * Cache invalidates on size/mtime/ctime/inode changes; no workspace walk or lookup. */
export function evolutionToolImplementationDigest(): string {
  const modules = ["sandbox", "sandbox-process", "controller-lock"];
  const identities = modules.flatMap(name => {
    const compiled = new URL(`./${name}.js`, import.meta.url);
    const source = new URL(`./${name}.ts`, import.meta.url);
    const file = existsSync(compiled) ? compiled : source;
    if (!existsSync(file)) return [];
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > 2n * 1024n * 1024n) throw new Error("invalid bounded evolution implementation module");
    const stamp = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    const key = file.href;
    let entry = cache.get(key);
    if (!entry || entry.stamp !== stamp) { entry = { stamp, digest: sha256(readFileSync(file)) }; cache.set(key, entry); }
    return [{ name, digest: entry.digest }];
  });
  if (identities.length < 2) throw new Error("evolution tool implementation identity unavailable");
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
