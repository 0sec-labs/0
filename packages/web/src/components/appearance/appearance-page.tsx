import type { ReactNode } from "react";
import { FONT_SIZES } from "@/lib/appearance-model";
import { MOTION_OPTIONS, modesForTheme } from "@/lib/appearance-settings";
import { Switch } from "@/ui/components/switch";
import { cn } from "@/ui/lib/utils";
import { AccentSwatches } from "./accent-swatches";
import { BackdropTiles } from "./backdrop-tiles";
import { Segmented } from "./choice-group";
import { ModeTiles } from "./mode-tiles";
import { ThemePicker } from "./theme-gallery";
import { useAppearance, useResolvedMode } from "./use-appearance";

/** A titled card. The ids are the anchors the command palette, search and `/theme` link to (`#setting-web-...`). */
function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return <section id={id} tabIndex={-1} aria-labelledby={`${id}-heading`} data-slot="appearance-section" className="flex scroll-mt-6 flex-col gap-4 rounded-md border-[0.5px] border-border-1 bg-card p-4 outline-none focus-visible:outline-ring-inset lg:scroll-mt-60">
    <div><h2 id={`${id}-heading`} className="text-sm font-medium text-foreground">{title}</h2>{description ? <p className="text-sm text-muted-foreground-2">{description}</p> : null}</div>
    {children}
  </section>;
}

/** Two tiny transcripts that show what Compact transcript changes: the gap between turns. */
function DensityHint({ compact }: { compact: boolean }) {
  const sample = (tight: boolean, name: string) => <div data-density-sample={name} className={cn("flex min-w-0 flex-1 flex-col rounded-md border-[0.5px] border-border-2 bg-background p-2 text-2xs", tight ? "gap-1" : "gap-3", compact === tight && "ring-1 ring-primary")}>
    <span className="w-fit rounded-sm bg-secondary px-1.5 py-0.5">Triage the new findings</span>
    <span className="text-muted-foreground-1">Three need attention.</span>
    <span className="w-fit rounded-sm bg-secondary px-1.5 py-0.5">Fix the first one</span>
    <span className="text-muted-foreground-1">Opened a pull request.</span>
  </div>;
  return <div aria-hidden="true" className="flex gap-3">{sample(false, "comfortable")}{sample(true, "compact")}</div>;
}

/**
 * The one place to change how the console looks: Mode, Theme, Accent, Background, Text and layout, Motion.
 * Compact transcript follows the account (an engine setting), so the parent passes it in; `undefined` hides the switch.
 */
export function AppearancePage({ compact, onCompact }: { compact?: boolean; onCompact?: (next: boolean) => void }) {
  const { settings, set } = useAppearance();
  const resolved = useResolvedMode();
  const motionLine = "Slows or stops movement.";
  return <div className="flex flex-col gap-4" data-slot="appearance-page">
    <Section id="setting-web-theme" title="Mode">
      <ModeTiles value={settings.mode} themeId={settings.theme} modes={modesForTheme(settings.theme)} onChange={set.mode} />
    </Section>
    <Section id="setting-web-color-theme" title="Theme">
      <ThemePicker value={settings.theme} mode={resolved} onChange={set.theme} />
    </Section>
    <Section id="setting-web-accent" title="Accent">
      <AccentSwatches value={settings.accent} themeId={settings.theme} onChange={set.accent} />
    </Section>
    <Section id="setting-web-background" title="Background" description="Behind a new thread.">
      <BackdropTiles value={settings.background} onChange={set.background} />
    </Section>
    <Section id="setting-web-font-size" title="Text and layout">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-foreground">Font size</span><Segmented label="Font size" value={settings.fontSize} options={FONT_SIZES.map(size => ({ value: size.id, label: size.label }))} onChange={set.fontSize} /></div>
        {compact !== undefined && onCompact && <div id="setting-density" tabIndex={-1} className="flex scroll-mt-6 flex-col gap-3 outline-none lg:scroll-mt-60">
          <div className="flex items-center justify-between gap-3"><span className="text-sm text-foreground">Compact transcript</span><Switch aria-label="Compact transcript" checked={compact} onCheckedChange={onCompact} /></div>
          <DensityHint compact={compact} />
        </div>}
      </div>
    </Section>
    <Section id="setting-web-motion" title="Motion" description={motionLine}>
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm text-foreground">Reduce motion</span><Segmented label="Reduce motion" value={settings.motion} options={MOTION_OPTIONS} onChange={set.motion} /></div>
    </Section>
  </div>;
}
