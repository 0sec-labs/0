import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { buildPriorVulnerabilityAuditGraph } from "./audit-graph.js";
import { buildPriorVulnerabilityPlaybooks } from "./dossier.js";
import { mergeIntel, toGraphSnapshot, uniqueStrings } from "./normalize.js";
import type {
  IntelSeverity,
  IntelSource,
  IntelTargetHistory,
  TargetHistorySearchInput,
  TargetMatchConfidence,
  VulnerabilityIntel,
} from "./types.js";

/** Loose free-text keywords must be at least this long to be matched (0#intel-advisories). */
const MIN_LOOSE_HINT_LENGTH = 4;
/** Structured names (repo/package/product) can be shorter (e.g. "gin"). */
const MIN_STRONG_HINT_LENGTH = 3;
const CONFIDENCE_RANK: Record<TargetMatchConfidence, number> = { high: 3, medium: 2, low: 1 };

export interface TargetHistoryInference {
  input: TargetHistorySearchInput;
  sources: string[];
}

export function buildTargetHistoryResult(
  input: TargetHistorySearchInput,
  advisories: VulnerabilityIntel[],
): IntelTargetHistory {
  const hints = targetHistoryHints(input);
  const matcher = buildTargetMatcher(input);
  // Score every candidate; drop advisories that match no target token at all
  // (the old plain-substring filter let "ADR" hit "adreno" and "kraken" hit
  // "KrakenD" — 0#intel-advisories), and annotate survivors with confidence.
  const filtered = mergeIntel(advisories)
    .flatMap((advisory) => {
      const confidence = scoreTargetMatch(advisory, matcher);
      return confidence ? [{ ...advisory, matchConfidence: confidence }] : [];
    })
    .sort((a, b) => CONFIDENCE_RANK[b.matchConfidence!] - CONFIDENCE_RANK[a.matchConfidence!]);
  const playbooks = buildPriorVulnerabilityPlaybooks(filtered, []);
  const auditGraph = buildPriorVulnerabilityAuditGraph(playbooks);
  const graph = toGraphSnapshot(filtered);
  return {
    target: {
      target: input.target,
      repoPath: input.repoPath,
      repository: normalizeRepositoryHint(input.repository ?? input.target),
      ecosystem: input.ecosystem,
      packageName: input.packageName,
      product: input.product,
      vendor: input.vendor,
      keywords: input.keywords ?? [],
    },
    generatedAt: new Date().toISOString(),
    summary: summarizeTargetHistory(filtered, playbooks.length, hints),
    advisories: filtered,
    playbooks,
    auditGraph,
    graph,
    provenance: {
      sources: uniqueStrings(filtered.flatMap((advisory) => advisory.sources)) as IntelSource[],
      offline: input.offline || undefined,
    },
  };
}

export function resolveTargetHistoryInput(input: TargetHistorySearchInput): TargetHistorySearchInput {
  if (!input.repoPath) return input;
  const inferred = inferTargetHistoryInputFromRepo(input.repoPath).input;
  return {
    ...inferred,
    ...input,
    repository: input.repository ?? inferred.repository,
    ecosystem: input.ecosystem ?? inferred.ecosystem,
    packageName: input.packageName ?? inferred.packageName,
    product: input.product ?? inferred.product,
    vendor: input.vendor ?? inferred.vendor,
    keywords: uniqueStrings([...(inferred.keywords ?? []), ...(input.keywords ?? [])]),
  };
}

