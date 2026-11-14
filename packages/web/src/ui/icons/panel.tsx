import type { SVGProps } from "react"

type PanelIconProps = SVGProps<SVGSVGElement> & {
  /** Fill the side pane (open) or leave it as an outline (closed). */
  filled?: boolean
}

/** Simple left-sidebar glyph: a rounded frame with a solid left pane (24px grid, 2px strokes). */
export function PanelLeftIcon({ filled = true, className, ...props }: PanelIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className ?? "size-(--icon-sm)"} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3.5" stroke="currentColor" strokeWidth="2" />
      {filled
        ? <path d="M3 7.5A3.5 3.5 0 0 1 6.5 4H10v16H6.5A3.5 3.5 0 0 1 3 16.5v-9Z" fill="currentColor" />
        : <path d="M10 4.5v15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  )
}

/** Mirror image for right-hand panels. */
export function PanelRightIcon({ filled = true, className, ...props }: PanelIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className ?? "size-(--icon-sm)"} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="3.5" stroke="currentColor" strokeWidth="2" />
      {filled
        ? <path d="M21 7.5A3.5 3.5 0 0 0 17.5 4H14v16h3.5a3.5 3.5 0 0 0 3.5-3.5v-9Z" fill="currentColor" />
        : <path d="M14 4.5v15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  )
}
