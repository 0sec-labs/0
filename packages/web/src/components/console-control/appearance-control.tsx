import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/components/button";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { SwatchChip, ThemeGallery, usePreviewMode } from "@/components/appearance/theme-gallery";
import { DEFAULT_COLOR_THEME, forcedMode, getColorTheme } from "@/lib/color-themes";
import { useColorTheme } from "@/lib/color-theme";
import { Select } from "@/ui/components/select";
import { ACCENTS, BACKDROPS, FONT_SIZES, type Accent, type BackdropKind } from "@/lib/appearance-model";
import { Backdrop } from "@/ui/backdrops";
import { useMotionPreference, useWebAccent, useWebBackground, useWebFontSize } from "@/lib/web-appearance";
import { useWebTheme } from "@/lib/web-theme";
import { cn } from "@/ui/lib/utils";
import { SettingsRow } from "./settings-section";
import { SettingsCardRow } from "@/ui/components/settings-card";

/** Radio group of colour swatches. Each swatch carries its own `data-accent`, so styles.css supplies the colour. */
function AccentPicker({ value, onValueChange, disabled = false }: { value: Accent; onValueChange: (next: Accent) => void; disabled?: boolean }) {
  return <div role="radiogroup" aria-label="Accent color" aria-disabled={disabled || undefined} className={cn("flex flex-wrap justify-end gap-2", disabled && "pointer-events-none opacity-50")}>
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

/** Radio group of live mini-previews, one per backdrop. A tile animates only while hovered or focused; otherwise it is a still frame. */
function BackgroundPicker({ value, onValueChange }: { value: BackdropKind; onValueChange: (next: BackdropKind) => void }) {
  const [live, setLive] = useState<BackdropKind | null>(null);
  return <div role="radiogroup" aria-label="Background" className="grid w-full grid-cols-2 gap-3 sm:grid-cols-5">
    {BACKDROPS.map((item, index) => {
      const selected = item.id === value;
      return <button key={item.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} data-background={item.id}
        onClick={() => onValueChange(item.id)} onPointerEnter={() => setLive(item.id)} onPointerLeave={() => setLive(null)} onFocus={() => setLive(item.id)} onBlur={() => setLive(null)}
        onKeyDown={event => {
          const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const at = (index + step + BACKDROPS.length) % BACKDROPS.length;
          onValueChange(BACKDROPS[at]!.id);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[at]?.focus();
        }}
        className="group flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-md text-left outline-none focus-visible:outline-ring-inset">
        <span className={cn("relative block aspect-[16/10] w-full overflow-hidden rounded-md border-[0.5px] border-border-2 bg-panel transition-shadow duration-100 group-hover:shadow-overlay", selected && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-card")}>
          <Backdrop kind={item.id} preview playing={live === item.id} />
          {item.id === "none" && <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-xs text-muted-foreground-2">Off</span>}
          {selected && <span aria-hidden="true" className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-2.5" strokeWidth={3} /></span>}
        </span>
        <span className="truncate text-xs font-medium text-foreground">{item.label}</span>
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
    <SettingsRow id="setting-web-color-theme" label="Theme">
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="open-theme-gallery"><SwatchChip theme={theme} mode={mode} className="mr-1.5" />{theme.name}</Button>
    </SettingsRow>
    <SheetPanel open={open} onOpenChange={setOpen} title="Theme" className="data-[side=right]:sm:max-w-[760px]">
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
  const [background, setBackground] = useWebBackground();
  return <>
    <ColorThemeRow />
    <SettingsRow id="setting-web-theme" label="Mode"><Select aria-label="Mode" size="sm" className="w-auto min-w-32 shrink-0" value={theme} disabled={!!forced} onValueChange={value => setTheme(value as typeof theme)} options={(forced ? modes.filter(option => option.value === forced) : modes).map(option => ({ value: option.value, label: option.label }))} /></SettingsRow>
    <SettingsRow id="setting-web-accent" label="Accent color"><AccentPicker value={accent} onValueChange={setAccent} disabled={themed} /></SettingsRow>
    <SettingsRow id="setting-web-font-size" label="Font size"><Select aria-label="Font size" size="sm" className="w-auto min-w-32 shrink-0" value={fontSize} onValueChange={value => setFontSize(value as typeof fontSize)} options={FONT_SIZES.map(size => ({ value: size.id, label: size.label }))} /></SettingsRow>
    <SettingsCardRow id="setting-web-background" tabIndex={-1} className="scroll-mt-6 flex-col items-stretch gap-3 outline-none focus-visible:outline-ring-inset">
      <div><h3 className="text-sm font-medium text-foreground">Background</h3><p className="text-sm font-normal text-muted-foreground-2">The quiet animation behind a new thread. Hover a tile to see it move.</p></div>
      <BackgroundPicker value={background} onValueChange={setBackground} />
    </SettingsCardRow>
    <SettingsRow id="setting-web-motion" label="Reduce motion"><Select aria-label="Reduce motion" size="sm" className="w-auto min-w-32 shrink-0" value={motion} onValueChange={value => setMotion(value as typeof motion)} options={[{ value: "system", label: "System" }, { value: "reduce", label: "On" }, { value: "full", label: "Off" }]} /></SettingsRow>
  </>;
}
