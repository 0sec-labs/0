import { Select as KumoSelect } from "@cloudflare/kumo";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean };
export type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  required?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

/** Shared styled select: Base UI supplies focus, typeahead and portal positioning. */
export function Select({ value, onValueChange, options, className, label, ...props }: SelectProps) {
  return <div className={cn("relative min-w-0", className)}>
    {label && <span className="mb-2 block text-sm font-medium">{label}</span>}
    <div className="relative">
      <KumoSelect<string>
        {...props}
        aria-label={props["aria-label"] ?? label}
        value={value}
        onValueChange={next => { if (next !== null) onValueChange(next); }}
        items={options.map(option => ({ value: option.value, label: option.label }))}
        renderValue={selected => options.find(option => option.value === selected)?.label ?? selected}
        alignItemWithTrigger={false}
        sideOffset={6}
        className="!h-10 !w-full !min-w-0 !justify-between !rounded-xl !border !border-[var(--field-border)] !bg-[var(--field-surface)] !px-3 !pr-9 !text-sm !font-normal !text-foreground !shadow-none !ring-0 hover:!bg-muted focus-visible:!outline focus-visible:!outline-1 focus-visible:!outline-offset-2 focus-visible:!outline-foreground/40 [&>span:last-child]:hidden"
      >
        {options.map(option => <KumoSelect.Option key={option.value} value={option.value} disabled={option.disabled} className="!mx-1.5 !min-h-9 !gap-3 !rounded-xl !px-3 !py-2 !text-sm !leading-5 !text-foreground data-highlighted:!bg-muted !ring-0 [&_svg]:size-4">{option.label}</KumoSelect.Option>)}
      </KumoSelect>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  </div>;
}
