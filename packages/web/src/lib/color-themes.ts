import { contrastRatio, parseColor, type Rgb } from "./appearance-model";

/**
 * Colour themes: a palette needs only six required values; the rest of our token ladder (panel, card, popover, muted,
 * borders, link, soft washes) is derived in CSS with `color-mix` (see `colorThemesCss`). `color-themes.css` is generated
 * from this file (a test keeps it in sync) and is keyed by `[data-color-theme="<id>"]`, so the same rules style the live
 * app (<html>) and the preview cards in the gallery.
 */
export interface RequiredTokens {
  /** Page background (`--background`). */
  bg: string;
  /** Primary foreground colour (`--foreground`). */
  fg: string;
  /** Body-text colour the muted-foreground ladder is mixed from. Usually the same as `fg`. */
  text: string;
  /** Accent for filled actions, switches and the focus ring. */
  primary: string;
  /** Text on a filled `primary` surface. */
  primaryText: string;
  /** Colour of the dither/shader accents. */
  shaderInk: string;
}
export interface OptionalTokens {
  chrome: string; panel: string; card: string; cardHover: string; popover: string; input: string; muted: string;
  mutedForeground1: string; mutedForeground2: string; mutedForeground3: string; iconMuted: string;
  /** Link colour (defaults to `primaryInk`). */
  textLink: string;
  /** Accent used as text on `bg`. Derived from `primary` (mixed toward `fg` until it reads at 4.5:1) when absent. */
  primaryInk: string;
}
export type Tokens = RequiredTokens & Partial<OptionalTokens>;
export const REQUIRED_TOKENS = ["bg", "fg", "text", "primary", "primaryText", "shaderInk"] as const satisfies readonly (keyof RequiredTokens)[];
export type ThemeMode = "light" | "dark";

export interface ThemePalette {
  id: string; name: string; author: string; license: string; sourceUrl: string;
  /** Short note for the gallery. */
  description?: string;
  light?: Tokens; dark?: Tokens;
}

export const DEFAULT_COLOR_THEME = "zero";

const toRgbHex = ({ r, g, b }: Rgb) => `#${[r, g, b].map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, a pct%, b)` in plain maths, so tests and derived defaults agree with the browser. */
export function mixSrgb(a: string, b: string, pct: number): string {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return a;
  const t = pct / 100;
  return toRgbHex({ r: x.r * t + y.r * (1 - t), g: x.g * t + y.g * (1 - t), b: x.b * t + y.b * (1 - t) });
}
export function contrast(a: string, b: string): number {
  const x = parseColor(a), y = parseColor(b);
  return x && y ? contrastRatio(x, y) : 0;
}

/** Text colour for a filled `primary`: the theme background when it reads at 4.5:1, then white, then black. */
export function readableOn(primary: string, bg: string): string {
  for (const candidate of [bg, "#ffffff", "#000000"]) if (contrast(candidate, primary) >= 4.5) return candidate;
  return contrast("#ffffff", primary) >= contrast("#000000", primary) ? "#ffffff" : "#000000";
}
/** The accent as text on the background: the accent itself, else mixed toward the foreground until it reads at 4.5:1. */
export function deriveInk(tokens: Tokens): string {
  if (tokens.primaryInk) return tokens.primaryInk;
  if (contrast(tokens.primary, tokens.bg) >= 4.5) return tokens.primary;
  for (let pct = 90; pct >= 0; pct -= 5) { const mixed = mixSrgb(tokens.primary, tokens.fg, pct); if (contrast(mixed, tokens.bg) >= 4.5) return mixed; }
  return tokens.fg;
}

/** Builds a palette's tokens from the four values every official palette has; text, button text and shader ink are derived. */
const tokens = (bg: string, fg: string, primary: string, extra: Partial<OptionalTokens & RequiredTokens> = {}): Tokens =>
  ({ bg, fg, text: fg, primary, primaryText: readableOn(primary, bg), shaderInk: primary, ...extra });

const MIT = "MIT";
/**
 * Palette values come from each project's official repository (see `sourceUrl`; licence texts in
 * docs/src/content/docs/third-party-notices.md). Only palette hex values are used; nothing else is copied.
 */
