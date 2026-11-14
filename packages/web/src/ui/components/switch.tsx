import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../lib/utils.js";

type SwitchProps = Omit<ComponentProps<"button">, "onChange" | "aria-checked" | "children"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** Base UI switch semantics with the product's orange enabled state. */
export function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return <SwitchPrimitive.Root {...(props as object)} data-slot="switch" checked={checked} disabled={disabled} onCheckedChange={next => onCheckedChange(next)}
    className={cn("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border-[0.5px] border-border-2 p-[1.5px] bg-muted pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-x-1/2 pointer-coarse:after:-translate-y-1/2 pointer-coarse:after:content-[''] transition-colors duration-[var(--ui-duration-fast)] outline-none motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[checked]:bg-[var(--switch-on)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50", className)}>
    <SwitchPrimitive.Thumb className="block size-3 rounded-full bg-white shadow-sm transition-[translate,background-color] duration-[var(--ui-duration-fast)] motion-reduce:transition-none data-[checked]:translate-x-3 " />
  </SwitchPrimitive.Root>;
}
