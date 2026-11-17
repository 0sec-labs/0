/**
 * Intent prefetch: warm a route's code and data when the pointer rests on a link (or focus lands on it) for a
 * short moment, so the click that follows opens from cache. The delay keeps a pointer sweeping across the
 * sidebar from fetching every row it crosses.
 */
export const INTENT_DELAY_MS = 50;

export type IntentTarget = { kind: "path"; pathname: string } | { kind: "finding"; fingerprint: string };

/** What a hovered or focused element points at, or undefined when it is not prefetchable. */
export function intentTarget(element: Element | null | undefined, base: string): IntentTarget | undefined {
  const row = element?.closest?.<HTMLElement>("[data-fingerprint]");
  if (row?.dataset.fingerprint) return { kind: "finding", fingerprint: row.dataset.fingerprint };
  const anchor = element?.closest?.<HTMLAnchorElement>("a[href]");
  if (!anchor) return undefined;
  try {
    const url = new URL(anchor.href, base);
    return url.origin === new URL(base).origin ? { kind: "path", pathname: url.pathname } : undefined;
  } catch { return undefined; }
}

const sameTarget = (a: IntentTarget, b: IntentTarget) => a.kind === "path" ? b.kind === "path" && a.pathname === b.pathname : b.kind === "finding" && a.fingerprint === b.fingerprint;

/** Runs `run(target)` once the same target has been held for `delay` ms; leaving or switching target cancels it. */
export function createIntentPrefetcher(run: (target: IntentTarget) => void, delay = INTENT_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: IntentTarget | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; current = undefined; };
  return {
    enter(target: IntentTarget | undefined) {
      if (!target) { cancel(); return; }
      if (current && sameTarget(current, target)) return;
      cancel();
      current = target;
      timer = setTimeout(() => { timer = undefined; run(target); }, delay);
    },
    cancel,
  };
}
