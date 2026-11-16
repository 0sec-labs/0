import type { ReactNode } from "react";
import { LogoTile } from "@/ui/components/logo-tile";
import { safeLogo } from "./connections-model";

/** Logo tile that only ever renders a same-origin image; anything else falls back to the supplied icon. */
export function EntryLogo({ logo, fallback, className = "size-9" }: { logo?: string; fallback: ReactNode; className?: string }) {
  const src = safeLogo(logo);
  return <LogoTile className={className}>{src ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-contain" /> : fallback}</LogoTile>;
}
