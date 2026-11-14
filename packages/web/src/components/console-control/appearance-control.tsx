import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { Button } from "@/ui/components/button";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { SwatchChip, ThemeGallery, usePreviewMode } from "@/components/appearance/theme-gallery";
import { DEFAULT_COLOR_THEME, forcedMode, getColorTheme } from "@/lib/color-themes";
import { useColorTheme } from "@/lib/color-theme";
import { ThemePreviewPicker } from "@/ui/components/theme-preview";
import { SegmentedControl } from "@/ui/components/segmented-control";
import { ACCENTS, FONT_SIZES, type Accent } from "@/lib/appearance-model";
import { useMotionPreference, useWebAccent, useWebFontSize } from "@/lib/web-appearance";
import { useWebTheme } from "@/lib/web-theme";
import { cn } from "@/ui/lib/utils";
import { SettingsRow } from "./settings-section";

/** Radio group of colour swatches. Each swatch carries its own `data-accent`, so styles.css supplies the colour. */
function AccentPicker({ value, onValueChange, disabled = false }: { value: Accent; onValueChange: (next: Accent) => void; disabled?: boolean }) {
  return <div role="radiogroup" aria-label="Accent colour" aria-disabled={disabled || undefined} className={cn("flex flex-wrap justify-end gap-2", disabled && "pointer-events-none opacity-50")}>
    {ACCENTS.map((accent, index) => {
      const selected = accent.id === value;
      return <button key={accent.id} type="button" role="radio" disabled={disabled} aria-checked={selected} aria-label={accent.label} title={accent.label} tabIndex={selected ? 0 : -1}
        onClick={() => onValueChange(accent.id)}
        onKeyDown={event => {
          const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length]!;
          onValueChange(next.id);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[(index + step + ACCENTS.length) % ACCENTS.length]?.focus();
        }}
        className={cn("grid size-7 cursor-pointer place-items-center rounded-full border-[0.5px] border-border-2 outline-none focus-visible:outline-ring-inset", selected && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-card")}>
        <span data-accent={accent.id} data-accent-swatch={accent.id} className="grid size-full place-items-center rounded-full bg-primary text-primary-foreground">{selected && <Check aria-hidden="true" className="size-3.5" />}</span>
      </button>;
    })}
  </div>;
}

/** The Theme row: current palette and a sheet with the full gallery (the same one Explore shows). */
function ColorThemeRow() {
  const [id] = useColorTheme();
  const [open, setOpen] = useState(false);
  const theme = getColorTheme(id);
  const mode = usePreviewMode(theme);
  return <>
    <SettingsRow id="setting-web-color-theme" label="Theme" description={`${theme.name} by ${theme.author}. Colour palettes for light and dark, saved in this browser.`}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="open-theme-gallery"><SwatchChip theme={theme} mode={mode} className="mr-1.5" />{theme.name}</Button>
    </SettingsRow>
    <SheetPanel open={open} onOpenChange={setOpen} title="Theme" description="Pick a palette. It applies at once and you can revert from the notification." className="data-[side=right]:sm:max-w-[760px]"
      footer={<Button variant="ghost" size="sm" render={<Link to="/plugins/explore?tab=themes" onClick={() => setOpen(false)} />}>Browse in Explore</Button>}>
      <ThemeGallery />
    </SheetPanel>
  </>;
}

/** Browser-only appearance rows: theme, mode, accent, font size and motion. */
export function AppearanceRows() {
  const [preference, setTheme] = useWebTheme();
  const [colorTheme] = useColorTheme();
  const palette = getColorTheme(colorTheme);
  const forced = forcedMode(palette);
  const themed = colorTheme !== DEFAULT_COLOR_THEME;
  const modes = [{ value: "system", label: "System", mode: "system" }, { value: "light", label: "Light", mode: "light" }, { value: "dark", label: "Dark", mode: "dark" }] as const;
  const theme = forced ?? preference;
  const [accent, setAccent] = useWebAccent();
  const [fontSize, setFontSize] = useWebFontSize();
  const [motion, setMotion] = useMotionPreference();
  return <>
    <ColorThemeRow />
    <SettingsRow id="setting-web-theme" label="Mode" description={forced ? `${palette.name} only comes in ${forced}.` : undefined}><ThemePreviewPicker label="Web appearance" value={theme} onValueChange={setTheme} options={forced ? modes.filter(option => option.value === forced) : modes} /></SettingsRow>
    <SettingsRow id="setting-web-accent" label="Accent colour" description={themed ? `${palette.name} sets its own accent. Choose the Zero theme to pick one.` : "Buttons, links, focus rings and switches."}><AccentPicker value={accent} onValueChange={setAccent} disabled={themed} /></SettingsRow>
    <SettingsRow id="setting-web-font-size" label="Font size" description="Scales text and spacing across the app."><SegmentedControl label="Font size" value={fontSize} onValueChange={setFontSize} options={FONT_SIZES.map(size => ({ value: size.id, label: size.label }))} /></SettingsRow>
    <SettingsRow id="setting-web-motion" label="Reduce motion" description="System follows your device setting. On or Off overrides it."><SegmentedControl label="Reduce motion" value={motion} onValueChange={setMotion} options={[{ value: "system", label: "System" }, { value: "reduce", label: "On" }, { value: "full", label: "Off" }]} /></SettingsRow>
  </>;
}
