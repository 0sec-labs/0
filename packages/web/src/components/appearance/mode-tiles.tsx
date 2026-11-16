import { MODE_OPTIONS } from "@/lib/appearance-settings";
import type { ThemePreference } from "@/lib/appearance-model";
import { getColorTheme } from "@/lib/color-themes";
import { cn } from "@/ui/lib/utils";
import { ChoiceGroup } from "./choice-group";
import { ThemePreviewMock } from "./theme-gallery";

/** System, Light and Dark as small app thumbnails in the chosen theme; System is split half light, half dark. A one-mode theme offers only its own mode. */
export function ModeTiles({ value, themeId, modes, onChange }: { value: ThemePreference; themeId: string; modes: readonly ThemePreference[]; onChange: (next: ThemePreference) => void }) {
  const theme = getColorTheme(themeId);
  const shows = (mode: ThemePreference) => mode === "system" ? <>
    <ThemePreviewMock theme={theme} mode="light" className="absolute inset-0 aspect-auto" />
    <span className="absolute inset-y-0 right-0 w-1/2 overflow-hidden"><ThemePreviewMock theme={theme} mode="dark" className="absolute inset-y-0 right-0 aspect-auto h-full w-[200%] max-w-none" /></span>
  </> : <ThemePreviewMock theme={theme} mode={mode} className="absolute inset-0 aspect-auto" />;
  return <ChoiceGroup label="Mode" value={value} options={MODE_OPTIONS.filter(option => modes.includes(option.value))} onChange={onChange}
    className="flex flex-wrap gap-4" itemClassName="group flex w-28 flex-col gap-1.5 rounded-md text-left">
    {(option, selected) => <>
      <span className={cn("relative block aspect-[4/3] w-full overflow-hidden rounded-md border-[0.5px] border-border-2 transition-shadow duration-100 group-hover:shadow-overlay", selected && "ring-2 ring-primary ring-offset-2 ring-offset-card")}>{shows(option.value)}</span>
      <span className={cn("text-xs text-foreground", selected && "font-medium")}>{option.label}</span>
    </>}
  </ChoiceGroup>;
}
