import type { SVGProps } from "react"

/** Simple laptop glyph for "runs on this computer" (24px grid, 2px rounded strokes). */
export function LaptopIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className ?? "size-(--icon-sm)"} {...props}>
      <rect x="5" y="5" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 19h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Simple server glyph for remote hosts. */
export function ServerIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className ?? "size-(--icon-sm)"} {...props}>
      <rect x="4" y="4" width="16" height="6.5" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 7.25h.01M8 16.75h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
