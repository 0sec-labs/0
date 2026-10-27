/** Only local, observational built-ins may overlap. Every other call is a barrier:
 * even HTTP GETs and browser reads can mutate sessions or depend on prior calls.
 * Keep this explicit rather than deriving it from broad capability permissions.
 */
const CONCURRENT_LOCAL_READS = new Set(["read_file", "list_files", "search_files"]);
const MAX_CONCURRENT_LOCAL_READS = 4;

export function* nativeToolBatches<T extends { name: string }>(
  calls: readonly T[],
  concurrentReads = true,
): Generator<T[]> {
  let reads: T[] = [];
  for (const call of calls) {
    if (!concurrentReads || !CONCURRENT_LOCAL_READS.has(call.name)) {
      if (reads.length) { yield reads; reads = []; }
      yield [call];
    } else {
      reads.push(call);
      if (reads.length === MAX_CONCURRENT_LOCAL_READS) { yield reads; reads = []; }
    }
  }
  if (reads.length) yield reads;
}
