import type { ReactNode } from "react";
import { CapyAgentIcon, CapyPullRequestIcon, CapyRepositoriesIcon, CapyTerminalSparkleIcon, CapyEyeIcon } from "@/ui/icons/capy";
import { cn } from "@/lib/utils";
import type { AgentStatus, MockAgent } from "./fixtures";

export const AGENT_ICON = { pr: CapyPullRequestIcon, box: CapyRepositoriesIcon, scan: CapyTerminalSparkleIcon, overview: CapyEyeIcon } as const;

/** Rounded-md tile with the agent's glyph; neutral, no colour. */
export function AgentTile({ agent, size = "sm" }: { agent: Pick<MockAgent, "icon">; size?: "xs" | "sm" | "lg" }) {
  const Icon = AGENT_ICON[agent.icon] ?? CapyAgentIcon;
  return <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground-1", size === "xs" ? "size-5 [&_svg]:size-3" : size === "sm" ? "size-8 [&_svg]:size-4" : "size-12 [&_svg]:size-6")}><Icon /></span>;
}

/** Status glyph: running = rotating ring, needs you = amber dot, idle = green dot, paused = two bars. */
export function StatusGlyph({ status, className }: { status: AgentStatus; className?: string }) {
  const label = { running: "Working", "needs-you": "Needs you", idle: "Idle", paused: "Paused" }[status];
  if (status === "running") return <span role="img" aria-label={label} className={cn("inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground-3 border-t-foreground", className)} />;
  if (status === "paused") return <span role="img" aria-label={label} className={cn("inline-flex h-3 w-3 shrink-0 items-center justify-center gap-[2px]", className)}><i className="h-2.5 w-[2px] rounded-sm bg-muted-foreground-3" /><i className="h-2.5 w-[2px] rounded-sm bg-muted-foreground-3" /></span>;
  return <span role="img" aria-label={label} className={cn("inline-block size-2 shrink-0 rounded-full", status === "needs-you" ? "bg-amber-500" : "bg-emerald-500", className)} />;
}

/** "Needs you" marker: a rounded-md count, not a pill. */
export function NeedsYou({ count, long = false }: { count: number; long?: boolean }) {
  if (count <= 0) return null;
  return <span aria-label={`${count} need${count === 1 ? "s" : ""} you`} className="inline-flex h-4 shrink-0 items-center rounded-md bg-amber-500/15 px-1.5 text-[11px] leading-none font-semibold text-amber-700 tabular-nums dark:text-amber-300">{long ? `${count} needs you` : count}</span>;
}

export const chipClasses = "inline-flex h-6 items-center gap-1 rounded-md border-[0.5px] border-border-2 bg-secondary px-2 text-xs font-medium text-foreground";
export function Chip({ children, className }: { children: ReactNode; className?: string }) { return <span className={cn(chipClasses, className)}>{children}</span>; }

export const cardClasses = "rounded-(--radius-card) border-[0.5px] border-[var(--card-hairline)] bg-card";
export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className="space-y-3">
    <div className="flex min-h-7 items-center justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-medium">{title}</h2>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{actions}</div>
    {children}
  </section>;
}
