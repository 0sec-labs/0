import { cn } from "@/lib/utils";
import { SEVERITY_LABELS, STATUS_LABEL, type FindingStatus, type SeverityLevel } from "./findings-model";

/** Severity as a priority glyph: critical = red square with "!", high/medium/low = 3/2/1 filled bars, info = dashed. */
export function SeverityIcon({ severity, className }: { severity: SeverityLevel; className?: string }) {
  const filled = severity === "high" ? 3 : severity === "medium" ? 2 : severity === "low" ? 1 : 0;
  const tone = severity === "critical" ? "text-destructive" : severity === "high" ? "text-warning-foreground" : "text-muted-foreground-1";
  return (
    <svg role="img" aria-label={`${SEVERITY_LABELS[severity]} severity`} viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", tone, className)}>
      {severity === "critical" ? (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
          <rect x="7.1" y="4" width="1.8" height="5.2" rx=".9" fill="var(--background)" />
          <circle cx="8" cy="11.4" r="1" fill="var(--background)" />
        </>
      ) : severity === "info" ? (
        <path d="M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2.6" opacity=".7" />
      ) : (
        [0, 1, 2].map(index => <rect key={index} x={2 + index * 4.5} y={13 - (index + 1) * 3.4} width="3" height={(index + 1) * 3.4} rx=".8" fill="currentColor" opacity={index < filled ? 1 : 0.25} />)
      )}
    </svg>
  );
}

const RING = <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />;

/** Status as a circle glyph: dashed = backlog, empty = todo, pies = review/in progress, "!" = blocked, check = done, X = cancelled. */
export function StatusIcon({ status, className }: { status: FindingStatus; className?: string }) {
  const tone = {
    backlog: "text-muted-foreground-2", todo: "text-muted-foreground-1", agent_review: "text-muted-foreground-1", in_progress: "text-warning-foreground",
    human_review: "text-primary-text", blocked: "text-destructive", done: "text-success", cancelled: "text-muted-foreground-2",
  }[status];
  return (
    <svg role="img" aria-label={STATUS_LABEL[status]} viewBox="0 0 14 14" className={cn("size-3.5 shrink-0", tone, className)}>
      {status === "backlog" ? <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.2" />
        : status === "todo" ? RING
        : status === "agent_review" ? <>{RING}<path d="M7 7V4.5A2.5 2.5 0 0 1 9.5 7Z" fill="currentColor" /></>
        : status === "in_progress" ? <>{RING}<path d="M7 7V4.5A2.5 2.5 0 0 1 7 9.5Z" fill="currentColor" /></>
        : status === "human_review" ? <>{RING}<path d="M7 7V4.5A2.5 2.5 0 1 1 4.5 7Z" fill="currentColor" /></>
        : status === "blocked" ? <>{RING}<rect x="6.3" y="3.6" width="1.4" height="4" rx=".7" fill="currentColor" /><circle cx="7" cy="9.6" r=".85" fill="currentColor" /></>
        : status === "done" ? <><circle cx="7" cy="7" r="6" fill="currentColor" /><path d="M4.4 7.2l1.9 1.9 3.3-3.7" fill="none" stroke="var(--background)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>
        : <>{RING}<path d="M5.1 5.1l3.8 3.8M8.9 5.1L5.1 8.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>}
    </svg>
  );
}
