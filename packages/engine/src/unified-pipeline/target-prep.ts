import type { PipelineOptions } from "./types.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { SeedFinding, SemgrepFinding } from "../shared/index.js";
import type { ScanListener } from "../scanner.js";
import { cloneGitRepo } from "../repo-clone.js";
import { installPackageForEcosystem } from "../package-ecosystems.js";
import { isExistingLocalTargetPath, isExplicitLocalTargetPath, resolveLocalTargetPath } from "../path-resolution.js";
import { scanExecutionTimeout } from "../scan-plan.js";

/**
 * Parse the `--subsystem` flag value into an array of subsystem directory
 * paths. Supports comma-separated values (e.g. `crypto/,net/xfrm/`) for
 * cross-subsystem hypotheses. Each path is normalised: leading/trailing
 * whitespace is stripped, and a trailing `/` is ensured.
 *
 * Exported for tests.
 */
export function parseSubsystems(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith("/") ? s : `${s}/`));
}

/**
 * Resolve the effective review scope when a single `--subsystem` path is given
 * on a NON-kernel source review. Narrows `<scopePath>/<subsystem>` when that
 * subtree exists, so the oversized-review guard, semgrep, and the review agent
 * all operate on the subsystem instead of the whole monorepo.
 *
 * Previously the subsystem hint was applied only for the linux-kernel profile
 * (which does its own semgrep path-scoping + prompt threading), so a
 * `--subsystem` on a large monorepo under any other profile was silently
 * ignored — scopePath stayed the whole repo and the file-count guard rejected
 * targets like `dotnet/runtime`. Returns null when no narrowing applies: no
 * subsystem, multiple subsystems (kept whole-repo), a kernel profile, or a
 * missing subtree. Exported for tests.
 */
export function resolveSubsystemScope(
  scopePath: string,
  subsystem: string | undefined,
  reviewProfile: string | undefined,
): string | null {
  if (!subsystem) return null;
  if (reviewProfile === "linux-kernel" || reviewProfile === "xnu-kernel") {
    return null;
  }
  const subs = parseSubsystems(subsystem);
  if (subs.length !== 1) return null;
  const subPath = join(scopePath, subs[0]);
  return existsSync(subPath) ? subPath : null;
}


/**
 * Convert external `SeedFinding[]` (from `--seed-findings`) into the
 * `SemgrepFinding` shape the review pipeline already consumes everywhere
 * downstream (prompt builders, persistence, the finding-table renderer).
 *
 * This keeps the agent-prompt code path uniform: the agent sees a single
 * ranked list of leads and doesn't care which producer they came from.
 * Provenance is preserved in two places:
 *   - `ruleId` is prefixed with the producer source (e.g.
 *     `gemmaforge.CWE-89`) so the prompt visibly cites it.
 *   - `metadata` carries the full producer payload (gemmaforge_confidence,
 *     gemmaforge_layer, model_id) for any downstream renderer that wants
 *     to surface it.
 *
 * Severity is bucketed from the producer's confidence (0–1) so that the
 * agent's existing severity-aware triage logic gives the most-likely
 * leads more attention. The mapping is deliberately conservative —
 * "critical" is reserved for findings the agent has actually confirmed.
 *
 * Closes 0#368.
 */
export function seedFindingsToSemgrepShape(seeds: SeedFinding[]): SemgrepFinding[] {
  return seeds.map((s) => {
    const confidence = typeof s.confidence === "number" ? s.confidence : 0.5;
    let severity: string;
    if (confidence >= 0.8) severity = "high";
    else if (confidence >= 0.6) severity = "medium";
    else if (confidence >= 0.4) severity = "low";
    else severity = "info";

    const cwePart = s.cwe ?? "lead";
    const ruleId = `${s.source}.${cwePart}`;
    const claim = s.claim ?? `External lead from ${s.source}${s.cwe ? ` (${s.cwe})` : ""}`;
    const messageWithConfidence =
      typeof s.confidence === "number"
        ? `${claim} [confidence=${s.confidence.toFixed(2)}]`
        : claim;

    return {
      ruleId,
      message: messageWithConfidence,
      severity,
      path: s.file,
      startLine: s.startLine,
      endLine: s.endLine,
      snippet: s.snippet,
      metadata: {
        source: s.source,
        confidence: s.confidence,
        cwe: s.cwe,
        ...(s.metadata ?? {}),
      },
    };
  });
}

