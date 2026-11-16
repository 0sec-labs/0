/** Folder diff between two revisions. Pure: no git, no file system. */
import type { FolderFile } from "./files.js";

export interface FolderDiff { added: string[]; removed: string[]; changed: string[]; patch: string; patchTruncated: boolean }
const PATCH_LIMIT = 16 * 1024; const MAX_LINES = 400;

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

export function diffFolders(before: readonly FolderFile[], after: readonly FolderFile[]): FolderDiff {
  const old = new Map(before.map(f => [f.path, f])); const next = new Map(after.map(f => [f.path, f]));
  const added = [...next.keys()].filter(p => !old.has(p)).sort();
  const removed = [...old.keys()].filter(p => !next.has(p)).sort();
  const changed = [...next.keys()].filter(p => old.has(p) && (!old.get(p)!.bytes.equals(next.get(p)!.bytes) || old.get(p)!.executable !== next.get(p)!.executable)).sort();
  const parts: string[] = [];
  const show = (path: string, a: FolderFile | undefined, b: FolderFile | undefined) => {
    const binary = (a?.bytes.includes(0) ?? false) || (b?.bytes.includes(0) ?? false);
    const x = a ? a.bytes.toString("utf8").split("\n") : []; const y = b ? b.bytes.toString("utf8").split("\n") : [];
    if (binary || x.length > MAX_LINES || y.length > MAX_LINES) { parts.push(`@@ ${path} (${binary ? "binary" : "too large to diff"}) @@`); return; }
    parts.push(`@@ ${path} @@`, ...lineDiff(x, y));
  };
  for (const p of removed) show(p, old.get(p), undefined);
  for (const p of added) show(p, undefined, next.get(p));
  for (const p of changed) show(p, old.get(p), next.get(p));
  const patch = parts.join("\n");
  return { added, removed, changed, patch: patch.slice(0, PATCH_LIMIT), patchTruncated: patch.length > PATCH_LIMIT };
}