export const COLOR_THEMES: readonly ThemePalette[] = [
  {
    id: "zero", name: "Zero", author: "0 Labs", license: "Proprietary", sourceUrl: "https://0.security",
    description: "The default look. Accent presets apply here.",
    // Mirrors the :root and .dark tokens in styles.css so the gallery can preview it. The live app uses styles.css directly.
    light: tokens("oklch(96.2% .0025 290)", "oklch(23.5% .0038 290)", "#fd802e", { primaryText: "#ffffff", primaryInk: "oklch(56% .17 48)", panel: "oklch(98.5% .0015 290)", card: "oklch(100% 0 0)", cardHover: "oklch(97.8% .0015 290)", popover: "oklch(100% 0 0)", muted: "oklch(93.2% .0028 290)" }),
    dark: tokens("oklch(14.03% .0022 286.1)", "oklch(94.04% .0013 286.4)", "#fd802e", { primaryText: "#ffffff", primaryInk: "oklch(76% .15 55)", panel: "oklch(18.26% .002 286.2)", card: "oklch(21.82% .0019 286.2)", cardHover: "oklch(23.97% .0019 286.3)", popover: "oklch(25.24% .0019 286.3)", muted: "oklch(32.93% .0017 286.3)" }),
  },
  { id: "dracula", name: "Dracula", author: "Dracula Theme", license: MIT, sourceUrl: "https://github.com/dracula/dracula-theme",
    description: "Dracula with the Alucard light variant.",
    light: tokens("#fffbeb", "#1f1f1f", "#a3144d"), dark: tokens("#282a36", "#f8f8f2", "#ff79c6", { chrome: "#21222c", muted: "#44475a" }) },
  { id: "nord", name: "Nord", author: "Sven Greb (Arctic Ice Studio)", license: MIT, sourceUrl: "https://github.com/nordtheme/nord",
    description: "An arctic, north-bluish palette.",
    light: tokens("#eceff4", "#2e3440", "#5e81ac"), dark: tokens("#2e3440", "#d8dee9", "#88c0d0", { chrome: "#2b303b" }) },
  { id: "solarized", name: "Solarized", author: "Ethan Schoonover", license: MIT, sourceUrl: "https://github.com/altercation/solarized",
    description: "Precision colours for machines and people.",
    light: tokens("#fdf6e3", "#586e75", "#268bd2"), dark: tokens("#002b36", "#93a1a1", "#268bd2") },
  { id: "catppuccin", name: "Catppuccin", author: "Catppuccin", license: MIT, sourceUrl: "https://github.com/catppuccin/catppuccin",
    description: "Mocha for dark, Latte for light.",
    light: tokens("#eff1f5", "#4c4f69", "#8839ef", { chrome: "#e6e9ef" }), dark: tokens("#1e1e2e", "#cdd6f4", "#cba6f7", { chrome: "#181825", muted: "#45475a" }) },
  { id: "tokyo-night", name: "Tokyo Night", author: "enkia", license: MIT, sourceUrl: "https://github.com/tokyo-night/tokyo-night-vscode-theme",
    description: "Tokyo Night and Tokyo Day.",
    light: tokens("#e1e2e7", "#3760bf", "#2e7de9"), dark: tokens("#1a1b26", "#c0caf5", "#7aa2f7", { chrome: "#16161e" }) },
  { id: "rose-pine", name: "Rosé Pine", author: "Rosé Pine", license: MIT, sourceUrl: "https://github.com/rose-pine/rose-pine-theme",
    description: "Soho vibes: Main and Dawn.",
    light: tokens("#faf4ed", "#575279", "#907aa9"), dark: tokens("#191724", "#e0def4", "#c4a7e7", { muted: "#403d52" }) },
  { id: "one", name: "One", author: "GitHub (Atom One)", license: MIT, sourceUrl: "https://github.com/atom/one-dark-syntax",
    description: "Atom One Dark and One Light.",
    light: tokens("#fafafa", "#383a42", "#4078f2"), dark: tokens("#282c34", "#abb2bf", "#61afef", { chrome: "#21252b" }) },
  { id: "github", name: "GitHub", author: "Primer (GitHub)", license: MIT, sourceUrl: "https://github.com/primer/github-vscode-theme",
    description: "GitHub Dark and GitHub Light.",
    light: tokens("#f6f8fa", "#1f2328", "#0969da"), dark: tokens("#0d1117", "#e6edf3", "#58a6ff") },
  { id: "gruvbox", name: "Gruvbox", author: "Pavel Pertsev (community fork)", license: MIT, sourceUrl: "https://github.com/gruvbox-community/gruvbox",
    description: "Retro groove with warm contrast.",
    light: tokens("#fbf1c7", "#3c3836", "#b57614"), dark: tokens("#282828", "#ebdbb2", "#d79921", { chrome: "#1d2021" }) },
];

