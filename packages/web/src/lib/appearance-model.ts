/** Pure appearance preferences: validation, resolution and the contrast maths the accent presets are checked with. */
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const ACCENTS = [
  { id: "orange", label: "Orange" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" },
  { id: "violet", label: "Violet" },
  { id: "rose", label: "Rose" },
  { id: "neutral", label: "Neutral" },
] as const;
export type Accent = (typeof ACCENTS)[number]["id"];
export const DEFAULT_ACCENT: Accent = "orange";

/** Scales are mirrored by `html[data-font-size]` in styles.css (default text 14px becomes about 13/14/16px). */
export const FONT_SIZES = [
  { id: "small", label: "Small" },
  { id: "default", label: "Default" },
  { id: "large", label: "Large" },
] as const;
export type FontSize = (typeof FONT_SIZES)[number]["id"];

export const MOTION_PREFERENCES = ["system", "reduce", "full"] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const isThemePreference = (value: unknown): value is ThemePreference => THEME_PREFERENCES.includes(value as ThemePreference);
export const isAccent = (value: unknown): value is Accent => ACCENTS.some(accent => accent.id === value);
export const isFontSize = (value: unknown): value is FontSize => FONT_SIZES.some(size => size.id === value);
export const isMotionPreference = (value: unknown): value is MotionPreference => MOTION_PREFERENCES.includes(value as MotionPreference);

/** Existing users keep Dark unless they pick another mode; unknown stored values fall back to it. */
export const parseThemePreference = (value: unknown): ThemePreference => isThemePreference(value) ? value : "dark";
export const parseAccent = (value: unknown): Accent => isAccent(value) ? value : DEFAULT_ACCENT;
export const parseFontSize = (value: unknown): FontSize => isFontSize(value) ? value : "default";
export const parseMotionPreference = (value: unknown): MotionPreference => isMotionPreference(value) ? value : "system";

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ResolvedTheme => preference === "system" ? (systemDark ? "dark" : "light") : preference;
/** `reduce` means reduced motion is in effect. An explicit "full" overrides the OS request. */
export const resolveReducedMotion = (preference: MotionPreference, osReduces: boolean): boolean => preference === "reduce" || (preference === "system" && osReduces);

export interface Rgb { r: number; g: number; b: number }
/** Parses #rgb, #rrggbb and oklch(L% C H) into sRGB 0..1 (clamped). Other forms return undefined. */
export function parseColor(input: string): Rgb | undefined {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const raw = hex[1]!.length === 3 ? [...hex[1]!].map(c => c + c).join("") : hex[1]!;
    return { r: parseInt(raw.slice(0, 2), 16) / 255, g: parseInt(raw.slice(2, 4), 16) / 255, b: parseInt(raw.slice(4, 6), 16) / 255 };
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(text);
  if (!ok) return undefined;
  const lightness = Number(ok[1]) / (ok[2] ? 100 : 1), chroma = Number(ok[3]), hue = Number(ok[4]) * Math.PI / 180;
  const a = chroma * Math.cos(hue), b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const encode = (v: number) => { const c = Math.min(1, Math.max(0, v)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
  return { r: encode(linear[0]!), g: encode(linear[1]!), b: encode(linear[2]!) };
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const [hi, lo] = [relativeLuminance(foreground), relativeLuminance(background)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
