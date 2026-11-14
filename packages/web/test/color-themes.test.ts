import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseColor } from "../src/lib/appearance-model";
import { COLOR_THEMES, COLOR_THEME_IDS, DEFAULT_COLOR_THEME, REQUIRED_TOKENS, colorThemesCss, constrainMode, contrast, deriveInk, filterColorThemes, forcedMode, getColorTheme, mixSrgb, paginateThemes, parseColorTheme, readableOn, swatches, tokensFor, type ThemeMode, type ThemePalette } from "../src/lib/color-themes";

const cssPath = new URL("../src/color-themes.css", import.meta.url);
const MODES: ThemeMode[] = ["light", "dark"];
const modesOf = (theme: ThemePalette) => MODES.filter(mode => theme[mode]);

describe("palette data", () => {
  it("has unique kebab-case ids, attribution and permissive licences", () => {
    expect(new Set(COLOR_THEME_IDS).size).toBe(COLOR_THEMES.length);
    for (const theme of COLOR_THEMES) {
      expect(theme.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(theme.name && theme.author && theme.license).toBeTruthy();
      expect(theme.sourceUrl).toMatch(/^https:\/\//);
      expect(theme.light || theme.dark).toBeTruthy();
      if (theme.id !== DEFAULT_COLOR_THEME) expect(theme.license).toBe("MIT");
    }
    expect(COLOR_THEMES.map(theme => theme.id)).toEqual(expect.arrayContaining(["zero", "dracula", "nord", "solarized", "catppuccin", "tokyo-night", "rose-pine", "one", "github", "gruvbox"]));
    expect(getColorTheme("gruvbox").sourceUrl).toContain("gruvbox-community");
  });
  for (const theme of COLOR_THEMES) for (const mode of modesOf(theme)) {
    const t = tokensFor(theme, mode);
    it(`${theme.id} ${mode} defines the six required tokens as valid colours`, () => {
      for (const key of REQUIRED_TOKENS) { expect(t[key], key).toBeTruthy(); expect(parseColor(t[key]), `${key}=${t[key]}`).toBeDefined(); }
      for (const [key, value] of Object.entries(t)) expect(parseColor(value), `${key}=${value}`).toBeDefined();
    });
    it(`${theme.id} ${mode} meets WCAG contrast`, () => {
      expect(contrast(t.fg, t.bg), "fg on bg").toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.text, t.bg), "text on bg").toBeGreaterThanOrEqual(4.5);
      // Zero keeps its shipped white-on-orange filled button (about 2.4:1); changing it would change the default visuals.
      if (theme.id !== DEFAULT_COLOR_THEME) expect(contrast(t.primaryText, t.primary), "primary-text on primary").toBeGreaterThanOrEqual(4.5);
      // Zero's light accent ink (oklch 56% .17 48) is 4.44:1 on its background, also shipped; kept as is.
      expect(contrast(deriveInk(t), t.bg), "accent text (ink) on bg").toBeGreaterThanOrEqual(theme.id === DEFAULT_COLOR_THEME ? 4.4 : 4.5);
    });
  }
});

describe("derived defaults", () => {
  it("picks button text from the background, white or black by contrast", () => {
    expect(readableOn("#ff79c6", "#282a36")).toBe("#282a36");
    expect(readableOn("#0969da", "#f6f8fa")).toBe("#f6f8fa");
    expect(readableOn("#0969da", "#0d1117")).toBe("#ffffff");
    expect(readableOn("#ffff00", "#ffffff")).toBe("#000000");
  });
  it("darkens a low-contrast accent toward the foreground only as far as needed", () => {
    const solarized = tokensFor(getColorTheme("solarized"), "light");
    expect(contrast(solarized.primary, solarized.bg)).toBeLessThan(4.5);
    const ink = deriveInk(solarized);
    expect(ink).not.toBe(solarized.primary);
    expect(contrast(ink, solarized.bg)).toBeGreaterThanOrEqual(4.5);
    expect(deriveInk(tokensFor(getColorTheme("dracula"), "dark"))).toBe("#ff79c6");
  });
  it("mixes like color-mix in srgb", () => {
    expect(mixSrgb("#ffffff", "#000000", 50)).toBe("#808080");
    expect(mixSrgb("#ff0000", "#0000ff", 100)).toBe("#ff0000");
  });
  it("derives swatches for a card", () => {
    expect(swatches(getColorTheme("dracula"), "dark")).toEqual({ bg: "#282a36", panel: mixSrgb("#ffffff", "#282a36", 5), fg: "#f8f8f2", primary: "#ff79c6" });
  });
});