export const COLOR_THEME_IDS: readonly string[] = COLOR_THEMES.map(theme => theme.id);
export const isColorThemeId = (value: unknown): value is string => typeof value === "string" && COLOR_THEME_IDS.includes(value);
/** Stored ids that no longer exist (or corrupt values) fall back to the default theme. */
export const parseColorTheme = (value: unknown): string => isColorThemeId(value) ? value : DEFAULT_COLOR_THEME;
export const getColorTheme = (id: unknown): ThemePalette => COLOR_THEMES.find(theme => theme.id === id) ?? COLOR_THEMES[0]!;
/** The one mode a palette supports, or undefined when it has both. */
export function forcedMode(theme: ThemePalette): ThemeMode | undefined {
  if (theme.light && theme.dark) return undefined;
  return theme.dark ? "dark" : "light";
}
/** A palette with a single mode wins over the System/Light/Dark preference. */
export const constrainMode = (theme: ThemePalette, mode: ThemeMode): ThemeMode => forcedMode(theme) ?? mode;
export const tokensFor = (theme: ThemePalette, mode: ThemeMode): Tokens => (mode === "dark" ? theme.dark : theme.light) ?? theme.dark ?? theme.light!;

export const filterColorThemes = (query: string, themes: readonly ThemePalette[] = COLOR_THEMES): ThemePalette[] => {
  const needle = query.trim().toLowerCase();
  return needle ? themes.filter(theme => `${theme.name} ${theme.author} ${theme.id}`.toLowerCase().includes(needle)) : [...themes];
};
export const THEMES_PAGE_SIZE = 8;
/** 8 per page; `pages` is 1 when everything fits (so the pager is hidden). Out-of-range pages clamp. */
export function paginateThemes<T>(items: readonly T[], page: number, size = THEMES_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pages, Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)));
  return { page: current, pages, items: items.slice((current - 1) * size, current * size) };
}

/** The six swatches a gallery card needs, resolved for one mode. */
export function swatches(theme: ThemePalette, mode: ThemeMode) {
  const t = tokensFor(theme, mode);
  return { bg: t.bg, panel: t.panel ?? (mode === "dark" ? mixSrgb("#ffffff", t.bg, 5) : mixSrgb("#ffffff", t.bg, 66)), fg: t.fg, primary: t.primary };
}

const VARIABLES: ReadonlyArray<readonly [keyof Tokens, string]> = [
  ["bg", "bg"], ["fg", "fg"], ["text", "text"], ["primary", "primary"], ["primaryText", "primary-text"], ["shaderInk", "shader-ink"],
  ["chrome", "chrome"], ["panel", "panel"], ["card", "card"], ["cardHover", "card-hover"], ["popover", "popover"], ["input", "input"], ["muted", "muted"],
  ["mutedForeground1", "muted-foreground-1"], ["mutedForeground2", "muted-foreground-2"], ["mutedForeground3", "muted-foreground-3"], ["iconMuted", "icon-muted"], ["textLink", "text-link"],
];
/** Absent optional tokens are reset with `initial` so a nested preview card never inherits them from the page theme. */
const block = (selector: string, t: Tokens) => `${selector} {\n  ${[...VARIABLES.map(([key, name]) => `--t-${name}: ${t[key] ?? "initial"};`), `--t-ink: ${deriveInk(t)};`].join("\n  ")}\n}\n`;

