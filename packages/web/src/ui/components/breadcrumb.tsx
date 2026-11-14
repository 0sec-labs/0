import { Link } from "react-router-dom"
import { CapyChevronRightIcon } from "@/ui/icons/capy"
import { cn } from "@/lib/utils"

export type BreadcrumbItem = { label: string; to?: string }

/** Plain semantic breadcrumb: parents are muted links, the last crumb is the current page. */
export function Breadcrumb({ items, className }: { items: readonly BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" data-slot="breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-[13px] leading-5 font-medium">
        {items.map((item, index) => {
          const last = index === items.length - 1
          return (
            <li key={`${index}-${item.label}`} className={cn("flex items-center gap-1", last ? "min-w-0" : "min-w-0 shrink-[3]")}>
              {last || !item.to ? (
                <span aria-current={last ? "page" : undefined} className={cn("truncate", last ? "text-foreground" : "text-muted-foreground")}>{item.label}</span>
              ) : (
                <Link to={item.to} className="max-w-[9rem] truncate rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-ring-inset sm:max-w-none">{item.label}</Link>
              )}
              {!last && <CapyChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground-1" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
