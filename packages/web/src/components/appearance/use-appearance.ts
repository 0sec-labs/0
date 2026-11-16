import { useMemo } from "react";
import { type AppearanceSettings } from "@/lib/appearance-settings";
import { resolveTheme, type ResolvedTheme } from "@/lib/appearance-model";
import { useColorTheme } from "@/lib/color-theme";
import { constrainMode, getColorTheme } from "@/lib/color-themes";
import { useMotionPreference, useWebAccent, useWebBackground, useWebFontSize } from "@/lib/web-appearance";
import { useWebTheme } from "@/lib/web-theme";

/** The six browser preferences as one value, plus the setter for each. Reads and writes the same stores the rest of the app reads. */
export function useAppearance() {
  const [mode, setMode] = useWebTheme();
  const [theme, setTheme] = useColorTheme();
  const [accent, setAccent] = useWebAccent();
  const [background, setBackground] = useWebBackground();
  const [fontSize, setFontSize] = useWebFontSize();
  const [motion, setMotion] = useMotionPreference();
  const settings: AppearanceSettings = useMemo(() => ({ mode, theme, accent, background, fontSize, motion }), [mode, theme, accent, background, fontSize, motion]);
  return { settings, set: { mode: setMode, theme: setTheme, accent: setAccent, background: setBackground, fontSize: setFontSize, motion: setMotion } };
}

/** The light or dark palette actually showing now (the OS answer when the mode is System, and a one-mode theme wins). */
export function useResolvedMode(): ResolvedTheme {
  const [mode] = useWebTheme();
  const [theme] = useColorTheme();
  const systemDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  return constrainMode(getColorTheme(theme), resolveTheme(mode, systemDark));
}
