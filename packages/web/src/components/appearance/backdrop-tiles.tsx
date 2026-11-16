import { useState } from "react";
import { Check } from "lucide-react";
import { BACKDROPS, Backdrop, BackdropStill, type BackdropKind } from "@/ui/backdrops";
import { cn } from "@/ui/lib/utils";
import { ChoiceGroup } from "./choice-group";

/** An empty frame with a diagonal slash: the look of "no background". */
function NoneFrame() {
  return <svg aria-hidden="true" viewBox="0 0 160 100" preserveAspectRatio="none" className="absolute inset-0 size-full text-muted-foreground-3"><line x1="0" y1="100" x2="160" y2="0" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" /></svg>;
}

/**
 * One 16:10 tile per backdrop. Each shows a real frozen frame drawn by the same renderer as the live backdrop (boosted so it
 * reads at thumbnail size); hover or keyboard focus swaps in the live animation, which pauses again when the pointer leaves.
 */
export function BackdropTiles({ value, onChange }: { value: BackdropKind; onChange: (next: BackdropKind) => void }) {
  const [live, setLive] = useState<BackdropKind | null>(null);
  return <ChoiceGroup label="Background" value={value} options={BACKDROPS.map(item => ({ value: item.id, label: item.label }))} onChange={onChange} onActive={setLive}
    className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" itemClassName="group flex min-w-0 flex-col gap-1.5 rounded-md text-left">
    {(option, selected) => <>
      <span className={cn("relative block aspect-[16/10] w-full overflow-hidden rounded-md border-[0.5px] border-border-2 bg-background transition-shadow duration-100 group-hover:shadow-overlay", selected && "ring-2 ring-primary ring-offset-2 ring-offset-card")}>
        {option.value === "none" ? <NoneFrame /> : live === option.value ? <Backdrop kind={option.value} preview playing /> : <BackdropStill kind={option.value} variant="tile" />}
        {selected && <span aria-hidden="true" className="absolute top-1.5 right-1.5 grid size-4 place-items-center rounded-sm bg-primary text-primary-foreground"><Check className="size-2.5" strokeWidth={3} /></span>}
      </span>
      <span className={cn("truncate text-xs text-foreground", selected && "font-medium")}>{option.label}</span>
    </>}
  </ChoiceGroup>;
}
