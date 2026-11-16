import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { CapyCheckIcon as Check, CapyPuzzleIcon } from "@/ui/icons/capy";
import { EntryLogo } from "@/components/console-control/entry-logo";
import { LogoTile } from "@/ui/components/logo-tile";
import { Tooltip } from "@/components/ui/tooltip";
import { BrandMark } from "@/components/brand-mark";
import type { SkillTile } from "@/lib/installed-skills";
import { safeLogo } from "@/components/console-control/connections-model";

/** The small verified check at a tile corner. `hint` adds a tooltip; the accessible name is always `label`. */
export function VerifiedMark({ label = "Verified", hint, size = "sm" }: { label?: string; hint?: string; size?: "sm" | "md" }) {
  const mark = <span role="img" aria-label={label} className={size === "md" ? "absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full bg-foreground text-background ring-2 ring-background" : "absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background"}><Check aria-hidden="true" className={size === "md" ? "size-2.5" : "size-2"} /></span>;
  return hint ? <Tooltip content={hint}>{mark}</Tooltip> : mark;
}

function monogram(name: string) { const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/); return ((words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2))).toUpperCase(); }

/** 40px logo tile (48px `lg`) with the verified check at its corner. `avatar` fills the tile (publisher photo), `icon` is an empty tile with a glyph, `logo` is the padded connector mark. */
export function Tile({ logo, avatar, icon, name, verified, verifiedLabel, verifiedHint, fallback, size = "md" }: { logo?: string; avatar?: string; icon?: ReactNode; name?: string; verified?: boolean; verifiedLabel?: string; verifiedHint?: string; fallback?: ReactNode; size?: "md" | "lg" }) {
  const photo = safeLogo(avatar);
  const dimension = size === "lg" ? "size-12 rounded-xl" : "size-10 rounded-lg";
  return <span className="relative shrink-0">
    {icon ? <LogoTile className={dimension}>{icon}</LogoTile> : avatar !== undefined || name ? <LogoTile className={dimension}>{photo ? <img src={photo} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" /> : <span className="text-sm font-medium text-muted-foreground-1">{monogram(name ?? "?")}</span>}</LogoTile>
      : <EntryLogo logo={logo} className={dimension} fallback={fallback} />}
    {verified && <VerifiedMark size={size === "lg" ? "md" : "sm"} {...(verifiedLabel ? { label: verifiedLabel } : {})} {...(verifiedHint ? { hint: verifiedHint } : {})} />}
  </span>;
}

/** The 0security mark as an icon component (follows the theme), for lists that take an icon. */
export const SkillMarkIcon = ({ className }: { className?: string }) => <BrandMark compact className={className} />;

/** The one place that decides how an installed skill looks: built-in = 0security mark, extension = puzzle, GitHub = publisher avatar, yours = initials. */
export function InstalledTile({ tile, publisher }: { tile: SkillTile; publisher?: { name: string; avatar: string } }) {
  if (tile.kind === "brand") return <Tile icon={<SkillMarkIcon className="size-6" />} />;
  if (tile.kind === "extension") return <Tile icon={<CapyPuzzleIcon aria-hidden="true" className="size-4 text-muted-foreground-1" />} />;
  return <Tile avatar={tile.kind === "publisher" ? publisher?.avatar ?? "" : ""} name={publisher?.name ?? tile.name} />;
}

/** One list row: tile, name and a single truncated line, 56px high. The whole row is a link; `onOpen` handles the click in place. */
export function Cell({ to, tile, name, description, trailing, interactive = true, onOpen }: { to: string; tile: ReactNode; name: string; description: string; trailing?: ReactNode; interactive?: boolean; onOpen?: () => void }) {
  return <li className="group/cell relative -mx-2 flex h-14 min-w-0 items-center gap-3 rounded-md px-2 transition-colors duration-100 hover:bg-secondary focus-within:bg-secondary motion-reduce:transition-none">
    {tile}
    <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-foreground/85 transition-colors duration-100 group-hover/cell:text-foreground"><Link to={to} {...(onOpen ? { onClick: (event: MouseEvent<HTMLAnchorElement>) => { if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(); } } : {})} className="outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-ring-inset focus-visible:after:outline-2">{name}</Link></h3><p className="truncate text-sm text-muted-foreground-2">{description}</p></div>
    {trailing && <span className={`relative shrink-0 ${interactive ? "z-10" : "pointer-events-none"}`}>{trailing}</span>}
  </li>;
}
