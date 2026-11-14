import type { ComponentProps } from "react";
import { cn } from "../lib/utils.js";

/** 28px bordered tile that frames a provider or service logo, as in Capy's connection and plugin rows. */
export function LogoTile({ children, className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden="true" data-slot="logo-tile" className={cn("grid size-7 shrink-0 place-items-center rounded-(--radius-button) border-[0.5px] border-border-2 bg-secondary text-foreground", className)} {...props}>{children}</span>;
}
