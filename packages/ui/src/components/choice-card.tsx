import type { ComponentProps } from "react";
import { Check } from "lucide-react";
import { Button } from "./button.js";
import { cn } from "../lib/utils.js";

/** Large native toggle button: surface + check convey selection, focus uses a ring. */
export function ChoiceCard({ selected, children, className, type = "button", ...props }: Omit<ComponentProps<typeof Button>, "variant" | "asChild" | "aria-pressed"> & { selected: boolean }) {
  return <Button {...props} type={type} variant="ghost" aria-pressed={selected} data-selected={selected}
    className={cn("relative h-auto items-start justify-start gap-3 whitespace-normal rounded-[var(--radius-panel,16px)] border-0 bg-muted/20 p-4 pr-9 text-left font-normal active:scale-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background", selected ? "bg-[var(--surface-selected)] text-foreground hover:bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]", className)}>
    {children}
    {selected && <Check aria-hidden="true" className="pointer-events-none absolute right-3 top-3 size-4 text-foreground" />}
  </Button>;
}
