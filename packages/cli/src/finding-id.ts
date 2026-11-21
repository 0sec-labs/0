/**
 * Finding ids for people. An imported finding's id is `<scan id, 70 characters>-<its own 24>`, so the first eight
 * characters are the same for every finding in the file and a prefix never picks one. The part that differs is at the
 * end; show it, and accept it.
 */
const IMPORTED = /^((?:ci|sarif)-[a-f0-9]{64})-(.+)$/;

/** The part of an id to show and to type: the whole id's start for ordinary ids, the finding's own part for imported ones. */
export function shortFindingId(id: string): string {
  const imported = IMPORTED.exec(id);
  return (imported ? imported[2]! : id).slice(0, 8);
}

/** Like an id, a fingerprint of an imported finding begins with the file's identity; show what is distinctive. */
export function shortFingerprint(fingerprint: string): string {
  const imported = /^(?:ci|sarif)-[a-f0-9]{64}:(.+)$/.exec(fingerprint);
  return (imported ? imported[1]!.replace(/^sarif:/, "") : fingerprint).slice(0, 10);
}

/**
 * One finding for what the person typed: the whole id, the start of an id, the start of an imported finding's own part
 * (what `findings list` shows), or the end of an id. Throws when the text matches more than one finding.
 */
export function resolveFindingId<T extends { id: string }>(rows: readonly T[], input: string): T | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const exact = rows.find(row => row.id === text);
  if (exact) return exact;
  const strategies: Array<(row: T) => boolean> = [
    row => row.id.startsWith(text),
    row => (IMPORTED.exec(row.id)?.[2] ?? "").startsWith(text),
    row => text.length >= 6 && row.id.endsWith(text),
  ];
  for (const matches of strategies) {
    const found = rows.filter(matches);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`'${text}' matches ${found.length} findings; use more of the id (\`0 findings list\` shows the part that differs).`);
  }
  return undefined;
}
