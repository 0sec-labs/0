import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CapyCheckIcon as Check } from "@/ui/icons/capy";
import { EntryLogo } from "@/components/console-control/mcp-ui";
import { LogoTile } from "@/ui/components/logo-tile";
import { Tooltip } from "@/components/ui/tooltip";
import { safeLogo } from "@/components/console-control/mcp-model";

/** The small verified check at a tile corner. `hint` adds a tooltip; the accessible name is always `label`. */
export function VerifiedMark({ label = "Verified", hint, size = "sm" }: { label?: string; hint?: string; size?: "sm" | "md" }) {
  const mark = <span role="img" aria-label={label} className={size === "md" ? "absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background" : "absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-foreground text-background ring-2 ring-background"}><Check aria-hidden="true" className={size === "md" ? "size-3" : "size-2.5"} /></span>;
  return hint ? <Tooltip content={hint}>{mark}</Tooltip> : mark;
}

function monogram(name: string) { const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/); return ((words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2))).toUpperCase(); }

/** Logo tile with the verified check at its corner. `avatar` fills the tile (publisher photo); `logo` is the padded connector mark. */
export function Tile({ logo, avatar, name, verified, verifiedLabel, verifiedHint, fallback, size = "md" }: { logo?: string; avatar?: string; name?: string; verified?: boolean; verifiedLabel?: string; verifiedHint?: string; fallback?: ReactNode; size?: "md" | "lg" }) {
  const photo = safeLogo(avatar);
  const dimension = size === "lg" ? "size-14 rounded-xl" : "size-12 rounded-lg";
  return <span className="relative shrink-0">
    {avatar !== undefined || name ? <LogoTile className={dimension}>{photo ? <img src={photo} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" /> : <span className="text-base font-medium text-muted-foreground-1">{monogram(name ?? "?")}</span>}</LogoTile>
      : <EntryLogo logo={logo} className={dimension} fallback={fallback} />}
    {verified && <VerifiedMark size={size === "lg" ? "md" : "sm"} {...(verifiedLabel ? { label: verifiedLabel } : {})} {...(verifiedHint ? { hint: verifiedHint } : {})} />}
  </span>;
}

/** One compact grid cell: tile, name and a single truncated line. The whole cell is a link; an action sits above it. */
export function Cell({ to, tile, name, description, trailing, interactive = true }: { to: string; tile: ReactNode; name: string; description: string; trailing?: ReactNode; interactive?: boolean }) {
  return <li className="relative flex min-w-0 items-center gap-3 rounded-(--radius-card) p-2 ui-row-hover focus-within:bg-secondary/40">
    {tile}
    <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground"><Link to={to} className="outline-none after:absolute after:inset-0 focus-visible:after:outline-ring-inset focus-visible:after:outline-2">{name}</Link></h3><p className="truncate text-sm text-muted-foreground-2">{description}</p></div>
    {trailing && <span className={`relative shrink-0 ${interactive ? "z-10" : "pointer-events-none"}`}>{trailing}</span>}
  </li>;
}
