/**
 * A tab left open across a server update still points at lazy chunks of the old build, which now 404.
 * One full reload fetches the new build; a sessionStorage guard keyed by the running build makes that happen
 * at most once, so a chunk that is genuinely missing can never put the page in a reload loop.
 */
export const CHUNK_FAILURE = /dynamically imported module|importing a module script|loading chunk|failed to fetch|load failed/i;

const GUARD_PREFIX = "0:chunk-reload:";

/** Identifies the running build: the hashed entry script URL changes with every build. */
export function currentBuildId(doc: Pick<Document, "querySelector"> = document): string {
  const entry = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  return entry ?? "unknown";
}

/** Reload once for this build. Returns true when a reload was started, false when this build already reloaded. */
export function reloadOnceForBuild(buildId: string, store: Pick<Storage, "getItem" | "setItem">, reload: () => void): boolean {
  const key = `${GUARD_PREFIX}${buildId}`;
  try {
    if (store.getItem(key)) return false;
    store.setItem(key, String(Date.now()));
  } catch { return false; } // Storage blocked: do not risk a loop.
  reload();
  return true;
}
