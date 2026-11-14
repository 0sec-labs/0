import * as SelectPrimitive from "@radix-ui/react-select";
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

/** Radix interaction and product control skin, adapted to the existing options API. */
export function Select({ value, onValueChange, options, className, label, placeholder, disabled, size = "default", name, required, ...props }: SelectProps) {
  let emptyOptionValue = EMPTY_OPTION;
  while (options.some(option => option.value === emptyOptionValue)) emptyOptionValue += "_";
  const encode = (option: string) => option === "" ? emptyOptionValue : option;
  const selected = value === "" && !options.some(option => option.value === "") ? "" : encode(value);
  return <div className={cn("relative min-w-0", className)}>
    {label && <span className="mb-2 block text-sm font-medium">{label}</span>}
    <SelectPrimitive.Root value={selected} onValueChange={next => onValueChange(next === emptyOptionValue ? "" : next)} disabled={disabled} name={name} required={required}>
      <SelectPrimitive.Trigger {...props} aria-label={props["aria-label"] ?? label} data-slot="select-trigger"
        className={cn(buttonVariants({ variant: "outline", size }), "w-full min-w-0 justify-between gap-2 bg-[var(--field-surface)] text-left font-normal shadow-none data-[placeholder]:text-muted-foreground [&>span:first-child]:truncate")}>
        <SelectPrimitive.Value placeholder={placeholder}>{options.find(option => option.value === value)?.label}</SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content data-slot="select-content" style={{ maxHeight: "min(var(--radix-select-content-available-height), 28rem)" }} position="popper" sideOffset={6} collisionPadding={12}
          className="ui-menu-surface z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] origin-[var(--radix-select-content-transform-origin)] overflow-hidden rounded-[var(--radius-menu,12px)] border-[length:var(--ui-frame-border-width,1px)] border-border bg-popover p-1 text-popover-foreground shadow-[var(--ui-panel-shadow,0_8px_24px_rgb(0_0_0_/_16%))] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:zoom-out-95 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=open]:duration-200 motion-safe:data-[state=closed]:duration-150">
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUp aria-hidden="true" className="size-3.5" /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="scroll-my-1">
            {options.map(option => <SelectPrimitive.Item data-slot="select-item" key={option.value} value={encode(option.value)} disabled={option.disabled} className="ui-menu-item relative flex cursor-default select-none items-center pr-7 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
              <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator className="absolute right-2"><Check aria-hidden="true" className="size-3.5" /></SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDown aria-hidden="true" className="size-3.5" /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  </div>;
}
