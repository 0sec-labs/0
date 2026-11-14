import type { CSSProperties, KeyboardEvent } from "react";
import { cn } from "../lib/utils.js";

type PreviewMode = "light" | "dark" | "system";
const palettes: Record<"light" | "dark", Record<string, string>> = {
  light: { "--pv-bg": "#f1f1f3", "--pv-panel": "#ffffff", "--pv-card": "#ffffff", "--pv-secondary": "rgb(0 0 0 / 0.09)", "--pv-border-1": "rgb(0 0 0 / 0.08)", "--pv-border-2": "rgb(0 0 0 / 0.12)", "--pv-muted": "rgb(0 0 0 / 0.28)", "--pv-primary": "var(--primary)" },
  dark: { "--pv-bg": "#09090a", "--pv-panel": "#121214", "--pv-card": "#1b1b1e", "--pv-secondary": "rgb(255 255 255 / 0.1)", "--pv-border-1": "rgb(255 255 255 / 0.08)", "--pv-border-2": "rgb(255 255 255 / 0.12)", "--pv-muted": "rgb(255 255 255 / 0.3)", "--pv-primary": "var(--primary)" },
};

/** Miniature app window. Every size is a percentage, so it scales to any tile and is decorative only. */
export function ThemePreview({ mode, className }: { mode: PreviewMode; className?: string }) {
  if (mode === "system") return <span aria-hidden="true" data-theme-preview="system" className={cn("relative block h-full w-full", className)}>
    <ThemePreview mode="light" className="absolute inset-0" />
    <ThemePreview mode="dark" className="absolute inset-0 [clip-path:inset(0_0_0_50%)]" />
  </span>;
  return <span aria-hidden="true" data-theme-preview={mode} style={palettes[mode] as CSSProperties} className={cn("relative flex h-full w-full bg-(--pv-bg)", className)}>
    <span className="flex w-[22%] flex-col p-[4%]"><span className="block h-[9%] w-full rounded-[1px] bg-(--pv-secondary)" /></span>
    <span className="my-[5%] mr-[4%] flex flex-1 flex-col gap-[6%] rounded-[3px] border-[0.5px] border-(--pv-border-1) bg-(--pv-panel) p-[6%]">
      <span className="block h-1.5 w-[42%] self-end rounded-full bg-(--pv-secondary)" />
      <span className="block h-0.5 w-[72%] rounded-full bg-(--pv-muted)" />
      <span className="block h-0.5 w-[48%] rounded-full bg-(--pv-muted)" />
      <span className="mt-auto flex h-[26%] items-center justify-end rounded-[3px] border-[0.5px] border-(--pv-border-2) bg-(--pv-card) pr-[4%]"><span className="block size-1.5 rounded-full bg-(--pv-primary)" /></span>
    </span>
  </span>;
}

/** Radio group of preview tiles with roving tabindex and arrow-key selection. */
export function ThemePreviewPicker<T extends string>({ label, value, onValueChange, options, className }: {
  label: string; value: T; onValueChange: (value: T) => void;
  options: readonly { value: T; label: string; mode: PreviewMode }[];
  className?: string;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length]!;
    onValueChange(next.value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons?.[(index + step + options.length) % options.length]?.focus();
  };
  return <div role="radiogroup" aria-label={label} className={cn("flex items-start gap-2 sm:gap-3", className)}>
    {options.map((option, index) => {
      const selected = option.value === value;
      return <button key={option.value} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} onClick={() => onValueChange(option.value)} onKeyDown={event => move(event, index)}
        className="group/theme flex w-[4.5rem] sm:w-20 cursor-pointer flex-col items-center gap-2 rounded-lg outline-none focus-visible:outline-ring-inset">
        <span className={cn("block aspect-[4/3] w-full overflow-hidden rounded-lg border transition-colors duration-100", selected ? "border-primary border-[1.5px]" : "border-[0.5px] border-border-2 group-hover/theme:border-foreground/30")}><ThemePreview mode={option.mode} /></span>
        <span className={cn("text-xs", selected ? "font-medium text-foreground" : "text-muted-foreground-1")}>{option.label}</span>
      </button>;
    })}
  </div>;
}
