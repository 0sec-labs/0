import { resolveEngagement } from "./engagement-plan.js";
import { existsSync } from "node:fs";

export function detectAndRoute(target: string): string[] | null {
  const resolution = resolveEngagement(target);
  if (!resolution.ok) return null;
  const { plan } = resolution;

  if (plan.kind === "web") {
    return ["scan", "web", "--target", plan.target];
  }
  if (plan.kind === "source") {
    return ["scan", "source", plan.target, "--depth", "deep"];
  }
  return ["scan", "package", plan.target, "--ecosystem", plan.ecosystem ?? "npm"];
}

const SCAN_MODULES = ["web", "source", "package", "deep", "repair", "campaign", "fix", "verify", "deps", "eval", "agent-assure", "disclose"] as const;

/**
 * `0 scan <target>` → the module that fits the target. Explicit modules, help and
 * unroutable input fall through to commander untouched. The legacy
 * `0 scan --target <url>` form maps to the `web` module.
 */
export function rewriteScanArgs(args: readonly string[]): string[] | undefined {
  if (args[0] !== "scan" || args[1] === undefined) return undefined;
  const first = args[1];
  if ((SCAN_MODULES as readonly string[]).includes(first) || first === "help" || first === "-h" || first === "--help") return undefined;
  if (first.startsWith("-")) {
    return args.some((arg) => arg === "--target" || arg.startsWith("--target=")) ? ["scan", "web", ...args.slice(1)] : undefined;
  }
  const route = detectAndRoute(first);
  return route ? [...route, ...args.slice(2)] : undefined;
}

const TARGET_FORMS = "a URL (https://...), a folder or git repository (./path or a git URL), or npm:<name>, pypi:<name>, cargo:<name> or oci:<ref>";
const PACKAGE_PREFIX_HINTS: Readonly<Record<string, string>> = { pip: "pypi:", python: "pypi:", crates: "cargo:", crate: "cargo:", docker: "oci:", container: "oci:", image: "oci:", node: "npm:", yarn: "npm:", pnpm: "npm:" };

/**
 * Why `0 scan <target>` cannot pick a module for this target, or undefined when it can (or when `args` is not a scan
 * with a target). Without this commander answers "unknown command 'pip:foo'", which says nothing about what to type instead.
 */
export function scanTargetProblem(args: readonly string[], exists: (path: string) => boolean = existsSync): string | undefined {
  if (args[0] !== "scan" || args[1] === undefined || args[1].startsWith("-")) return undefined;
  const first = args[1];
  if ((SCAN_MODULES as readonly string[]).includes(first) || first === "help") return undefined;
  // A path-shaped target that is not there is a typo. Checked here, at the `scan <target>` entry, so a bad option is still reported as a bad option by the module.
  if (/^(\.{1,2}[\\/]|\/)/.test(first) && !exists(first)) return `No such folder: ${first}. Check the path, or pass a git URL to scan a repository.`;
  if (detectAndRoute(first)) return undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(first)?.[1]?.toLowerCase();
  const hint = scheme ? PACKAGE_PREFIX_HINTS[scheme] : undefined;
  if (hint) return `Unsupported package source "${scheme}:". Did you mean ${hint}${first.slice(scheme!.length + 1)}? A target is ${TARGET_FORMS}.`;
  if (scheme && !/^[A-Za-z]$/.test(scheme)) return `Unsupported target "${first}". A target is ${TARGET_FORMS}.`;
  const bareName = /^[\w.@-]+$/.test(first);
  return `Can't tell what "${first}" is. ${bareName ? `For a package try npm:${first}, for a folder try ./${first}. ` : ""}A target is ${TARGET_FORMS}.`;
}