export interface PrepareResult {
  scopePath: string;
  resolvedTarget: string;
  resolvedType: "npm-package" | "pypi-package" | "cargo-package" | "oci-image" | "source-code" | "url" | "web-app";
  packageName?: string;
  packageVersion?: string;
  packageEcosystem?: "npm" | "pypi" | "cargo" | "oci";
  tempDir?: string;
  needsCleanup: boolean;
}

/**
 * Detect target type from the raw target string if not explicitly provided.
 */
export function detectTargetType(rawTarget: string): "npm-package" | "source-code" | "url" | "web-app" {
  // URL schemes are case-insensitive and operators paste padded values.
  const target = rawTarget.trim();
  // Git URL patterns
  if (
    target.startsWith("git@") ||
    /^git:\/\//i.test(target) ||
    target.endsWith(".git") ||
    /^https:\/\/github\.com\//i.test(target)
  ) {
    return "source-code";
  }
  if (/^https?:\/\//i.test(target)) {
    return "url";
  }
  // Local directory
  if (isExplicitLocalTargetPath(target) || isExistingLocalTargetPath(target)) {
    return "source-code";
  }
  // Only a registry-shaped name is an npm package; anything else (option-like
  // strings, other schemes, paths with spaces) must not reach `npm install`.
  if (/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(@.*)?$/.test(target)) {
    return "npm-package";
  }
  return "source-code";
}

/**
 * Phase 1: Prepare the target for analysis.
 *
 * - npm-package / pypi-package: install in temp dir
 * - source-code: clone if URL, resolve if local path
 * - url/web-app: no-op (target is the URL itself)
 */
export function prepareTarget(
  opts: PipelineOptions,
  emit: ScanListener,
): PrepareResult {
  const targetType = opts.targetType ?? detectTargetType(opts.target);

  if (targetType === "npm-package") {
    return prepareNpmPackage(opts.target, opts.packageVersion, emit);
  }

  if (targetType === "pypi-package") {
    return preparePythonPackage(opts.target, opts.packageVersion, emit);
  }

  if (targetType === "cargo-package") {
    return prepareCargoPackage(opts.target, opts.packageVersion, emit);
  }

  if (targetType === "oci-image") {
    return prepareOciImage(opts.target, opts.packageVersion, emit);
  }

  if (targetType === "source-code") {
    // Package-source review (#317 follow-up): when `reviewPackageEcosystem`
    // is set, `target` is a package NAME — install it and review its
    // extracted source, keeping `resolvedType: "source-code"` so the review
    // pipeline (profile prompt + review report) drives instead of audit.
    if (opts.reviewPackageEcosystem) {
      return prepareReviewPackage(
        opts.target,
        opts.reviewPackageEcosystem,
        opts.packageVersion,
        emit,
      );
    }
    return prepareSourceCode(opts.target, emit);
  }

  // url or web-app — nothing to install/clone
  return {
    scopePath: opts.target,
    resolvedTarget: opts.target,
    resolvedType: targetType,
    needsCleanup: false,
  };
}

export function prepareNpmPackage(
  rawPackageName: string,
  requestedVersion: string | undefined,
  emit: ScanListener,
): PrepareResult {
  // Split "node-forge@0.10.0" into name + version
  let packageName = rawPackageName;
  let version = requestedVersion;
  const atIdx = rawPackageName.startsWith("@")
    ? rawPackageName.indexOf("@", 1)
    : rawPackageName.indexOf("@");
  if (atIdx > 0) {
    packageName = rawPackageName.slice(0, atIdx);
    version = version ?? rawPackageName.slice(atIdx + 1);
  }

  const pkg = installPackageForEcosystem("npm", packageName, version, emit);

  return {
    scopePath: pkg.path,
    resolvedTarget: `npm:${pkg.name}@${pkg.version}`,
    resolvedType: "npm-package",
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageEcosystem: "npm",
    tempDir: pkg.tempDir,
    needsCleanup: true,
  };
}