export function inferTargetHistoryInputFromRepo(repoPath: string): TargetHistoryInference {
  const input: TargetHistorySearchInput = { repoPath };
  const sources: string[] = [];

  // Resolve the root once so every metadata read uses the same scope.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(repoPath);
  } catch {
    return { input, sources };
  }

  const packageJson = readJsonFile(join(canonicalRoot, "package.json"), canonicalRoot);
  if (packageJson) {
    sources.push("package.json");
    const name = typeof packageJson.name === "string" ? packageJson.name : undefined;
    const repo = repositoryFromPackageJson(packageJson.repository);
    input.ecosystem = "npm";
    input.packageName = name;
    input.product = unscopedPackageName(name);
    input.repository = repo;
  }

  const pyproject = readTextFile(join(canonicalRoot, "pyproject.toml"), canonicalRoot);
  if (pyproject) {
    sources.push("pyproject.toml");
    input.ecosystem ??= "pypi";
    input.packageName ??= matchTomlString(pyproject, "name");
    input.product ??= input.packageName;
    input.repository ??= normalizeRepositoryHint(matchTomlUrl(pyproject, "repository") ?? matchTomlUrl(pyproject, "source") ?? matchTomlUrl(pyproject, "homepage"));
  }

  const cargo = readTextFile(join(canonicalRoot, "Cargo.toml"), canonicalRoot);
  if (cargo) {
    sources.push("Cargo.toml");
    input.ecosystem ??= "cargo";
    input.packageName ??= matchTomlString(cargo, "name");
    input.product ??= input.packageName;
    input.repository ??= normalizeRepositoryHint(matchTomlString(cargo, "repository"));
  }

  const goMod = readTextFile(join(canonicalRoot, "go.mod"), canonicalRoot);
  if (goMod) {
    sources.push("go.mod");
    input.ecosystem ??= "Go";
    const module = goMod.match(/^module\s+(\S+)/m)?.[1];
    input.packageName ??= module;
    input.product ??= module?.split("/").filter(Boolean).at(-1);
    input.repository ??= normalizeRepositoryHint(module);
  }

  const gitConfig = readTextFile(join(canonicalRoot, ".git", "config"), canonicalRoot);
  if (gitConfig) {
    sources.push(".git/config");
    input.repository ??= normalizeRepositoryHint(matchGitRemoteUrl(gitConfig));
  }

  const repo = normalizeRepositoryHint(input.repository);
  const repoName = repo?.split("/")[1];
  input.repository = repo ?? input.repository;
  input.vendor ??= repo?.split("/")[0];
  input.keywords = uniqueStrings([
    input.product,
    input.packageName,
    repoName,
  ].filter((value) => value && value !== input.product));

  return { input, sources };
}

export function targetHistoryHints(input: TargetHistorySearchInput): string[] {
  const { repository, repoName, strongTokens, looseTokens } = buildTargetMatcher(input);
  // Display list for the summary: structured identifiers first, then loose
  // keywords. Structured names may be short (>=3, e.g. "gin"); loose keywords
  // must clear the higher bar to keep noise down.
  return uniqueStrings([
    repository,
    repoName,
    ...strongTokens,
    ...looseTokens,
  ]);
}

export interface TargetMatcher {
  repository?: string;
  repoName?: string;
  /** Exact package/product identifiers — token or exact-field matches → high/medium. */
  strongTokens: string[];
  /** Loose free-text keywords + vendor/product phrase — token matches → low. */
  looseTokens: string[];
  /** Names an advisory's package field may equal for a high-confidence hit. */
  exactPackageNames: string[];
}

/**
 * Turn a target into a structured matcher (0#intel-advisories). Splits
 * high-signal identifiers (repository, package name, product) from loose
 * free-text keywords so we can score each advisory by how strongly it matches
 * instead of doing an arbitrary substring test.
 */
export function buildTargetMatcher(input: TargetHistorySearchInput): TargetMatcher {
  const repository = normalizeRepositoryHint(input.repository ?? input.target)?.toLowerCase();
  const repoName = repository?.split("/")[1];
  const packageName = input.packageName?.toLowerCase();
  const unscoped = unscopedPackageName(packageName);
  const product = input.product?.toLowerCase();
  const strongTokens = uniqueStrings([repoName, product, unscoped].map((t) => t ?? undefined))
    .filter((token) => token.length >= MIN_STRONG_HINT_LENGTH);
  const vendorProduct = input.vendor && input.product ? `${input.vendor} ${input.product}`.toLowerCase() : undefined;
  const looseTokens = uniqueStrings([vendorProduct, ...(input.keywords ?? []).map((k) => k.toLowerCase())])
    .filter((token) => token.length >= MIN_LOOSE_HINT_LENGTH);
  const exactPackageNames = uniqueStrings([packageName, unscoped, product].map((t) => t ?? undefined));
  return { repository, repoName, strongTokens, looseTokens, exactPackageNames };
}

