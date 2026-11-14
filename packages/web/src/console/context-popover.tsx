import type { ConsoleSessionSnapshot } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { ContextRing } from "@/components/ui/context-ring";
import { Popover } from "@/ui/components/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTokens } from "./format-tokens";
import { useDisplaySettings } from "@/lib/display-settings";

type ContextSnapshot = Pick<ConsoleSessionSnapshot, "contextInputTokens" | "contextWindowTokens" | "runtime">;

export function contextUsage(snapshot: ContextSnapshot) {
  const used = snapshot.contextInputTokens;
  const windowTokens = snapshot.contextWindowTokens ?? snapshot.runtime?.contextWindowTokens ?? undefined;
  const percent = used !== undefined && windowTokens ? Math.round((used / windowTokens) * 100) : undefined;
  return { used, windowTokens, percent };
}

/**
 * The snapshot exposes only total prompt tokens (no per-category breakdown) and no
 * compaction threshold, so the popover shows one segment and omits "Compact at".
 */
export function ContextPopover({ snapshot }: { snapshot: ContextSnapshot }) {
  const { showContextMeter } = useDisplaySettings();
  const { used, windowTokens, percent } = contextUsage(snapshot);
  if (!showContextMeter) return null;
  const label = percent === undefined ? "Context usage" : `Context usage: ${percent}% used`;
  const width = percent === undefined ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <Popover>
      <Tooltip content={label}>
        <Popover.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 shrink-0 text-muted-foreground-1 hover:text-foreground"
              aria-label="Context usage"
            />
          }
        >
          <ContextRing percent={percent} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Content side="top" align="end" className="w-[330px] max-w-[calc(100vw-16px)] gap-3 p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground">Context</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {used === undefined
              ? "No usage yet"
              : windowTokens
                ? `${formatTokens(used)} / ${formatTokens(windowTokens)} used${percent === undefined ? "" : ` (${percent}%)`}`
                : `${formatTokens(used)} used`}
          </span>
        </div>
        {used !== undefined && windowTokens ? (
          <div
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={width}
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full bg-primary" style={{ width: `${width}%` }} />
          </div>
        ) : null}
        {used !== undefined && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
              <span className="text-foreground">Conversation</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{formatTokens(used)}</span>
            </li>
          </ul>
        )}
      </Popover.Content>
    </Popover>
  );
}
