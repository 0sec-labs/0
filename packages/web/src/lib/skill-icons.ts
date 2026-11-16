/** Which icon a bundled skill's tile shows. Pure: the component maps a key to an icon, so this stays testable. */
export type SkillIconKey = "web" | "injection" | "identity" | "llm" | "native" | "crypto" | "source" | "cloud" | "supply" | "ci" | "report" | "develop" | "extension" | "folder" | "document";

/** Whole words in a skill name that decide its icon before the category does. */
const NAME_WORDS: readonly [SkillIconKey, readonly string[]][] = [
  ["ci", ["ci", "cd", "pipeline", "pipelines", "gha", "actions", "workflow"]],
  ["cloud", ["cloud", "aws", "gcp", "azure", "s3", "iam", "kubernetes", "k8s", "terraform", "docker", "container"]],
  ["supply", ["supply", "dependency", "dependencies", "sbom", "package", "packages", "npm", "pypi", "lockfile"]],
  ["crypto", ["crypto", "cryptography", "tls", "cipher", "padding", "oracle", "signature", "hash"]],
  ["native", ["binary", "binaries", "native", "firmware", "elf", "fuzz", "fuzzing", "memory", "reverse"]],
];

const CATEGORY_ICON: Record<string, SkillIconKey> = {
  web: "web", injection: "injection", identity: "identity", llm: "llm", "native & crypto": "native",
  "code review": "source", "supply chain": "supply", reporting: "report", development: "develop",
};

/** Bundled skills: name keywords first, then the category. Anything unknown gets the plain document icon. */
export function bundledSkillIcon(skill: { name: string; category?: string }): SkillIconKey {
  const words = new Set(skill.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const [key, list] of NAME_WORDS) if (list.some(word => words.has(word))) return key;
  return CATEGORY_ICON[(skill.category ?? "").trim().toLowerCase()] ?? "document";
}
