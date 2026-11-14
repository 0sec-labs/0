import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/ui/components/button";
import { toast } from "@/ui/components/toast";
import { COLOR_THEMES, THEMES_PAGE_SIZE, constrainMode, filterColorThemes, paginateThemes, swatches, type ThemeMode, type ThemePalette } from "@/lib/color-themes";
import { getColorThemeId, setColorTheme, useColorTheme } from "@/lib/color-theme";
import { resolveTheme } from "@/lib/appearance-model";
import { useWebTheme } from "@/lib/web-theme";
import { cn } from "@/ui/lib/utils";

/**
 * A static miniature of the app (sidebar, a message, the composer) built from the real tokens. The palette's variables come
 * from `[data-color-theme]` rules on this element, so the card previews any theme inside any other. Sizes are `em`, scaled by
 * the card width (`cqw`), so it needs no images or measuring.
 */
export function ThemePreviewMock({ theme, mode, className }: { theme: ThemePalette; mode: ThemeMode; className?: string }) {
  return <div aria-hidden="true" inert data-theme-preview={mode} data-color-theme={theme.id} className={cn("pointer-events-none relative aspect-[16/10] w-full select-none overflow-hidden bg-background text-foreground [container-type:inline-size]", mode === "dark" && "dark", className)}>
    <div className="flex h-full" style={{ fontSize: "1.9cqw", lineHeight: 1.35 }}>
      <div className="flex w-[27%] flex-col gap-[.5em] border-r-[0.5px] border-border-1 bg-panel p-[1em]">
        <div className="mb-[.5em] flex items-center gap-[.6em] font-medium"><span className="size-[1.5em] rounded-[.4em] bg-primary" />Zero</div>
        <div className="rounded-[.4em] bg-secondary px-[.8em] py-[.4em] font-medium">Missions</div>
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

/** 2x2 swatch chip: background, panel, foreground, primary. */
export function SwatchChip({ theme, mode, className }: { theme: ThemePalette; mode: ThemeMode; className?: string }) {
  const s = swatches(theme, mode);
  return <span aria-hidden="true" data-swatch-chip={theme.id} className={cn("grid size-5 shrink-0 grid-cols-2 overflow-hidden rounded-[5px] border-[0.5px] border-border-3", className)}>
    {[s.bg, s.panel, s.fg, s.primary].map((color, index) => <span key={index} style={{ background: color }} />)}
  </span>;
}

/** The mode a card should show: the app's current light/dark mode unless the palette supports only one. */
export function usePreviewMode(theme: ThemePalette): ThemeMode {
  const [preference] = useWebTheme();
  const systemDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  return constrainMode(theme, resolveTheme(preference, systemDark));
}

function ThemeCard({ theme, active, onSelect }: { theme: ThemePalette; active: boolean; onSelect: (theme: ThemePalette) => void }) {
  const mode = usePreviewMode(theme);
  return <li>
    <button type="button" aria-pressed={active} aria-label={`${theme.name} by ${theme.author}${active ? ", active" : ""}`} data-theme-card={theme.id} onClick={() => onSelect(theme)}
      className="group flex w-full min-w-0 cursor-pointer flex-col gap-3 rounded-xl text-left outline-none focus-visible:outline-ring-inset">
      <span className={cn("relative block overflow-hidden rounded-xl border-[0.5px] border-border-1 transition-shadow duration-100 group-hover:shadow-overlay", active && "ring-2 ring-primary ring-offset-2 ring-offset-background")}>
        <ThemePreviewMock theme={theme} mode={mode} />
        {active && <span data-theme-active className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Check aria-hidden="true" className="size-3" strokeWidth={3} /></span>}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-0.5">
        <SwatchChip theme={theme} mode={mode} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{theme.name}</span>
        <span className="min-w-0 max-w-[45%] truncate text-sm text-muted-foreground-2">{theme.author}</span>
      </span>
    </button>
  </li>;
}

/** Applies a theme at once and offers to undo it. */
export function applyColorThemeWithUndo(theme: ThemePalette) {
  const previous = getColorThemeId();
  if (previous === theme.id) return;
  setColorTheme(theme.id);
  const before = COLOR_THEMES.find(item => item.id === previous);
  toast({ id: "color-theme", kind: "success", title: `Theme set to ${theme.name}`, durationMs: 6000, action: { label: "Revert", onClick: () => setColorTheme(previous) }, description: before ? `Was ${before.name}.` : undefined });
}

/** Grid of live-rendered theme cards. The pager only appears when more than eight match. */
export function ThemeGallery({ query = "", columns = 2, className }: { query?: string; columns?: 2 | 3; className?: string }) {
  const [active] = useColorTheme();
  const [requested, setPage] = useState(1);
  const matches = filterColorThemes(query);
  const { page, pages, items } = paginateThemes(matches, requested, THEMES_PAGE_SIZE);
  if (!matches.length) return <p role="status" className="py-10 text-center text-sm text-muted-foreground-1">No themes match that search.</p>;
  return <div className={cn("flex flex-col gap-6", className)}>
    <ul className={cn("grid grid-cols-1 gap-x-6 gap-y-8", columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2")}>
      {items.map(theme => <ThemeCard key={theme.id} theme={theme} active={theme.id === active} onSelect={applyColorThemeWithUndo} />)}
    </ul>
    {pages > 1 && <nav aria-label="Theme pages" className="flex items-center justify-between gap-3">
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
      <span className="text-xs text-muted-foreground-2 tabular-nums">{page} of {pages}</span>
      <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
    </nav>}
  </div>;
}
