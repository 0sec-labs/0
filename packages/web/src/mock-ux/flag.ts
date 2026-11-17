/**
 * PROTOTYPE ONLY. The UX mock is reachable in dev builds (import.meta.env.DEV) when ?mock=ux was opened once
 * (remembered in localStorage) and is switched off with ?mock=off. Production builds never include it.
 */
import { useCallback, useSyncExternalStore } from "react";

const MOCK_KEY = "0-mock-ux";
const VARIANT_KEY = "0-mock-ux-variant";
const OVERVIEW_KEY = "0-mock-ux-overview";
export type Variant = "a" | "b";

export function mockUxEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const param = new URLSearchParams(window.location.search).get("mock");
  try {
    if (param === "ux") localStorage.setItem(MOCK_KEY, "1");
    else if (param === "off") localStorage.removeItem(MOCK_KEY);
    return localStorage.getItem(MOCK_KEY) === "1";
  } catch { return param === "ux"; }
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); window.addEventListener("popstate", listener); return () => { listeners.delete(listener); window.removeEventListener("popstate", listener); }; };

function readVariant(): Variant {
  const param = new URLSearchParams(window.location.search).get("variant");
  if (param === "a" || param === "b") { try { localStorage.setItem(VARIANT_KEY, param); } catch { /* ignore */ } return param; }
  try { return localStorage.getItem(VARIANT_KEY) === "b" ? "b" : "a"; } catch { return "a"; }
}
/** ?variant=a|b wins and is remembered, so in-app navigation (which drops the query) keeps the variant. */
export function useVariant(): [Variant, (next: Variant) => void] {
  const variant = useSyncExternalStore(subscribe, readVariant, () => "a" as Variant);
  const set = useCallback((next: Variant) => {
    try { localStorage.setItem(VARIANT_KEY, next); } catch { /* ignore */ }
    const url = new URL(window.location.href);
    if (url.searchParams.has("variant")) { url.searchParams.set("variant", next); window.history.replaceState(null, "", url); }
    emit();
  }, []);
  return [variant, set];
}

/** The optional dashboard-style "Overview" agent. Default: off in variant A, on in variant B; the mock control overrides. */
export function useOverviewAgent(variant: Variant): [boolean, (next: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(OVERVIEW_KEY); } catch { return null; } }, () => null);
  const set = useCallback((next: boolean) => { try { localStorage.setItem(OVERVIEW_KEY, next ? "1" : "0"); } catch { /* ignore */ } emit(); }, []);
  return [stored === null ? variant === "b" : stored === "1", set];
}