function readJsonFile(path: string, root: string): Record<string, unknown> | undefined {
  const text = readTextFile(path, root);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function readTextFile(path: string, root: string): string | undefined {
  try {
    const canonicalPath = realpathSync(path);
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (canonicalPath !== root && !canonicalPath.startsWith(prefix)) return undefined;
    return readFileSync(canonicalPath, "utf-8");
  } catch {
    return undefined;
  }
}

function repositoryFromPackageJson(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeRepositoryHint(value);
  if (value && typeof value === "object" && "url" in value && typeof value.url === "string") {
    return normalizeRepositoryHint(value.url);
  }
  return undefined;
}

function unscopedPackageName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name.replace(/^@[^/]+\//, "");
}

function matchTomlString(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

function matchTomlUrl(text: string, key: string): string | undefined {
  const direct = matchTomlString(text, key);
  if (direct) return direct;
  return text.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\{[^}]*url\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

function matchGitRemoteUrl(text: string): string | undefined {
  const originBlock = text.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  return (originBlock ?? text).match(/^\s*url\s*=\s*(\S+)/m)?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeRepositoryHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^git\+/, "");
  if (!trimmed) return undefined;
  const plainMatch = trimmed.match(/^([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (plainMatch?.[1] && plainMatch[2] && !plainMatch[1].includes(".")) return `${plainMatch[1]}/${plainMatch[2]}`;
  const sshMatch = trimmed.match(/^git@github\.com:([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch?.[1] && sshMatch[2]) return `${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (!/github\.com$/i.test(url.hostname)) return undefined;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return undefined;
    return `${owner}/${repo.replace(/\.git$/i, "")}`;
  } catch {
    const match = trimmed.match(/(?:github\.com[:/])?([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i);
    return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
  }
}

/**
 * Score how strongly an advisory matches the target (0#intel-advisories):
 *   high   — exact repository (reference URL) or package-name match
 *   medium — a structured token (repo/package/product) appears as a whole word
 *   low    — only a loose keyword appears as a whole word
 *   null   — no token match; the advisory is dropped as spurious
 * Word-boundary matching (not arbitrary `includes`) prevents "ADR" hitting
 * "adreno" or "kraken" hitting "KrakenD".
 */
export function scoreTargetMatch(
  advisory: VulnerabilityIntel,
  matcher: TargetMatcher,
): TargetMatchConfidence | null {
  const hasCriteria =
    Boolean(matcher.repository) ||
    matcher.strongTokens.length > 0 ||
    matcher.looseTokens.length > 0 ||
    matcher.exactPackageNames.length > 0;
  if (!hasCriteria) return null;

  // High: exact repository (via a reference URL) or exact package-name match.
  if (matcher.repository && advisory.references.some((ref) => referenceMatchesRepo(ref.url, matcher.repository!))) {
    return "high";
  }
  const advisoryPackage = advisory.package?.name?.toLowerCase();
  if (advisoryPackage && matcher.exactPackageNames.includes(advisoryPackage)) {
    return "high";
  }

  const haystack = [
    advisory.summary,
    advisory.details,
    advisory.package?.name,
  ].filter((value): value is string => Boolean(value)).join("\n").toLowerCase();

  if (matcher.strongTokens.some((token) => tokenMatch(haystack, token))) return "medium";
  if (matcher.looseTokens.some((token) => tokenMatch(haystack, token))) return "low";
  return null;
}

function referenceMatchesRepo(url: string, repository: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/github\.com$/i.test(parsed.hostname)) return false;
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return false;
    return `${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase() === repository;
  } catch {
    return false;
  }
}

/** Whole-word match: `needle` bounded by non-alphanumerics (or string ends). */
function tokenMatch(haystack: string, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, "i").test(haystack);
}

function summarizeTargetHistory(
  advisories: VulnerabilityIntel[],
  playbookCount: number,
  hints: string[],
): IntelTargetHistory["summary"] {
  const criticalCount = advisories.filter((advisory) => advisory.severity === "critical").length;
  const highCount = advisories.filter((advisory) => advisory.severity === "high").length;
  const kevCount = advisories.filter((advisory) => advisory.kev?.knownExploited).length;
  const cwes = uniqueStrings(advisories.flatMap((advisory) => advisory.cwes));
  const confidenceCounts = {
    high: advisories.filter((advisory) => advisory.matchConfidence === "high").length,
    medium: advisories.filter((advisory) => advisory.matchConfidence === "medium").length,
    low: advisories.filter((advisory) => advisory.matchConfidence === "low").length,
  };
  return {
    advisoryCount: advisories.length,
    playbookCount,
    criticalCount,
    highCount,
    kevCount,
    cweCount: cwes.length,
    topSeverity: highestSeverity(advisories.map((advisory) => advisory.severity)),
    matchedHints: hints.slice(0, 10),
    confidenceCounts,
  };
}

function highestSeverity(severities: IntelSeverity[]): IntelSeverity {
  const order: IntelSeverity[] = ["critical", "high", "medium", "low", "info"];
  return order.find((severity) => severities.includes(severity)) ?? "info";
}
