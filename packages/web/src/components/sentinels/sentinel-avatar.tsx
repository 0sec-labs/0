import { avatarIconId, avatarInitials, presentStatus, type Sentinel } from "@/sentinels/model";
import { SENTINEL_ICONS } from "./sentinel-icons";
import { cn } from "@/lib/utils";

const SIZE = { xs: "size-5 rounded-md text-[10px]", sm: "size-8 rounded-md text-xs", lg: "size-14 rounded-xl text-xl" } as const;
const ICON_SIZE = { xs: 12, sm: 16, lg: 28 } as const;

/** Rounded tile in the Sentinel's accent colour at low alpha with its icon (initials when it has none). An optional corner dot shows its state. */
export function SentinelAvatar({ sentinel, size = "xs", dot = false, className }: { sentinel: Pick<Sentinel, "name" | "avatar" | "status" | "attention"> & { role?: string }; size?: keyof typeof SIZE; dot?: boolean; className?: string }) {
  const status = presentStatus(sentinel);
  const Icon = SENTINEL_ICONS[avatarIconId({ avatar: sentinel.avatar, role: sentinel.role ?? "" }) ?? ""];
  return <span aria-hidden="true" className={cn("relative inline-flex shrink-0 items-center justify-center font-medium leading-none", SIZE[size], className)} style={{ backgroundColor: `color-mix(in srgb, ${sentinel.avatar.color} 16%, transparent)`, color: sentinel.avatar.color }}>
    {Icon ? <Icon size={ICON_SIZE[size]} /> : avatarInitials(sentinel)}
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
