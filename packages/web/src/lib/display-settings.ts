import { useSyncExternalStore } from "react";

/** Engine display preferences that the browser UI has a real equivalent for. Everything else stays terminal-only. */
export type DisplaySettings = {
  density: "comfortable" | "compact";
  transcriptDetail: "collapsed" | "expanded";
  toolCardStyle: "visible" | "hidden";
  showSubagents: boolean;
  showTimestamps: boolean;
  elapsedTimer: boolean;
  showCost: boolean;
  showTokenUsage: boolean;
  showContextMeter: boolean;
};
/** Mirrors the engine defaults so the UI is correct before settings load and in tests. */
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { density: "comfortable", transcriptDetail: "collapsed", toolCardStyle: "visible", showSubagents: true, showTimestamps: false, elapsedTimer: true, showCost: true, showTokenUsage: true, showContextMeter: true };

const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
export function readDisplaySettings(settings: Record<string, unknown> | undefined): DisplaySettings {
  const d = DEFAULT_DISPLAY_SETTINGS;
  if (!settings) return d;
  return {
    density: settings.density === "compact" ? "compact" : "comfortable",
    transcriptDetail: settings.transcriptDetail === "expanded" ? "expanded" : "collapsed",
    toolCardStyle: settings.toolCardStyle === "hidden" ? "hidden" : "visible",
    showSubagents: bool(settings.showSubagents, d.showSubagents),
    showTimestamps: bool(settings.showTimestamps, d.showTimestamps),
    elapsedTimer: settings.elapsedTimer === "off" ? false : true,
    showCost: bool(settings.showCost, d.showCost),
    showTokenUsage: bool(settings.showTokenUsage, d.showTokenUsage),
    showContextMeter: bool(settings.showContextMeter, d.showContextMeter),
  };
}

let current = DEFAULT_DISPLAY_SETTINGS;
const listeners = new Set<() => void>();
function applyAttributes(value: DisplaySettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = value.density;
  root.dataset.showSubagents = String(value.showSubagents);
  root.dataset.showTimestamps = String(value.showTimestamps);
}
/** Called with the engine settings whenever they load or change; unchanged values do not notify. */
export function publishDisplaySettings(settings: Record<string, unknown> | undefined) {
  const next = readDisplaySettings(settings);
  if (JSON.stringify(next) === JSON.stringify(current)) { applyAttributes(next); return; }
  current = next;
  applyAttributes(next);
  listeners.forEach(listener => listener());
}
export function useDisplaySettings(): DisplaySettings {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => DEFAULT_DISPLAY_SETTINGS);
}
