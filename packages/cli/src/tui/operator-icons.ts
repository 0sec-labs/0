import { getSymbols, type SymbolKey, type SymbolTable } from "./symbols.js";

/**
 * Screen key → [symbol role key, title]. The glyph itself now lives in the
 * preset table (`symbols.ts`); this only maps a screen to the *role* whose
 * glyph it wears, so switching preset re-skins every screen icon at once. The
 * old inline literals (including the fullwidth `＋` launcher glyph, which
 * mis-measured against `.length`) are gone — `iconNew` is a single-cell `+` in
 * the default Unicode column.
 */
const SCREENS: Readonly<Record<string, readonly [SymbolKey, string]>> = {
  launcher: ["iconNew", "New engagement"],
  home: ["iconNew", "New engagement"],
  ops: ["iconOps", "Operations"],
  doctor: ["iconDoctor", "Diagnostics"],
  history: ["iconHistory", "Audit history"],
  findings: ["iconFindings", "Findings"],
  finding: ["iconFindings", "Finding details"],
  replay: ["iconReplay", "Replay"],
  settings: ["iconSettings", "Settings"],
  harness: ["iconHarness", "Tools and permissions"],
  herd: ["iconAgents", "Agents"],
  agents: ["iconAgents", "Agents"],
  audits: ["iconAudits", "Active audits"],
  market: ["iconMarket", "Hackstore"],
  connect: ["iconConnect", "Connections"],
  onboard: ["iconOnboard", "Getting started"],
  onboarding: ["iconOnboard", "Getting started"],
  models: ["iconModels", "Models"],
  model: ["iconModels", "Models"],
  resume: ["iconHistory", "Saved audits"],
  usage: ["iconUsage", "Usage"],
  session: ["iconAudits", "Engagement"],
  commands: ["iconHarness", "Commands"],
  shortcuts: ["iconShortcuts", "Keyboard shortcuts"],
  keybindings: ["iconShortcuts", "Keybindings"],
};

/**
 * The module-default table (Unicode). Lets `operatorIcon(screen)` keep its
 * one-argument shape for call sites that have no `symbols` in scope yet, while
 * still delivering the upgraded (heavier, width-safe) default glyphs. Call
 * sites that thread a live table via `useSymbols()` get preset switching.
 */
const DEFAULT_SYMBOLS = getSymbols("unicode");

/**
 * The screen's icon, drawn from the active glyph preset. Labels always
 * accompany the glyph at the call site, so an ASCII preset loses no meaning.
 * Fallback role for an unknown screen is `iconFindings` (the historical `◇`).
 */
export function operatorIcon(screen: string, symbols: SymbolTable = DEFAULT_SYMBOLS): string {
  const key = SCREENS[screen.toLowerCase()]?.[0] ?? "iconFindings";
  return symbols[key];
}

/**
 * Category heading → glyph role, for the section headers in the settings picker
 * and any other categorized dialog. Reuses existing preset-aware roles (so the
 * glyphs re-skin with the Symbols setting and stay single-cell/width-safe), and
 * returns `undefined` for an unmapped category — a dialog whose categories are
 * dynamic (a model picker's provider names) simply renders those headers bare.
 */
const CATEGORY_ICONS: Readonly<Record<string, SymbolKey>> = {
  display: "iconOps",
  transcript: "fieldFile",
  security: "fieldProtected",
  context: "fieldContext",
  motion: "iconReplay",
  privacy: "fieldEye",
  telemetry: "iconUsage",
  updates: "iconConnect",
  behaviour: "iconSettings",
  behavior: "iconSettings",
  general: "iconSettings",
};

/**
 * The glyph for a category heading, or `undefined` when the category has no
 * mapping. Labels always accompany it, so an ASCII preset loses no meaning.
 */
export function categoryIcon(category: string, symbols: SymbolTable = DEFAULT_SYMBOLS): string | undefined {
  const key = CATEGORY_ICONS[category.trim().toLowerCase()];
  return key ? symbols[key] : undefined;
}

export function operatorTitle(screen: string): string {
  return SCREENS[screen.toLowerCase()]?.[1] ?? screen;
}
