import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { FileQuestion } from "lucide-react"

import { Button } from "./button.js"
import { cn } from "../lib/utils.js"

/** Where a missing entity sends people back to: its section's list page. */
export const NOT_FOUND_SECTIONS = {
  findings: { to: "/findings", label: "Back to findings", noun: "finding" },
  sentinels: { to: "/sentinels", label: "Back to sentinels", noun: "sentinel" },
  automations: { to: "/automations", label: "Back to automations", noun: "automation" },
} as const

export type NotFoundSection = keyof typeof NOT_FOUND_SECTIONS

/** One sentence for a missing entity; never echoes the id back into the page copy. */
export function notFoundMessage(section: NotFoundSection) {
  return `This ${NOT_FOUND_SECTIONS[section].noun} doesn't exist or may have been removed.`
}

/** Plain centred muted text: icon, title, one sentence and one way back. */
function NotFound({ section, children, className }: { section: NotFoundSection; children?: ReactNode; className?: string }) {
  const target = NOT_FOUND_SECTIONS[section]
  return (
    <div role="status" data-slot="not-found" className={cn("flex min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      <FileQuestion aria-hidden="true" className="size-6 text-muted-foreground-2" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Not found</p>
        <p className="max-w-xs text-sm text-muted-foreground">{children ?? notFoundMessage(section)}</p>
      </div>
      <Button variant="outline" size="sm" render={<Link to={target.to} />}>{target.label}</Button>
    </div>
  )
}

export { NotFound }
