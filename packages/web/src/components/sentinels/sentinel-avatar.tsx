import { avatarIconId, avatarInitials, presentStatus, type Sentinel } from "@/sentinels/model";
import { SENTINEL_ICONS } from "./sentinel-icons";
import { cn } from "@/lib/utils";
import type { AgentBadge } from "@/lib/sidebar-rows";
import { Badge } from "@/components/ui/badge";

const SIZE = { xs: "size-5 rounded-md text-[10px]", sm: "size-8 rounded-md text-xs", md: "size-8 rounded-[3px] text-xs",  lg: "size-14 rounded-xl text-xl", xl: "size-22 rounded-2xl text-3xl" } as const;
const ICON_SIZE = { xs: 12, sm: 16, md: 16, lg: 28, xl: 40 } as const;

/** Neutral rounded tile with its icon (initials when it has none). An optional corner dot shows its state. */
export function SentinelAvatar({ sentinel, size = "xs", dot = false, badge, className }: { badge?: AgentBadge; sentinel: Pick<Sentinel, "name" | "avatar" | "status" | "attention"> & { role?: string }; size?: keyof typeof SIZE; dot?: boolean; className?: string }) {
  const status = presentStatus(sentinel);
  const Icon = SENTINEL_ICONS[avatarIconId({ avatar: sentinel.avatar, role: sentinel.role ?? "" }) ?? ""];
  // The chosen colour tints the tile and colours its glyph; a sentinel without one stays neutral.
  const color = /^#[0-9a-f]{6}$/i.test(sentinel.avatar.color) ? sentinel.avatar.color : undefined;
  return <span aria-hidden="true" data-avatar-color={color} style={color ? { backgroundColor: `color-mix(in oklab, ${color} 20%, transparent)`, color } : undefined} className={cn("relative inline-flex shrink-0 items-center justify-center bg-secondary font-medium leading-none text-muted-foreground-1", SIZE[size], className)}>
    {Icon ? <Icon size={ICON_SIZE[size]} /> : avatarInitials(sentinel)}
    {badge && <AvatarBadge badge={badge} />}
    {dot && <span className={cn("absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background", status.needsYou ? "bg-amber-500" : status.label === "Active" ? "bg-emerald-500" : "bg-muted-foreground-3")} />}
  </span>;
}

export function SentinelStatusBadge({ sentinel }: { sentinel: Pick<Sentinel, "status" | "attention"> }) {
  return <StatusText {...presentStatus(sentinel)} />;
}
function StatusText({ label, tone }: { label: string; tone: "success" | "warning" | "neutral" | "info" }) {
  return <Badge variant={tone === "neutral" ? "neutral" : tone}>{label}</Badge>;
}

const BADGE_CLASSES: Record<AgentBadge, string> = {
  running: "bg-primary animate-pulse",
  "needs-you": "bg-amber-500",
  failed: "bg-red-500",
  paused: "bg-muted-foreground-3",
  idle: "bg-emerald-500",
};
/** Small status marker overlapping the avatar's bottom-right corner. */
export function AvatarBadge({ badge }: { badge: AgentBadge }) {
  // Idle and paused sentinels draw no glyph: only working, waiting and failed are worth a mark.
  if (badge === "idle" || badge === "paused") return null;
  return <span aria-hidden="true" data-badge={badge} className={cn("absolute -right-1 -bottom-1 size-2.5 rounded-full ring-2 ring-chrome", BADGE_CLASSES[badge])} />;
}
