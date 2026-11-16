import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export interface Choice<T extends string> { value: T; label: string }

/** Index the arrow keys move to inside a radiogroup (wraps); undefined for any other key. */
export function nextChoiceIndex(key: string, index: number, count: number): number | undefined {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  return step ? (index + step + count) % count : undefined;
}

/**
 * A keyboard radiogroup: one tab stop, arrows move and select, each option is a `role=radio` button.
 * Looks come from the class names and the render prop, so segmented controls, swatches, tiles and cards share it.
 */
export function ChoiceGroup<T extends string>({ label, value, options, onChange, className, itemClassName, selectedClassName, disabled = false, onActive, children }: {
  label: string; value: T; options: readonly Choice<T>[]; onChange: (next: T) => void; className?: string; itemClassName?: string; selectedClassName?: string; disabled?: boolean;
  /** Called with the option under the pointer or focus, and null when it leaves (tiles use it to start their animation). */
  onActive?: (value: T | null) => void;
  children: (option: Choice<T>, selected: boolean) => ReactNode;
}) {
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = nextChoiceIndex(event.key, index, options.length);
    if (at === undefined) return;
    event.preventDefault();
    onChange(options[at]!.value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[at]?.focus();
  };
  return <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cn(disabled && "pointer-events-none opacity-50", className)}>
    {options.map((option, index) => {
      const selected = option.value === value;
      return <button key={option.value} type="button" role="radio" disabled={disabled} aria-checked={selected} aria-label={option.label} data-choice={option.value} tabIndex={selected ? 0 : -1}
        onClick={() => onChange(option.value)} onKeyDown={onKeyDown(index)}
        onPointerEnter={() => onActive?.(option.value)} onPointerLeave={() => onActive?.(null)} onFocus={() => onActive?.(option.value)} onBlur={() => onActive?.(null)}
        className={cn("cursor-pointer outline-none focus-visible:outline-ring-inset", itemClassName, selected && selectedClassName)}>{children(option, selected)}</button>;
    })}
  </div>;
}

/** Joined text options (Small | Default | Large). */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly Choice<T>[]; onChange: (next: T) => void; disabled?: boolean }) {
  return <ChoiceGroup label={label} value={value} options={options} onChange={onChange} disabled={disabled}
    className="inline-flex w-fit gap-0.5 rounded-md border-[0.5px] border-border-2 bg-muted p-0.5"
    itemClassName="min-w-16 rounded-[5px] px-3 py-1 text-sm text-muted-foreground-1 hover:text-foreground"
    selectedClassName="bg-card font-medium text-foreground shadow-sm">
    {option => option.label}
  </ChoiceGroup>;
}
