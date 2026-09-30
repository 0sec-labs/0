import type { ChatEntry } from "./types.js";

/** Replace a turn's public snapshot without moving it past later turns or deleting operator messages. */
export function replaceSubagentTurn(entries: readonly ChatEntry[], next: readonly ChatEntry[], agentId: string, turn: number, maxEntries: number): ChatEntry[] {
  const prefix = `${agentId}-t${turn}-`;
  const first = entries.findIndex((entry) => entry.id.startsWith(prefix));
  const retained = entries.filter((entry) => !entry.id.startsWith(prefix));
  const later = retained.findIndex((entry) => entry.turn > turn);
  const insertion = first >= 0 ? Math.min(first, retained.length) : later >= 0 ? later : retained.length;
  return retainSubagentTurns([...retained.slice(0, insertion), ...next, ...retained.slice(insertion)], maxEntries);
}

/** Retention drops whole old turns; one large latest turn must keep its answer and tools together. */
export function retainSubagentTurns(entries: readonly ChatEntry[], maxEntries: number): ChatEntry[] {
  let retained = [...entries];
  while (retained.length > maxEntries) {
    let oldestTurn = Infinity;
    for (const entry of retained) oldestTurn = Math.min(oldestTurn, entry.turn);
    if (retained.every((entry) => entry.turn === oldestTurn)) break;
    retained = retained.filter((entry) => entry.turn !== oldestTurn);
  }
  return retained;
}
