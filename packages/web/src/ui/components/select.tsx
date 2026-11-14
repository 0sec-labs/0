import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";
import { buttonVariants } from "./button.js";

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };
export type SelectProps = {
  value: string; onValueChange: (value: string) => void; options: readonly SelectOption[];
  label?: string; placeholder?: string; disabled?: boolean; size?: "default" | "sm" | "lg"; className?: string; id?: string; name?: string; required?: boolean;
  "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string;
};
const EMPTY_OPTION = "__zero_empty_select_option__";

/** Base UI Select with the product control skin, adapted to the existing options API. */
export function Select({ value, onValueChange, options, className, label, placeholder, disabled, size = "default", name, required, ...props }: SelectProps) {
  let emptyOptionValue = EMPTY_OPTION;
  while (options.some(option => option.value === emptyOptionValue)) emptyOptionValue += "_";
  const encode = (option: string) => option === "" ? emptyOptionValue : option;
  const selected = value === "" && !options.some(option => option.value === "") ? null : encode(value);
  return <div className={cn("relative min-w-0", className)}>
    {label && <span className="mb-2 block text-sm font-medium">{label}</span>}
    <SelectPrimitive.Root value={selected} onValueChange={next => { if (next !== null) onValueChange(next === emptyOptionValue ? "" : String(next)); }} disabled={disabled} name={name} required={required}>
      <SelectPrimitive.Trigger {...props} aria-label={props["aria-label"] ?? label} data-slot="select-trigger"
        className={cn(buttonVariants({ variant: "outline", size }), "w-full min-w-0 justify-between gap-2 bg-[var(--button)] text-left font-medium shadow-none data-[placeholder]:text-muted-foreground [&>span:first-child]:truncate")}>
        <SelectPrimitive.Value placeholder={placeholder}>{() => options.find(option => option.value === value)?.label ?? placeholder}</SelectPrimitive.Value>
        <SelectPrimitive.Icon render={<ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-3" />} />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner alignItemWithTrigger={false} sideOffset={4} collisionPadding={12} className="z-[60] outline-none">
          <SelectPrimitive.Popup data-slot="select-content"
            className="ui-popup max-w-[calc(100vw-24px)] overscroll-contain max-h-[min(var(--available-height),28rem)] min-w-[var(--anchor-width)] origin-(--transform-origin) overflow-hidden rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] p-1 outline-none">
            <SelectPrimitive.ScrollUpArrow className="flex h-6 items-center justify-center"><ChevronUp aria-hidden="true" className="size-3.5" /></SelectPrimitive.ScrollUpArrow>
            <SelectPrimitive.List className="max-h-[inherit] overflow-y-auto scroll-fade-y scroll-my-1">
              {options.map(option => <SelectPrimitive.Item data-slot="select-item" key={option.value} value={encode(option.value)} disabled={option.disabled} className="relative flex min-h-[var(--h-menu-row,28px)] cursor-default select-none items-center gap-2 rounded-md py-1 pr-7 pl-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))]">
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2"><Check aria-hidden="true" className="size-(--icon-sm,14px)" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>)}
            </SelectPrimitive.List>
            <SelectPrimitive.ScrollDownArrow className="flex h-6 items-center justify-center"><ChevronDown aria-hidden="true" className="size-3.5" /></SelectPrimitive.ScrollDownArrow>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  </div>;
}
