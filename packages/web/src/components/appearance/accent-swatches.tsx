import { Check } from "lucide-react";
import { accentsForTheme } from "@/lib/appearance-settings";
import type { Accent } from "@/lib/appearance-model";
import { getColorTheme } from "@/lib/color-themes";
import { cn } from "@/ui/lib/utils";
import { ChoiceGroup } from "./choice-group";

/** Named accent swatches for the default theme. Any other theme sets its own colour, so it shows that one swatch, fixed. */
export function AccentSwatches({ value, themeId, onChange }: { value: Accent; themeId: string; onChange: (next: Accent) => void }) {
  const accents = accentsForTheme(themeId);
  if (!accents.length) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground-2" data-accent-fixed>
      <span aria-hidden="true" className="grid size-7 place-items-center rounded-md border-[0.5px] border-border-2 bg-primary text-primary-foreground"><Check className="size-3.5" /></span>
      {getColorTheme(themeId).name} sets its own accent. Pick Zero to choose one.
    </div>;
  }
  return <ChoiceGroup label="Accent color" value={value} options={accents.map(accent => ({ value: accent.id, label: accent.label }))} onChange={onChange} className="flex flex-wrap gap-4"
    itemClassName="group flex w-14 flex-col items-center gap-1.5 rounded-md">
    {(option, selected) => <>
      <span data-accent={option.value} className={cn("grid size-8 place-items-center rounded-md border-[0.5px] border-border-2 bg-primary text-primary-foreground", selected && "ring-2 ring-primary ring-offset-2 ring-offset-card")}>{selected && <Check aria-hidden="true" className="size-4" />}</span>
      <span className={cn("text-xs text-foreground", selected && "font-medium")}>{option.label}</span>
    </>}
  </ChoiceGroup>;
}
