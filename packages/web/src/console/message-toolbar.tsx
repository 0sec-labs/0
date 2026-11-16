import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, Copy, Link2, MoreHorizontal, Reply, FileText } from "lucide-react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { plainText, quoteBlock, toolbarActions } from "./transcript-actions";
import { cn } from "@/lib/utils";

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "12:16" today, "Mon 12:16" within the last week, otherwise "Mar 3, 12:16". */
export function formatStamp(iso: string | undefined, now = new Date()): string | undefined {
  const date = new Date(iso ?? "");
  if (!iso || Number.isNaN(date.getTime())) return undefined;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`;
}

/** Centered day/time stamp between turns. */
export function DayStamp({ iso }: { iso?: string }) {
  const label = formatStamp(iso);
  if (!label) return null;
  return (
    <div data-slot="chat-stamp" className="flex min-h-7 justify-center text-xs tabular-nums text-muted-foreground-2">
      {label}
    </div>
  );
}

/** Height reserved above every message for the toolbar, so revealing it never moves or covers text. Matches the bar's h-7. */
export const MESSAGE_TOOLBAR_GUTTER = "pt-7";

/** Ghost icon button with the shared tooltip; `label` is both the accessible name and the tooltip. */
function BarButton({ label, ...props }: { label: string } & Omit<ComponentProps<typeof Button>, "aria-label" | "size" | "variant" | "tooltip">) {
  return <Button type="button" variant="ghost" size="icon-xs" aria-label={label} tooltip={label} className="rounded" {...props} />;
}

/**
 * Hover/focus toolbar floating above a message: time, Reply, Copy and a More menu.
 * Parent must be `group/rail relative`. Edit and Retry-from-here are intentionally absent: the engine can neither
 * rewrite a sent message nor rewind a session to an earlier turn.
 */
export function MessageToolbar({
  iso,
  text,
  align = "right",
  onReply,
  link,
}: {
  iso?: string;
  text: string;
  align?: "left" | "right";
  /** Quote the message into the composer draft; absent when the reader cannot write. */
  onReply?: (quote: string) => void;
  /** Permalink to this message. */
  link?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const time = formatStamp(iso);
  const actions = toolbarActions({ text, canReply: Boolean(onReply), hasLink: Boolean(link) });
  if (!time && !actions.copy) return null;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard may be unavailable; the text stays selectable. */
    }
  };
  return (
    <div
      data-slot="message-toolbar"
      data-menu-open={menuOpen || undefined}
      className={cn(
        "absolute top-0 z-10 flex h-7 items-center gap-0.5 rounded-[var(--radius,6px)] border-[0.5px] border-border-2 bg-card px-0.5 text-xs text-muted-foreground-2 shadow-sm opacity-0 transition-opacity duration-150 ease-[cubic-bezier(.4,0,.2,1)] group-hover/rail:opacity-100 group-focus-within/rail:opacity-100 data-[menu-open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 in-data-[show-timestamps=true]:opacity-100",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {time && <span className="px-1.5 tabular-nums">{time}</span>}
      {actions.reply && onReply && (
        <BarButton label="Reply" onClick={() => onReply(quoteBlock(text))}>
          <Reply aria-hidden="true" />
        </BarButton>
      )}
      {actions.copy && (
        <BarButton label={copied ? "Copied" : "Copy message"} onClick={() => void copy(plainText(text))}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </BarButton>
      )}
      {(actions.copyMarkdown || actions.copyLink) && (
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="More" className="rounded" />}>
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" sideOffset={4}>
            {actions.copyMarkdown && (
              <DropdownMenu.Item icon={<FileText aria-hidden="true" />} onClick={() => void copy(text)}>
                Copy as markdown
              </DropdownMenu.Item>
            )}
            {actions.copyLink && link && (
              <DropdownMenu.Item icon={<Link2 aria-hidden="true" />} onClick={() => void copy(link)}>
                Copy message link
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
    </div>
  );
}
