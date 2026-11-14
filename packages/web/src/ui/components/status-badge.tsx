import type { ComponentProps, ReactNode } from "react";
import { Badge } from "./badge.js";
import { cn } from "../lib/utils.js";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const OUTLINE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground-1",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-sky-700 dark:text-sky-200",
  accent: "text-primary-text",
};

const DOT: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground-2",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-sky-500",
  accent: "bg-primary",
};

/**
 * The one status chip. `soft` is the tinted badge used for severities and run states; `outline` is the quiet
 * bordered pill used beside settings rows ("Connected", "Needs connection"). An optional dot or icon leads the label.
 */
export function StatusBadge({ tone = "neutral", appearance = "soft", dot = false, icon, className, children, ...props }: Omit<ComponentProps<"span">, "children"> & {
  tone?: StatusTone;
  appearance?: "soft" | "outline";
  dot?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const lead = <>{dot && <span aria-hidden="true" data-slot="status-dot" className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />}{icon}</>;
  if (appearance === "outline") {
    return <span data-slot="status-badge" data-tone={tone} className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border-[0.5px] border-border-2 bg-card px-2 text-xs", OUTLINE_TEXT[tone], className)} {...props}>{lead}{children}</span>;
  }
  return <Badge variant={tone} data-tone={tone} className={className} {...props}>{lead}{children}</Badge>;
}
