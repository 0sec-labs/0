import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

type SwitchProps = Omit<ComponentProps<"button">, "onChange" | "aria-checked"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** Native button semantics support Enter and Space while exposing switch state. */
export function Switch({ checked, onCheckedChange, className, disabled, onClick, ...props }: SwitchProps) {
  return <button {...props} data-slot="switch" type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={event => { onClick?.(event); if (!event.defaultPrevented) onCheckedChange(!checked); }} className={cn("relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors duration-[var(--ui-duration-fast,120ms)] motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground/40 disabled:cursor-not-allowed disabled:opacity-50", checked ? "bg-[var(--switch-on)]" : "bg-muted-foreground/35", className)}><span aria-hidden="true" className={cn("absolute left-0.5 top-0.5 size-4 rounded-full shadow-sm transition-[transform,background-color] duration-[var(--ui-duration-fast,120ms)] motion-reduce:transition-none", checked ? "translate-x-3 bg-[var(--switch-thumb-on)]" : "bg-white")} /></button>;
}
