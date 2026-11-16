import {
  ACCENTS, DEFAULT_ACCENT, DEFAULT_BACKDROP, parseAccent, parseBackdrop, parseFontSize, parseMotionPreference, parseThemePreference,
  type Accent, type BackdropKind, type FontSize, type MotionPreference, type ThemePreference,
} from "./appearance-model";
import { DEFAULT_COLOR_THEME, forcedMode, getColorTheme, parseColorTheme, type ThemeMode } from "./color-themes";
import { STORAGE_KEYS } from "./storage";

/**
 * Everything a person can change about how the console looks, as one typed value. The six preferences live in separate
 * browser keys (the inline script in index.html reads some of them before first paint), so this module is the single place
 * that knows the key names, the defaults, which combinations are valid, and how the older keys carry over.
 * Compact transcript is not here: it is an engine setting (`density`) that follows the account, not the browser.
 */
export interface AppearanceSettings {
  mode: ThemePreference;
  theme: string;
  accent: Accent;
  background: BackdropKind;
  fontSize: FontSize;
  motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { mode: "system", theme: DEFAULT_COLOR_THEME, accent: DEFAULT_ACCENT, background: DEFAULT_BACKDROP, fontSize: "default", motion: "system" };

/** Browser storage key of each preference. */
export const APPEARANCE_KEYS: Record<keyof AppearanceSettings, string> = {
  mode: STORAGE_KEYS.theme, theme: STORAGE_KEYS.colorTheme, accent: STORAGE_KEYS.accent, background: STORAGE_KEYS.background, fontSize: STORAGE_KEYS.fontSize, motion: STORAGE_KEYS.motion,
};

/** Only the default Zero theme takes accent presets; every other theme brings its own primary colour. */
export const themeTakesAccent = (themeId: string): boolean => themeId === DEFAULT_COLOR_THEME;
/** The accents that work with a theme: all of them for Zero, none for the rest (the theme's own colour is the accent). */
export const accentsForTheme = (themeId: string): readonly (typeof ACCENTS)[number][] => themeTakesAccent(themeId) ? ACCENTS : [];
/** The modes a theme can show. A one-mode palette forces that mode. */
export function modesForTheme(themeId: string): readonly ThemePreference[] {
  const forced = forcedMode(getColorTheme(themeId));
  return forced ? [forced] : ["system", "light", "dark"];
}

/** Unknown or corrupt values fall back to defaults; combinations a theme cannot show are normalised (accent resets, forced mode wins). */
export function parseAppearance(raw: Partial<Record<keyof AppearanceSettings, unknown>>): AppearanceSettings {
  const theme = parseColorTheme(raw.theme);
  const forced: ThemeMode | undefined = forcedMode(getColorTheme(theme));
  return {
    mode: forced ?? parseThemePreference(raw.mode), theme,
    accent: themeTakesAccent(theme) ? parseAccent(raw.accent) : DEFAULT_ACCENT,
    background: parseBackdrop(raw.background), fontSize: parseFontSize(raw.fontSize), motion: parseMotionPreference(raw.motion),
  };
}

/**
 * Reads the stored values, including the pre-neutral accent key: users who picked blue, green, violet or rose keep it, everyone
 * else (including the old orange default) gets neutral. `writes` lists what should be stored to finish the migration.
 */
export function migrateAppearance(read: (key: string) => string | null): { settings: AppearanceSettings; writes: Partial<Record<string, string>> } {
  const writes: Partial<Record<string, string>> = {};
  let accent = read(STORAGE_KEYS.accent);
  if (accent === null) {
    const legacy = read(STORAGE_KEYS.accentLegacy);
    if (legacy === "blue" || legacy === "green" || legacy === "violet" || legacy === "rose") { accent = legacy; writes[STORAGE_KEYS.accent] = legacy; }
  }
  const settings = parseAppearance({
    mode: read(APPEARANCE_KEYS.mode), theme: read(APPEARANCE_KEYS.theme), accent,
    background: read(APPEARANCE_KEYS.background), fontSize: read(APPEARANCE_KEYS.fontSize), motion: read(APPEARANCE_KEYS.motion),
  });
  return { settings, writes };
}

/** Plain labels for the segmented controls. */
export const MODE_OPTIONS = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }] as const satisfies readonly { value: ThemePreference; label: string }[];
export const MOTION_OPTIONS = [{ value: "system", label: "System" }, { value: "reduce", label: "On" }, { value: "full", label: "Off" }] as const satisfies readonly { value: MotionPreference; label: string }[];
