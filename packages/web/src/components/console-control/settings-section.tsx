import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";

/** One heading and one divided surface for each preference group. `quiet` keeps the heading for assistive tech when the page title already names the group. `action` sits at the right of the heading. */
export function SettingsSection({ id, title, description, children, quiet = false, action }: { id: string; title: string; description?: string; children: ReactNode; quiet?: boolean; action?: ReactNode }) {
  const hidden = quiet && !description && !action;
  return <section id={id} aria-labelledby={`${id}-heading`} data-slot="settings-section" className="flex scroll-mt-6 flex-col gap-4">
    <div className={hidden ? "sr-only" : "flex items-end justify-between gap-4"}>
      <div className="flex min-w-0 flex-col gap-1.5"><h2 id={`${id}-heading`} className={quiet ? "sr-only" : "text-base leading-[1.2] font-medium text-foreground"}>{title}</h2>{description && <p className="text-sm font-normal text-muted-foreground-2">{description}</p>}</div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    <SettingsCard>{children}</SettingsCard>
  </section>;
}

/** Identical row geometry for browser preferences and engine-backed settings. */
export function SettingsRow({ id, label, description, badge, children }: { id?: string; label: ReactNode; description?: ReactNode; badge?: ReactNode; children?: ReactNode }) {
  return <SettingsCardRow id={id} tabIndex={id ? -1 : undefined} className={id ? "scroll-mt-6 outline-none focus-visible:outline-ring-inset focus-visible:outline-2" : undefined}>
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2"><h3 className="text-sm font-medium text-foreground">{label}</h3>{badge && <span className="text-sm text-muted-foreground-2">{badge}</span>}</div>{description && <p className="text-sm font-normal text-muted-foreground-2">{description}</p>}</div>
    <div data-slot="settings-row-control" className="flex min-w-0 shrink-0 items-center justify-end gap-2 [&_[data-slot=select-trigger]]:w-32 [&_[data-slot=select-trigger]]:text-xs">{children}</div>
  </SettingsCardRow>;
}

/** A whole row that navigates: icon tile, title with optional kind, subtitle, and a trailing value and chevron. */
export function SettingsLinkRow({ id, to, title, kind, subtitle, value, icon }: { id: string; to: string; title: string; kind?: string; subtitle?: string; value?: ReactNode; icon?: ReactNode }) {
  return <SettingsCardRow id={id} tabIndex={-1} className="relative scroll-mt-6 outline-none hover:bg-secondary/40 focus-within:bg-secondary/40">
    {icon && <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-(--radius-button) bg-secondary text-muted-foreground-1">{icon}</span>}
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2"><h3 className="text-sm font-medium text-foreground"><Link to={to} className="outline-none after:absolute after:inset-0 focus-visible:after:outline-ring-inset focus-visible:after:outline-2">{title}</Link></h3>{kind && <span className="text-sm text-muted-foreground-2">{kind}</span>}</div>{subtitle && <p className="text-sm font-normal text-muted-foreground-2">{subtitle}</p>}</div>
    <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground-2">{value}<ChevronRight aria-hidden="true" className="size-(--icon-sm)" /></div>
  </SettingsCardRow>;
}

/** Read-only label and value, for facts the engine reports rather than preferences. */
export function SettingsValueRow({ id, label, description, value }: { id: string; label: string; description?: string; value: ReactNode }) {
  return <SettingsRow id={id} label={label} description={description}><span className="text-sm tabular-nums text-muted-foreground-1">{value}</span></SettingsRow>;
}
