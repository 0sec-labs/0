import { COLOR_THEMES, constrainMode, type ThemeMode, type ThemePalette } from "@/lib/color-themes";
import { cn } from "@/ui/lib/utils";
import { ChoiceGroup } from "./choice-group";

/**
 * A static miniature of the app (sidebar, a message, the composer) built from the real tokens. The palette's variables come
 * from `[data-color-theme]` rules on this element, so the card previews any theme inside any other. Sizes are `em`, scaled by
 * the card width (`cqw`), so it needs no images or measuring.
 */
export function ThemePreviewMock({ theme, mode, className }: { theme: ThemePalette; mode: ThemeMode; className?: string }) {
  return <div aria-hidden="true" inert data-theme-preview={mode} data-color-theme={theme.id} className={cn("pointer-events-none relative aspect-[3/2] w-full select-none overflow-hidden bg-background text-foreground [container-type:inline-size]", mode === "dark" && "dark", className)}>
    <div className="flex h-full" style={{ fontSize: "1.9cqw", lineHeight: 1.35 }}>
      <div className="flex w-[27%] flex-col gap-[.5em] border-r-[0.5px] border-border-1 bg-panel p-[1em]">
        <div className="mb-[.5em] flex items-center gap-[.6em] font-medium"><span className="size-[1.5em] rounded-[.4em] bg-primary" />Zero</div>
        <div className="rounded-[.4em] bg-secondary px-[.8em] py-[.4em] font-medium">Threads</div>
        <div className="px-[.8em] py-[.4em] text-muted-foreground-1">Findings</div>
        <div className="px-[.8em] py-[.4em] text-muted-foreground-1">Settings</div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[1em] p-[1.4em]">
        <div className="max-w-[80%] self-end rounded-[.6em] bg-secondary px-[1em] py-[.6em]">Triage the new findings</div>
        <div className="flex flex-col gap-[.5em]">
          <div className="text-muted-foreground-1">Three need attention. See <span className="text-primary-ink">the report</span>.</div>
          <div className="h-[.5em] w-[88%] rounded-full bg-muted-foreground-3 opacity-60" />
          <div className="h-[.5em] w-[62%] rounded-full bg-muted-foreground-3 opacity-60" />
        </div>
        <div className="mt-auto flex items-center justify-between rounded-[.7em] border-[0.5px] border-border-2 bg-card px-[1em] py-[.8em] shadow-composer">
          <span className="text-muted-foreground-2">Ask anything</span>
          <span className="grid size-[1.9em] place-items-center rounded-full bg-primary text-primary-foreground"><span className="size-[.7em] rounded-[.15em] bg-primary-foreground" /></span>
        </div>
      </div>
    </div>
  </div>;
}

/** Cards that each show a real miniature of the app in that theme's own colours (in the mode now showing). */
export function ThemePicker({ value, mode, onChange }: { value: string; mode: ThemeMode; onChange: (id: string) => void }) {
  return <ChoiceGroup label="Theme" value={value} options={COLOR_THEMES.map(theme => ({ value: theme.id, label: theme.name }))} onChange={onChange}
    className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" itemClassName="group flex min-w-0 flex-col gap-1.5 rounded-md text-left">
    {(option, selected) => {
      const theme = COLOR_THEMES.find(item => item.id === option.value)!;
      return <>
        <span className={cn("block overflow-hidden rounded-md border-[0.5px] border-border-2 transition-shadow duration-100 group-hover:shadow-overlay", selected && "ring-2 ring-primary ring-offset-2 ring-offset-card")}>
          <ThemePreviewMock theme={theme} mode={constrainMode(theme, mode)} />
        </span>
        <span className={cn("truncate text-xs text-foreground", selected && "font-medium")}>{theme.name}</span>
      </>;
    }}
  </ChoiceGroup>;
}
