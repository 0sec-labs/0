import { useSyncExternalStore } from "react";
import { DEFAULT_COLOR_THEME, getColorTheme, isColorThemeId, parseColorTheme, type ThemePalette } from "./color-themes";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * The selected colour theme: stored under its own key, mirrored to `<html data-color-theme>` (absent for the default Zero
 * theme, which styles.css owns). The inline script in index.html applies the same attribute before first paint.
 * Accent and light/dark mode listen through `subscribeColorTheme`: Zero honours the accent presets, other themes bring their
 * own primary, and a single-mode palette forces that mode.
 */
export const COLOR_THEME_STORAGE_KEY = STORAGE_KEYS.colorTheme;
const listeners = new Set<() => void>();
let current = DEFAULT_COLOR_THEME;
let initialized = false;

const stored = () => parseColorTheme(storage.readText(COLOR_THEME_STORAGE_KEY));
function apply(id: string) {
  if (typeof document === "undefined") return;
  if (id === DEFAULT_COLOR_THEME) delete document.documentElement.dataset.colorTheme; else document.documentElement.dataset.colorTheme = id;
}
function publish(next: string) {
  const changed = next !== current;
  current = next;
  apply(next);
  if (changed) for (const notify of [...listeners]) notify();
}
export function initializeColorTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  publish(stored());
  window.addEventListener("storage", event => { if (event.key === COLOR_THEME_STORAGE_KEY || event.key === null) publish(stored()); });
}
export function getColorThemeId(): string { initializeColorTheme(); return current; }
export const getActiveColorTheme = (): ThemePalette => getColorTheme(getColorThemeId());
export function setColorTheme(next: string) {
  if (!isColorThemeId(next)) return;
  initializeColorTheme();
  if (next === DEFAULT_COLOR_THEME) storage.remove(COLOR_THEME_STORAGE_KEY); else storage.writeText(COLOR_THEME_STORAGE_KEY, next);
  publish(next);
}
/** Runs when the theme changes (accent and mode re-apply themselves). Returns the unsubscribe function. */
export function subscribeColorTheme(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; }
function subscribe(notify: () => void) { initializeColorTheme(); return subscribeColorTheme(notify); }
export function useColorTheme(): readonly [string, typeof setColorTheme] {
  return [useSyncExternalStore(subscribe, getColorThemeId, () => DEFAULT_COLOR_THEME), setColorTheme] as const;
}
