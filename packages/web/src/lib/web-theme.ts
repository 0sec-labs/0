import { useSyncExternalStore } from "react";
import { type ResolvedTheme, type ThemePreference, isThemePreference, parseThemePreference, resolveTheme } from "./appearance-model";
import { STORAGE_KEYS, storage } from "./storage";
import { getColorThemeId, subscribeColorTheme } from "./color-theme";
import { constrainMode, getColorTheme } from "./color-themes";

/** The stored preference. "system" follows prefers-color-scheme and updates live. */
export type WebTheme = ThemePreference;
export const WEB_THEME_STORAGE_KEY = STORAGE_KEYS.theme;
const listeners = new Set<() => void>();
let theme: WebTheme = "dark";
let initialized = false;

const validTheme = isThemePreference;
const colorSchemeQuery = () => typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
function storedTheme(): WebTheme { return parseThemePreference(storage.readText(WEB_THEME_STORAGE_KEY)); }
/** The light/dark palette currently in effect. */
export function resolvedWebTheme(): ResolvedTheme { return constrainMode(getColorTheme(getColorThemeId()), resolveTheme(theme, colorSchemeQuery()?.matches === true)); }
function applyTheme() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolvedWebTheme();
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.mode = resolved;
  root.style.colorScheme = resolved;
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
  colorSchemeQuery()?.addEventListener("change", () => { if (theme === "system") applyTheme(); });
  subscribeColorTheme(() => { applyTheme(); for (const notify of listeners) notify(); }); // a palette can force or release a mode
}
export function getWebTheme(): WebTheme {
  initializeWebTheme();
  return theme;
}
export function setWebTheme(next: WebTheme) {
  if (!validTheme(next)) return;
  initializeWebTheme();
  storage.writeText(WEB_THEME_STORAGE_KEY, next); // restricted browsers keep the in-memory selection
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
