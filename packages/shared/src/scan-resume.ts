import { z } from "zod";
import type { PackageEcosystem, ScanDepth, ScanMode } from "./types.js";

/** Resume identifiers and budgets are portable; target, DB and provider authority stay on the engine. */
export const ScanResumeRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(160),
  approval: z.literal("launch-authorized-run"),
  branchFromEntry: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  timeCapMs: z.number().int().positive().max(86_400_000).optional(),
  costCapUsd: z.number().finite().positive().max(1000).optional(),
}).strict();
export type ScanResumeRequest = z.infer<typeof ScanResumeRequestSchema>;
export interface PersistedScanResumeTarget {
  target: string;
  targetType: "source-code" | "npm-package" | "pypi-package" | "cargo-package" | "oci-image" | "url" | "web-app";
  depth: ScanDepth;
  mode: ScanMode;
  packageVersion?: string;
  sourceDescription: string;
}

/** Decode stored scan identities, never console conversation state or past tool calls. */
export function resolvePersistedScanResume(scan: { id: string; target: string; depth: string; mode?: string | null }): PersistedScanResumeTarget {
  if (!scan.id || scan.id.startsWith("console-")) throw new Error("Choose a persisted assessment scan, not a console conversation.");
  const depth = z.enum(["quick", "default", "deep"]).parse(scan.depth);
  const storedMode = scan.mode ? z.enum(["probe", "deep", "mcp", "web", "http_audit", "llm-ipi"]).parse(scan.mode) : undefined;
  const raw = z.string().trim().min(1).max(4096).parse(scan.target);
  let parsed: Omit<PersistedScanResumeTarget, "depth" | "mode">;
  let impliedMode: ScanMode | undefined;
  if (/^https?:\/\//.test(raw)) parsed = { target: raw, targetType: "url", sourceDescription: "url" };
  else if (raw.startsWith("web:")) { parsed = { target: raw.slice(4), targetType: "web-app", sourceDescription: "web-app" }; impliedMode = "web"; }
  else if (raw.startsWith("mcp://")) { parsed = { target: raw, targetType: "url", sourceDescription: "mcp target" }; impliedMode = "mcp"; }
  else if (raw.startsWith("scan:")) parsed = { target: raw.slice(5), targetType: "url", sourceDescription: "url" };
  else if (raw.startsWith("repo:")) parsed = { target: raw.slice(5), targetType: "source-code", sourceDescription: "repository" };
  else {
    const match = /^(npm|pypi|cargo|oci):(.+)$/.exec(raw);
    if (!match) throw new Error(`Resume does not know how to route this persisted target yet: ${raw}`);
    const ecosystem = match[1] as PackageEcosystem;
    const spec = match[2]!;
    const at = spec.lastIndexOf("@");
    const target = at > 0 ? spec.slice(0, at) : spec;
    const packageVersion = at > 0 ? spec.slice(at + 1) : undefined;
    if (!target.trim() || packageVersion === "") throw new Error("Persisted package identity is incomplete.");
    const types = { npm: "npm-package", pypi: "pypi-package", cargo: "cargo-package", oci: "oci-image" } as const;
    parsed = { target, targetType: types[ecosystem], ...(packageVersion ? { packageVersion } : {}), sourceDescription: `${ecosystem} package` };
  }
  if (!parsed.target.trim()) throw new Error("Persisted scan target is empty.");
  const targetType = storedMode === "web" ? "web-app" : parsed.targetType;
  return { ...parsed, targetType, depth, mode: impliedMode ?? storedMode ?? (targetType === "web-app" ? "web" : "deep") };
}
