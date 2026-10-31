import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

/** One heading and one divided surface for each preference group. */
export function SettingsSection({ id, title, description, children, quiet = false }: { id: string; title: string; description?: string; children: ReactNode; quiet?: boolean }) {
  return <section id={id} aria-labelledby={`${id}-heading`} data-slot="settings-section" className="scroll-mt-6 space-y-2">
    <div className={quiet ? "sr-only" : "space-y-1"}><h2 id={`${id}-heading`} className="text-base font-medium">{title}</h2>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>
    <Card className="gap-0 py-0"><CardContent className="divide-y divide-border px-4 py-0">{children}</CardContent></Card>
  </section>;
}

/** Identical row geometry for browser preferences and engine-backed settings. */
export function SettingsRow({ id, label, description, badge, children }: { id: string; label: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return <div id={id} tabIndex={-1} data-slot="settings-row" className="grid scroll-mt-6 grid-cols-1 gap-x-6 gap-y-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center">
    <div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="text-sm font-medium">{label}</h3>{badge && <span className="text-xs text-muted-foreground">{badge}</span>}</div>{description && <p className="max-w-lg text-xs leading-5 text-muted-foreground">{description}</p>}</div>
    <div data-slot="settings-row-control" className="flex min-w-0 items-center justify-end gap-2 sm:w-48 [&_[data-slot=select-trigger]]:w-full">{children}</div>
  </div>;
}
