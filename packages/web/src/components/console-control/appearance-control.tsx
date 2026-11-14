import { Check } from "lucide-react";
import { ThemePreviewPicker } from "@/ui/components/theme-preview";
import { SegmentedControl } from "@/ui/components/segmented-control";
import { ACCENTS, FONT_SIZES, type Accent } from "@/lib/appearance-model";
import { useMotionPreference, useWebAccent, useWebFontSize } from "@/lib/web-appearance";
import { useWebTheme } from "@/lib/web-theme";
import { cn } from "@/ui/lib/utils";
import { SettingsRow } from "./settings-section";

/** Radio group of colour swatches. Each swatch carries its own `data-accent`, so styles.css supplies the colour. */
function AccentPicker({ value, onValueChange }: { value: Accent; onValueChange: (next: Accent) => void }) {
  return <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap justify-end gap-2">
    {ACCENTS.map((accent, index) => {
      const selected = accent.id === value;
      return <button key={accent.id} type="button" role="radio" aria-checked={selected} aria-label={accent.label} title={accent.label} tabIndex={selected ? 0 : -1}
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

/** Browser-only appearance rows: mode, accent, font size and motion. */
export function AppearanceRows() {
  const [theme, setTheme] = useWebTheme();
  const [accent, setAccent] = useWebAccent();
  const [fontSize, setFontSize] = useWebFontSize();
  const [motion, setMotion] = useMotionPreference();
  return <>
    <SettingsRow id="setting-web-theme" label="Theme"><ThemePreviewPicker label="Web appearance" value={theme} onValueChange={setTheme} options={[{ value: "system", label: "System", mode: "system" }, { value: "light", label: "Light", mode: "light" }, { value: "dark", label: "Dark", mode: "dark" }]} /></SettingsRow>
    <SettingsRow id="setting-web-accent" label="Accent colour" description="Buttons, links, focus rings and switches."><AccentPicker value={accent} onValueChange={setAccent} /></SettingsRow>
    <SettingsRow id="setting-web-font-size" label="Font size" description="Scales text and spacing across the app."><SegmentedControl label="Font size" value={fontSize} onValueChange={setFontSize} options={FONT_SIZES.map(size => ({ value: size.id, label: size.label }))} /></SettingsRow>
    <SettingsRow id="setting-web-motion" label="Reduce motion" description="System follows your device setting. On or Off overrides it."><SegmentedControl label="Reduce motion" value={motion} onValueChange={setMotion} options={[{ value: "system", label: "System" }, { value: "reduce", label: "On" }, { value: "full", label: "Off" }]} /></SettingsRow>
  </>;
}