/** Derived ladder: only `--t-*` inputs, evaluated per element so cards can preview a palette inside another theme. */
const DERIVED = (dark: boolean) => {
  const mixIn = (white: number, base: string) => `color-mix(in srgb, white ${white}%, ${base})`;
  return [
    "--background: var(--t-bg); --foreground: var(--t-fg); --card-foreground: var(--t-fg); --popover-foreground: var(--t-fg); --secondary-foreground: var(--t-fg);",
    "--primary: var(--t-primary); --switch-on: var(--t-primary); --primary-foreground: var(--t-primary-text);",
    `--primary-hover: color-mix(in oklch, var(--t-primary) ${dark ? 90 : 88}%, ${dark ? "white" : "black"});`,
    "--primary-ink: var(--t-ink); --primary-text: var(--t-ink); --text-link: var(--t-text-link, var(--t-ink));",
    `--ring: ${dark ? "var(--t-primary)" : "color-mix(in oklch, var(--t-primary) 70%, transparent)"}; --dither-ink: var(--t-shader-ink);`,
    `--primary-soft: color-mix(in srgb, var(--primary) ${dark ? 20 : 8}%, transparent); --primary-soft-hover: color-mix(in srgb, var(--primary) ${dark ? 24 : 12}%, transparent);`,
    "--inverse: var(--t-fg); --inverse-text: var(--t-bg);",
    `--muted-foreground: color-mix(in oklch, var(--t-text) ${dark ? 68 : 62}%, var(--t-bg)); --muted-foreground-1: var(--t-muted-foreground-1, var(--muted-foreground));`,
    `--muted-foreground-2: var(--t-muted-foreground-2, color-mix(in oklch, var(--t-text) ${dark ? 52 : 48}%, var(--t-bg))); --muted-foreground-3: var(--t-muted-foreground-3, color-mix(in oklch, var(--t-text) ${dark ? 38 : 36}%, var(--t-bg)));`,
    `--chrome: var(--t-chrome, var(--t-bg)); --panel: var(--t-panel, ${mixIn(dark ? 5 : 66, "var(--t-bg)")});`,
    `--card: var(--t-card, ${mixIn(dark ? 7 : 90, "var(--t-bg)")}); --card-hover: var(--t-card-hover, ${dark ? mixIn(10, "var(--t-bg)") : "color-mix(in srgb, var(--card) 70%, var(--t-bg))"});`,
    `--popover: var(--t-popover, ${dark ? mixIn(11, "var(--t-bg)") : "var(--card)"}); --input: var(--t-input, var(--card));`,
    `--muted: var(--t-muted, ${dark ? mixIn(20, "var(--t-bg)") : "color-mix(in srgb, black 3.5%, var(--t-bg))"});`,
    `--button: ${dark ? mixIn(7, "var(--t-bg)") : "var(--card)"}; --button-hover: ${dark ? mixIn(10, "var(--t-bg)") : "var(--card-hover)"};`,
    `--workspace-panel: ${dark ? "var(--panel)" : "var(--card)"}; --sidebar: var(--panel);`,
    "--surface-selected: color-mix(in srgb, var(--workspace-panel) 88%, var(--foreground)); --surface-hover: color-mix(in srgb, var(--workspace-panel) 94%, var(--foreground));",
    `--diff-add-wash: color-mix(in oklab, var(--card) ${dark ? 90 : 94}%, var(--diff-add)); --diff-del-wash: color-mix(in oklab, var(--card) ${dark ? 90 : 94}%, var(--diff-del));`,
    `color-scheme: ${dark ? "dark" : "light"};`,
  ].map(line => `  ${line}`).join("\n");
};

/** Full text of src/color-themes.css (generated; `color-themes.test.ts` fails when the file is stale). */
export function colorThemesCss(themes: readonly ThemePalette[] = COLOR_THEMES): string {
  const out = ["/* Generated from src/lib/color-themes.ts. Run `UPDATE_THEME_CSS=1 pnpm --filter @0/web exec vitest run test/color-themes.test.ts` to refresh. Do not edit by hand. */\n"];
  for (const theme of themes) {
    if (theme.light) out.push(block(`[data-color-theme="${theme.id}"]:not(.dark)`, theme.light));
    if (theme.dark) out.push(block(`[data-color-theme="${theme.id}"].dark`, theme.dark));
  }
  out.push(`/* Derived ladder, shared by every theme. Zero is absent from <html> (styles.css owns it) but cards preview it. */\n[data-color-theme]:not(.dark) {\n${DERIVED(false)}\n}\n[data-color-theme].dark {\n${DERIVED(true)}\n}\n`);
  return out.join("\n");
}
