import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Disclosure } from "@/components/ui/disclosure";
import { ShimmerText } from "./shimmer-text";

/** A single keyboard-accessible work-log row: bright verb, dim object, muted trailing duration. */
export function ActivityRow({
  title,
  status,
  duration,
  running = false,
  shimmer = running,
  failed = false,
  children,
}: {
  title: string;
  status: string;
  duration?: string;
  running?: boolean;
  /** Only the one active row of a live turn shimmers; running rows behind it stay plain. */
  shimmer?: boolean;
  failed?: boolean;
  children: ReactNode;
}) {
  const space = title.indexOf(" ");
  const verb = space < 0 ? title : title.slice(0, space);
  const object = space < 0 ? "" : title.slice(space);
  return (
    <Disclosure
      className="group/row w-full min-w-0"
      data-running={running || undefined}
      triggerClassName="flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-inner,4px)] text-left text-sm font-medium text-muted-foreground-1 transition-colors hover:text-foreground"
      contentClassName="pt-1 pb-2 text-xs"
      summary={
        <>
          <span className="min-w-0 truncate" title={title}>
            <ShimmerText active={running && shimmer} className={running && shimmer ? undefined : running ? "text-muted-foreground-1" : "text-foreground"}>{verb}</ShimmerText>
            {object}
          </span>
          {duration && (
            <span className="flex-none text-xs font-normal tabular-nums text-muted-foreground-2">{duration}</span>
          )}
          {status && (
            <span
              className={`flex-none text-2xs font-normal ${failed ? "text-destructive" : "text-muted-foreground-2"}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {status}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 flex-none -rotate-90 text-muted-foreground-2 opacity-0 transition-[transform,opacity] motion-reduce:transition-none group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[expanded]/row:rotate-0 group-data-[expanded]/row:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </>
      }
    >
      {children}
    </Disclosure>
  );
}
