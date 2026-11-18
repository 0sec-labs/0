// Source-marker helper for finding.
import { readFileSync } from "node:fs";

/** TODO, FIXME, XXX and HACK markers, or "known issue" / "documented limitation" phrasing. */
const SOURCE_MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b(?:[(:]\s*(.*?)\s*[):])?|(\bknown[ -](?:limitation|issue)s?\b|\bdocumented[ -]limitation\b)/gi;
function hasKnownMarkerText(source: string): boolean {
  SOURCE_MARKER_RE.lastIndex = 0;
  const matched = SOURCE_MARKER_RE.test(source);
  SOURCE_MARKER_RE.lastIndex = 0;
  return matched;
}

// #674 Part E — only an exact, workspace-contained citation can establish
// maintainer awareness. The vocabulary is shared with disclosure-draft warnings.
export function citedSourceHasKnownMarker(
  absolutePath: string,
  startLine: number,
  endLine: number,
): boolean {
  try {
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
    const cited = lines.slice(startLine - 1, endLine).join("\n");
    return hasKnownMarkerText(cited);
  } catch {
    // The source annotation remains valid even when a concurrent edit makes
    // this best-effort read fail; never invent maintainer awareness.
    return false;
  }
}
