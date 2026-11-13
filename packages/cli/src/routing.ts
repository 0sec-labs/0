import { resolveEngagement } from "./engagement-plan.js";

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

export const SCAN_MODULES = ["web", "source", "package", "deep", "repair", "campaign"] as const;

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
