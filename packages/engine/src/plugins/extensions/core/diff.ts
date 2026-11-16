/**
 * Folder diff between two revisions. Pure: no git, no file system.
 *
 * Invariant: EVERY added, removed and changed path is listed, with executable-bit changes, however large the change.
 * The patch body is ordered so what can run or configure comes first (scripts, MCP and manifest files), and a file
 * that does not fit the budget or is too large or binary is summarised by size and SHA-256, never omitted.
 */
import { sha256Hex, type FolderFile } from "./files.js";

export interface ModeChange { path: string; from: "644" | "755"; to: "644" | "755" }
export interface FolderDiff {
  added: string[]; removed: string[]; changed: string[]; modeChanges: ModeChange[]; patch: string;
  /** True when at least one file's text diff was replaced by a size/hash summary (it is still listed). */
  patchTruncated: boolean;
  /** Paths whose body is summarised instead of shown. */
  summarised: string[];
}
const PATCH_BUDGET = 48 * 1024; const MAX_LINES = 400; const MAX_FILE_BYTES = 256 * 1024;

function lineDiff(a: string[], b: string[]): string[] {
  const n = a.length; const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

const CONFIG = /(^|\/)(extension\.json|plugin\.json|\.mcp\.json|mcp\.json|package\.json|[^/]*\.(json|ya?ml|toml))$/i;
const RUNNABLE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|ps1|bat|pl)$/i;
/** Lower runs first: scripts and executables, then MCP/config/manifest, then everything else. */
const rank = (path: string, a: FolderFile | undefined, b: FolderFile | undefined): number =>
  (a?.executable || b?.executable || path.startsWith("scripts/") || RUNNABLE.test(path)) ? 0 : CONFIG.test(path) ? 1 : 2;

export function diffFolders(before: readonly FolderFile[], after: readonly FolderFile[]): FolderDiff {
  const old = new Map(before.map(f => [f.path, f])); const next = new Map(after.map(f => [f.path, f]));
  const added = [...next.keys()].filter(p => !old.has(p)).sort();
  const removed = [...old.keys()].filter(p => !next.has(p)).sort();
  const modeChanges: ModeChange[] = [];
  const changed = [...next.keys()].filter(p => {
    const a = old.get(p); const b = next.get(p); if (!a || !b) return false;
    if (a.executable !== b.executable) modeChanges.push({ path: p, from: a.executable ? "755" : "644", to: b.executable ? "755" : "644" });
    return !a.bytes.equals(b.bytes) || a.executable !== b.executable;
  }).sort();
  modeChanges.sort((x, y) => (x.path < y.path ? -1 : 1));

  const order = [...removed.map(p => ({ p, a: old.get(p), b: undefined })), ...added.map(p => ({ p, a: undefined, b: next.get(p) })), ...changed.map(p => ({ p, a: old.get(p), b: next.get(p) }))]
    .sort((x, y) => rank(x.p, x.a, x.b) - rank(y.p, y.a, y.b) || (x.p < y.p ? -1 : 1));
  const parts: string[] = []; const summarised: string[] = []; let used = 0;
  const summary = (p: string, a: FolderFile | undefined, b: FolderFile | undefined, why: string) => {
    summarised.push(p);
    parts.push(`@@ ${p} (${why}) @@`, ...(a ? [`  before: ${a.size} bytes sha256 ${sha256Hex(a.bytes).slice(0, 16)}`] : []), ...(b ? [`  after:  ${b.size} bytes sha256 ${sha256Hex(b.bytes).slice(0, 16)}`] : []));
  };
  for (const { p, a, b } of order) {
    const binary = (a?.bytes.includes(0) ?? false) || (b?.bytes.includes(0) ?? false);
    if (binary) { summary(p, a, b, "binary"); continue; }
    if ((a?.size ?? 0) > MAX_FILE_BYTES || (b?.size ?? 0) > MAX_FILE_BYTES) { summary(p, a, b, "large file, summarised"); continue; }
    const x = a ? a.bytes.toString("utf8").split("\n") : []; const y = b ? b.bytes.toString("utf8").split("\n") : [];
    if (x.length > MAX_LINES || y.length > MAX_LINES) { summary(p, a, b, "too many lines to diff, summarised"); continue; }
    const body = [`@@ ${p} @@`, ...lineDiff(x, y)]; const size = body.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > PATCH_BUDGET) { summary(p, a, b, "diff budget reached, summarised"); continue; }
    used += size; parts.push(...body);
  }
  return { added, removed, changed, modeChanges, patch: parts.join("\n"), patchTruncated: summarised.length > 0, summarised };
}
