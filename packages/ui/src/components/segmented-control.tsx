import type { ReactNode } from "react";
import { Button } from "./button.js";
import { tabsListVariants, tabsTriggerClasses } from "./tabs.js";
import { cn } from "../lib/utils.js";

/** Exclusive options share the tab appearance without pretending to navigate panels. */
export function SegmentedControl<T extends string>({ label, value, onValueChange, options, className }: {
  label: string; value: T; onValueChange: (value: T) => void;
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  className?: string;
}) {
  return <div role="group" aria-label={label} className={cn(tabsListVariants(), "h-9 max-w-full overflow-x-auto justify-start", className)}>
    {options.map(option => <Button key={option.value} variant="ghost" size="sm" aria-pressed={value === option.value} data-state={value === option.value ? "active" : "inactive"} disabled={option.disabled} className={tabsTriggerClasses} onClick={() => onValueChange(option.value)}>{option.label}</Button>)}
  </div>;
}
