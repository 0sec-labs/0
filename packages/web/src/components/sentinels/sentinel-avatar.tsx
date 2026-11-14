import { avatarInitials, presentStatus, type Sentinel } from "@/sentinels/model";
import { cn } from "@/lib/utils";

const SIZE = { xs: "size-4 rounded-[3px] text-[10px]", sm: "size-6 rounded-md text-xs", lg: "size-20 rounded-2xl text-3xl" } as const;

/** Colour tile with the Sentinel's emoji or initials; an optional corner dot shows its state. */
export function SentinelAvatar({ sentinel, size = "xs", dot = false, className }: { sentinel: Pick<Sentinel, "name" | "avatar" | "status" | "attention">; size?: keyof typeof SIZE; dot?: boolean; className?: string }) {
  const status = presentStatus(sentinel);
  return <span aria-hidden="true" className={cn("relative inline-flex shrink-0 items-center justify-center font-medium leading-none text-white", SIZE[size], className)} style={{ backgroundColor: sentinel.avatar.color }}>
    {avatarInitials(sentinel)}
    {dot && <span className={cn("absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background", status.needsYou ? "bg-amber-500" : status.label === "Active" ? "bg-emerald-500" : "bg-muted-foreground-3")} />}
  </span>;
}

export function SentinelStatusBadge({ sentinel }: { sentinel: Pick<Sentinel, "status" | "attention"> }) {
  return <StatusText {...presentStatus(sentinel)} />;
}
import { Badge } from "@/components/ui/badge";
function StatusText({ label, tone }: { label: string; tone: "success" | "warning" | "neutral" | "info" }) {
  return <Badge variant={tone === "neutral" ? "neutral" : tone}>{label}</Badge>;
}