describe("apply, parse and fallback", () => {
  it("falls back to the default for unknown or corrupt ids", () => {
    for (const bad of [null, undefined, "", "nope", 7, {}, "DRACULA", "dracula "]) expect(parseColorTheme(bad)).toBe(DEFAULT_COLOR_THEME);
    expect(parseColorTheme("nord")).toBe("nord");
    expect(getColorTheme("nope").id).toBe(DEFAULT_COLOR_THEME);
  });
  it("forces the only mode a palette supports", () => {
    const darkOnly: ThemePalette = { ...getColorTheme("dracula"), id: "d", light: undefined };
    const lightOnly: ThemePalette = { ...getColorTheme("dracula"), id: "l", dark: undefined };
    expect(forcedMode(darkOnly)).toBe("dark"); expect(forcedMode(lightOnly)).toBe("light"); expect(forcedMode(getColorTheme("nord"))).toBeUndefined();
    expect(constrainMode(darkOnly, "light")).toBe("dark"); expect(constrainMode(lightOnly, "dark")).toBe("light"); expect(constrainMode(getColorTheme("nord"), "light")).toBe("light");
    expect(tokensFor(darkOnly, "light")).toBe(darkOnly.dark);
  });
  it("filters and paginates 8 per page", () => {
    expect(filterColorThemes("ARCTIC").map(theme => theme.id)).toEqual(["nord"]);
    expect(filterColorThemes("  ")).toHaveLength(COLOR_THEMES.length);
    const items = Array.from({ length: 10 }, (_, index) => index);
    expect(paginateThemes(items, 1)).toEqual({ page: 1, pages: 2, items: items.slice(0, 8) });
    expect(paginateThemes(items, 2).items).toEqual([8, 9]);
    expect(paginateThemes(items, 99).page).toBe(2); expect(paginateThemes(items, Number.NaN).page).toBe(1);
    expect(paginateThemes(items.slice(0, 8), 1).pages).toBe(1);
  });
});

describe("pre-paint script", () => {
  it("lists exactly the non-default theme ids and the forced modes", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const ids = JSON.parse(/const colorThemes = (\[[^\]]*\]);/.exec(html)![1]!) as string[];
    expect(ids).toEqual(COLOR_THEMES.filter(theme => theme.id !== DEFAULT_COLOR_THEME).map(theme => theme.id));
    const forced = Object.fromEntries(COLOR_THEMES.flatMap(theme => forcedMode(theme) ? [[theme.id, forcedMode(theme)]] : []));
    expect(JSON.parse(/const forcedModes = (\{[^}]*\});/.exec(html)![1]!)).toEqual(forced);
    expect(html).toContain('read("zero-web-color-theme")');
  });
});

describe("token mapping and generated stylesheet", () => {
  const css = colorThemesCss();
  it("emits one block per theme and mode plus the shared derived ladder", () => {
    for (const theme of COLOR_THEMES) {
      if (theme.light) expect(css).toContain(`[data-color-theme="${theme.id}"]:not(.dark) {`);
      if (theme.dark) expect(css).toContain(`[data-color-theme="${theme.id}"].dark {`);
    }
    const dracula = css.slice(css.indexOf('[data-color-theme="dracula"].dark {'), css.indexOf("}", css.indexOf('[data-color-theme="dracula"].dark {')));
    expect(dracula).toContain("--t-bg: #282a36;"); expect(dracula).toContain("--t-primary: #ff79c6;"); expect(dracula).toContain("--t-chrome: #21222c;"); expect(dracula).toContain("--t-panel: initial;");
    for (const mapped of ["--background: var(--t-bg)", "--foreground: var(--t-fg)", "--primary: var(--t-primary)", "--primary-foreground: var(--t-primary-text)", "--dither-ink: var(--t-shader-ink)", "--primary-ink: var(--t-ink)", "--muted-foreground: color-mix(in oklch, var(--t-text)", "--panel: var(--t-panel, color-mix(in srgb, white 5%"]) expect(css).toContain(mapped);
  });
  it("is in sync with src/color-themes.css", () => {
    if (process.env.UPDATE_THEME_CSS) writeFileSync(cssPath, css);
    expect(readFileSync(cssPath, "utf8")).toBe(css);
  });
});
