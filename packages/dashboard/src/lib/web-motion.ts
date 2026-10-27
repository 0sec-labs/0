import { useSyncExternalStore } from "react";

export const WEB_MOTION_STORAGE_KEY = "zero-web-reduce-motion";
const listeners = new Set<() => void>();
let reduced = false;
let initialized = false;
function preference(): boolean {
  try {
    const saved = window.localStorage.getItem(WEB_MOTION_STORAGE_KEY);
    if (saved === "true" || saved === "false") return saved === "true";
  } catch { /* Fall back to the operating system preference. */ }
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
function publish(next: boolean) {
  const changed = reduced !== next;
  reduced = next;
  if (typeof document !== "undefined") document.documentElement.dataset.reducedMotion = String(next);
  if (changed) for (const notify of listeners) notify();
}
/** Browser accessibility preference; terminal motion settings remain independent. */
export function initializeWebMotion() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  publish(preference());
  window.addEventListener("storage", event => { if (event.key === WEB_MOTION_STORAGE_KEY || event.key === null) publish(preference()); });
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => publish(preference()));
}
export function getWebReduceMotion(): boolean { initializeWebMotion(); return reduced; }
export function setWebReduceMotion(next: boolean) {
  if (typeof next !== "boolean") return;
  initializeWebMotion();
  try { window.localStorage.setItem(WEB_MOTION_STORAGE_KEY, String(next)); } catch { /* In-memory selection remains available. */ }
  publish(next);
}
function subscribe(notify: () => void) { initializeWebMotion(); listeners.add(notify); return () => listeners.delete(notify); }
export function useWebReduceMotion(): readonly [boolean, typeof setWebReduceMotion] {
  return [useSyncExternalStore(subscribe, getWebReduceMotion, () => false), setWebReduceMotion] as const;
}
