import { LATEST_RELEASE, RELEASES, type Release } from "./releases";

/** Numeric dotted compare (1 when a is newer). Non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(part => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The sidebar card shows until the user opens or dismisses the newest release. */
export function showWhatsNewCard(latest: string, seen: string): boolean {
  return compareVersions(latest, seen || "0") > 0;
}

/** The modal opens by itself once per version, and never on top of the first-run setup card. */
export function shouldAutoOpenWhatsNew(input: { latest: string; seen: string; autoOpened: string; setupCardVisible: boolean }): boolean {
  if (input.setupCardVisible) return false;
  return showWhatsNewCard(input.latest, input.seen) && compareVersions(input.latest, input.autoOpened || "0") > 0;
}

export function releaseIndex(version: string, releases: readonly Release[] = RELEASES): number {
  const index = releases.findIndex(release => release.version === version);
  return index < 0 ? 0 : index;
}

const OPEN_EVENT = "zero:open-whats-new";
/** Reopen the dialog on the newest release (palette, account menu, sidebar card). */
export function openWhatsNew(version: string = LATEST_RELEASE.version) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: version }));
}
export function onOpenWhatsNew(handler: (version: string) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<string>).detail);
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
