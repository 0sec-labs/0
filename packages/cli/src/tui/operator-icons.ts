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
  market: ["iconMarket", "Marketplace"],
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

export function operatorTitle(screen: string): string {
  return SCREENS[screen.toLowerCase()]?.[1] ?? screen;
}
