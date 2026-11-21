/**
 * Inline suggestions on a pull request: one review comment per finding that has a replacement and sits on lines the pull
 * request changed, so the author can apply it with "Commit suggestion". Pure functions; the runner does the `gh` calls.
 */
import { createHash } from "node:crypto";

export interface SuggestionFinding {
  id: string;
  title: string;
  severity: string;
  path: string;
  startLine: number;
  endLine?: number;
  /** Replacement text for startLine..endLine. */
  suggestion: string;
}

export const MAX_INLINE_SUGGESTIONS = 10;
const MAX_SUGGESTION_CHARS = 4000;
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
export const inlineMarker = (sentinelId: string, key?: string): string => `<!-- 0-inline:${sentinelId}:${key ?? ""}`;

/** The lines of the new file that appear in a unified diff (added or unchanged context), per file path. */
export function diffRightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!next) continue;
    if (line.startsWith("-") || line.startsWith("\\")) continue;
    lines.add(next++);
  }
  return lines;
}

/** Same finding at the same place gets the same key on every push, so its comment is found again. */
export function suggestionKey(finding: SuggestionFinding): string {
  return createHash("sha256").update(`${finding.path}\n${finding.startLine}\n${finding.endLine ?? ""}\n${finding.title}`).digest("hex").slice(0, 12);
}

const oneLine = (text: string, max: number) => text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "(link removed)").replace(/[\r\n\t]+/g, " ").replace(/[<>`\[\]]/g, "").replace(/@/g, "@​").slice(0, max).trim();
const safePath = (path: string) => /^[\w./@+-]{1,200}$/.test(path) && !path.startsWith("/") && !path.split("/").includes("..");

export function suggestionBody(sentinelId: string, finding: SuggestionFinding): string {
  // A fence the suggestion cannot close early.
  const fence = "`".repeat(Math.max(3, ...(finding.suggestion.match(/`+/g) ?? []).map(run => run.length + 1)));
  return [
    `${inlineMarker(sentinelId, suggestionKey(finding))} -->`,
    `**${oneLine(finding.severity, 16)}**: ${oneLine(finding.title, 160)}`,
    `${fence}suggestion\n${finding.suggestion.replace(/\n$/, "")}\n${fence}`,
    "_Automated suggestion. Review it before you apply it._",
  ].join("\n\n");
}

export interface InlinePlan {
  post: Array<{ key: string; path: string; line: number; startLine?: number; body: string }>;
  /** Comment ids from an earlier push whose finding is gone, moved or no longer in the diff. */
  remove: string[];
  skipped: number;
}

/**
 * What to post and what to take down. `existing` maps a key already on the pull request to its comment id.
 * A finding is posted only when it has a suggestion, a safe path and every line it covers is in the diff.
 */
export function planInlineSuggestions(input: {
  sentinelId: string;
  findings: readonly SuggestionFinding[];
  changed: ReadonlyMap<string, ReadonlySet<number>>;
  existing: ReadonlyMap<string, string>;
}): InlinePlan {
  const sorted = [...input.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity.toLowerCase()) - SEVERITY_ORDER.indexOf(b.severity.toLowerCase()));
  const wanted = new Set<string>();
  const post: InlinePlan["post"] = [];
  let skipped = 0;
  for (const finding of sorted) {
    const end = finding.endLine && finding.endLine >= finding.startLine ? finding.endLine : finding.startLine;
    const lines = input.changed.get(finding.path);
    const eligible = finding.suggestion.trim() !== "" && finding.suggestion.length <= MAX_SUGGESTION_CHARS && safePath(finding.path) && Number.isInteger(finding.startLine) && finding.startLine > 0 && end - finding.startLine < 30
      && lines !== undefined && Array.from({ length: end - finding.startLine + 1 }, (_, offset) => finding.startLine + offset).every(line => lines.has(line));
    if (!eligible) { skipped++; continue; }
    const key = suggestionKey(finding);
    if (wanted.has(key)) continue;
    wanted.add(key);
    if (input.existing.has(key) || post.length >= MAX_INLINE_SUGGESTIONS) continue;
    post.push({ key, path: finding.path, line: end, ...(end > finding.startLine ? { startLine: finding.startLine } : {}), body: suggestionBody(input.sentinelId, finding) });
  }
  const remove = [...input.existing].filter(([key]) => !wanted.has(key)).map(([, id]) => id);
  return { post, remove, skipped };
}
