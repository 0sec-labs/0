import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Capy's Explore tab row: Extensions and Skills read as one family. `trailing` sits at the far right (Skills puts Installed / Browse there). */
export function ExploreTabs({ active, trailing }: { active: "extensions" | "skills"; trailing?: ReactNode }) {
  const tab = (id: "extensions" | "skills", to: string, label: string) => <Link to={to} aria-current={active === id ? "page" : undefined}
    className={cn("inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none", active === id ? "bg-secondary text-foreground" : "text-muted-foreground-1 hover:text-foreground")}>{label}</Link>;
  return <div className="flex min-w-0 items-center justify-between gap-3">
    <nav aria-label="Explore" className="-ml-2.5 flex items-center gap-1">{tab("extensions", "/extensions", "Extensions")}{tab("skills", "/skills", "Skills")}</nav>
    {trailing}
  </div>;
}
