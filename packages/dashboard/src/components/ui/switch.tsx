import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type SwitchProps = Omit<ComponentProps<"button">, "onChange" | "aria-checked"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** Native button semantics support Enter and Space while exposing switch state. */
export function Switch({ checked, onCheckedChange, className, disabled, onClick, ...props }: SwitchProps) {
  return <button {...props} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={event => { onClick?.(event); if (!event.defaultPrevented) onCheckedChange(!checked); }} className={cn("relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground/40 disabled:cursor-not-allowed disabled:opacity-50", checked ? "bg-primary" : "bg-muted-foreground/35", className)}><span aria-hidden="true" className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none", checked && "translate-x-3")} /></button>;
}
