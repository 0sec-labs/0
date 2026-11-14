import { useSyncExternalStore } from "react";
import { type Accent, type FontSize, type MotionPreference, DEFAULT_ACCENT, parseAccent, parseFontSize, parseMotionPreference, resolveReducedMotion } from "./appearance-model";
import { STORAGE_KEYS, storage } from "./storage";
import { getColorThemeId, subscribeColorTheme } from "./color-theme";
import { DEFAULT_COLOR_THEME } from "./color-themes";

/**
 * Browser-wide accent, font size and reduced-motion preferences. Each is mirrored to a data attribute on <html>
 * (read by styles.css and motion.css); the inline script in index.html applies the same values before first paint.
 */
interface Preference<T extends string> {
  get(): T; set(next: T): void; use(): readonly [T, (next: T) => void]; init(): void;
}

function createPreference<T extends string>(key: string, parse: (value: unknown) => T, apply: (value: T) => void, fallback: T, extra?: (refresh: () => void) => void): Preference<T> {
  const listeners = new Set<() => void>();
  let value = fallback, initialized = false;
  const publish = (next: T) => { const changed = next !== value; value = next; apply(next); if (changed) for (const notify of listeners) notify(); };
  const refresh = () => publish(parse(storage.readText(key)));
  const init = () => {
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    refresh();
    window.addEventListener("storage", event => { if (event.key === key || event.key === null) refresh(); });
    extra?.(() => apply(value));
  };
  const subscribe = (notify: () => void) => { init(); listeners.add(notify); return () => { listeners.delete(notify); }; };
  const get = () => { init(); return value; };
  const set = (next: T) => { if (parse(next) !== next) return; init(); storage.writeText(key, next); publish(next); };
  return { get, set, init, use: () => [useSyncExternalStore(subscribe, get, () => fallback), set] as const };
}

const root = () => document.documentElement;
const accent = createPreference<Accent>(STORAGE_KEYS.accent, parseAccent, value => {
  if (typeof document === "undefined") return;
  // Accent presets only recolour the default Zero theme; any other theme brings its own primary.
  if (value === DEFAULT_ACCENT || getColorThemeId() !== DEFAULT_COLOR_THEME) delete root().dataset.accent; else root().dataset.accent = value;
}, DEFAULT_ACCENT, reapply => { subscribeColorTheme(reapply); });
const fontSize = createPreference<FontSize>(STORAGE_KEYS.fontSize, parseFontSize, value => {
  if (typeof document === "undefined") return;
  if (value === "default") delete root().dataset.fontSize; else root().dataset.fontSize = value;
}, "default");

const osReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const motion = createPreference<MotionPreference>(STORAGE_KEYS.motion, parseMotionPreference, value => {
  if (typeof document === "undefined") return;
  if (resolveReducedMotion(value, osReducedMotion())) root().dataset.motion = "reduce"; else delete root().dataset.motion;
}, "system", reapply => window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener("change", reapply));

export const initializeWebAppearance = () => { accent.init(); fontSize.init(); motion.init(); };
export const getWebAccent = accent.get, setWebAccent = accent.set, useWebAccent = accent.use;
export const getWebFontSize = fontSize.get, setWebFontSize = fontSize.set, useWebFontSize = fontSize.use;
export const getMotionPreference = motion.get, setMotionPreference = motion.set, useMotionPreference = motion.use;