export function preparePythonPackage(
  packageName: string,
  requestedVersion: string | undefined,
  emit: ScanListener,
): PrepareResult {
  const pkg = installPackageForEcosystem("pypi", packageName, requestedVersion, emit);
  return {
    scopePath: pkg.path,
    resolvedTarget: `pypi:${pkg.name}@${pkg.version}`,
    resolvedType: "pypi-package",
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageEcosystem: "pypi",
    tempDir: pkg.tempDir,
    needsCleanup: true,
  };
}

export function prepareCargoPackage(
  packageName: string,
  requestedVersion: string | undefined,
  emit: ScanListener,
): PrepareResult {
  const pkg = installPackageForEcosystem("cargo", packageName, requestedVersion, emit);
  return {
    scopePath: pkg.path,
    resolvedTarget: `cargo:${pkg.name}@${pkg.version}`,
    resolvedType: "cargo-package",
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageEcosystem: "cargo",
    tempDir: pkg.tempDir,
    needsCleanup: true,
  };
}

export function prepareOciImage(
  imageRef: string,
  requestedVersion: string | undefined,
  emit: ScanListener,
): PrepareResult {
  const pkg = installPackageForEcosystem("oci", imageRef, requestedVersion, emit);
  return {
    scopePath: pkg.path,
    resolvedTarget: `oci:${pkg.name}@${pkg.version}`,
    resolvedType: "oci-image",
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageEcosystem: "oci",
    tempDir: pkg.tempDir,
    needsCleanup: true,
  };
}

/**
 * Acquire a published package's source for REVIEW. Installs the package via
 * the shared ecosystem installer (same code the audit path uses) but reports
 * `resolvedType: "source-code"` so the downstream pipeline runs the review
 * agent + emits a review report rather than the package-audit flow. Install
 * progress streams through `emit`, so the cloud relay sees heartbeat events
 * during install (the reaper's no-event window stays satisfied). The temp
 * install dir is cleaned up by the caller via `needsCleanup`.
 */
export function prepareReviewPackage(
  rawPackageName: string,
  ecosystem: "npm" | "pypi" | "cargo" | "oci",
  requestedVersion: string | undefined,
  emit: ScanListener,
): PrepareResult {
  const pkg = installPackageForEcosystem(ecosystem, rawPackageName, requestedVersion, emit);
  return {
    scopePath: pkg.path,
    resolvedTarget: `${ecosystem}:${pkg.name}@${pkg.version}`,
    resolvedType: "source-code",
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageEcosystem: ecosystem,
    tempDir: pkg.tempDir,
    needsCleanup: true,
  };
}

export function prepareSourceCode(target: string, emit: ScanListener): PrepareResult {
  const isUrl =
    target.startsWith("https://") ||
    target.startsWith("http://") ||
    target.startsWith("git@") ||
    target.startsWith("git://");

  if (!isUrl) {
    const absPath = resolveLocalTargetPath(target);
    if (!existsSync(absPath)) {
      throw new Error(`Repository path not found: ${absPath}`);
    }
    return {
      scopePath: absPath,
      resolvedTarget: `repo:${absPath}`,
      resolvedType: "source-code",
      needsCleanup: false,
    };
  }

  const tempDir = join(tmpdir(), `0-pipeline-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempDir, { recursive: true });

  emit({ type: "stage:start", stage: "prepare", message: `Cloning ${target}...` });

  try {
    // Parses an optional `<url>.git@<ref>` version suffix (kernel/source
    // targets) and clones the pinned ref, not the default branch.
    cloneGitRepo(target, `${tempDir}/repo`);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to clone ${target}: ${msg}`);
  }

  const repoPath = join(tempDir, "repo");

  emit({ type: "stage:end", stage: "prepare", message: `Cloned ${basename(target.replace(/\.git$/, ""))}` });

  return {
    scopePath: repoPath,
    resolvedTarget: `repo:${target}`,
    resolvedType: "source-code",
    tempDir,
    needsCleanup: true,
  };
}


export function listChangedFiles(scopePath: string, diffBase: string): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRD", `${diffBase}...HEAD`],
    {
      cwd: scopePath,
      timeout: scanExecutionTimeout(30_000),
      stdio: "pipe",
      encoding: "utf-8",
    },
  );

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
