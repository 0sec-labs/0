import { useSyncExternalStore } from "react";

export type WebTheme = "light" | "dark";
export const WEB_THEME_STORAGE_KEY = "zero-web-theme";
const listeners = new Set<() => void>();
let theme: WebTheme = "dark";
let initialized = false;

const validTheme = (value: unknown): value is WebTheme => value === "light" || value === "dark";
function storedTheme(): WebTheme {
  try {
    const value = window.localStorage.getItem(WEB_THEME_STORAGE_KEY);
    return validTheme(value) ? value : "dark";
  } catch { return "dark"; }
}
function applyTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.mode = theme;
  root.style.colorScheme = theme;
  // Remove old backend palette overrides; browser surfaces are CSS-owned.
  for (const token of ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-text", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "border", "input", "ring", "sidebar", "sidebar-foreground", "sidebar-border", "destructive"]) root.style.removeProperty(`--${token}`);
}
function publish(next: WebTheme) {
  const changed = theme !== next;
  theme = next;
  applyTheme();
  if (changed) for (const notify of listeners) notify();
}
/** Browser-wide preference: independent of host, account, and terminal settings. */
export function initializeWebTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  publish(storedTheme());
  window.addEventListener("storage", event => {
    if (event.key === WEB_THEME_STORAGE_KEY || event.key === null) publish(storedTheme());
  });
}
export function getWebTheme(): WebTheme {
  initializeWebTheme();
  return theme;
}
export function setWebTheme(next: WebTheme) {
  if (!validTheme(next)) return;
  initializeWebTheme();
  try { window.localStorage.setItem(WEB_THEME_STORAGE_KEY, next); } catch { /* Keep the in-memory selection usable in restricted browsers. */ }
  publish(next);
}
function subscribe(notify: () => void) {
  initializeWebTheme();
  listeners.add(notify);
  return () => listeners.delete(notify);
}
export function useWebTheme(): readonly [WebTheme, typeof setWebTheme] {
  return [useSyncExternalStore(subscribe, getWebTheme, () => "dark" as const), setWebTheme] as const;
}
