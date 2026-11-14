"use client"

import * as React from "react"

import { cn } from "../lib/utils.js"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet.js"

export const SIDEBAR_MIN_WIDTH = 224
export const SIDEBAR_MAX_WIDTH = 330
export const SIDEBAR_DEFAULT_WIDTH = 240
/** Dragging the rail below this width closes the sidebar instead of clamping. */
export const SIDEBAR_COLLAPSE_WIDTH = SIDEBAR_MIN_WIDTH / 2
const KEY_STEP = 8
const KEY_STEP_SHIFT = 32

const clampWidth = (value: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(Number.isFinite(value) ? value : SIDEBAR_DEFAULT_WIDTH)))

/** Lets any page header open the mobile sidebar drawer owned by `SidebarLayout`. */
const MobileSidebarContext = React.createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null)
export const useMobileSidebar = () => React.useContext(MobileSidebarContext)

/**
 * Capy-style app shell: a transparent sidebar sits directly on the chrome and the page
 * lives in one floating rounded panel with a hairline border. The sidebar slides off-canvas
 * when closed; the gap element animates the panel's width so layout never jumps.
 *
 * Resizing writes `--sidebar-width` straight to the wrapper from requestAnimationFrame (no React
 * state while dragging) and commits the final width on release. `index.html` applies the persisted
 * width/open state to `<html>` before first paint (`--sidebar-width-user`, `data-sidebar`).
 */
function SidebarLayout({
  open,
  width = SIDEBAR_DEFAULT_WIDTH,
  onWidthChange,
  onOpenChange,
  sidebar,
  mobileSidebar,
  openControl,
  children,
  className,
}: {
  open: boolean
  width?: number
  onWidthChange?: (width: number) => void
  /** Called with `false` when the rail is dragged below the collapse threshold. */
  onOpenChange?: (open: boolean) => void
  sidebar: React.ReactNode
  /** Content of the drawer shown below `lg`; defaults to `sidebar`. */
  mobileSidebar?: React.ReactNode
  /** Single floating control (the open button) shown at the panel's top-left while the sidebar is closed. */
  openControl?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{ raw: number; frame: number; cursor: string; select: string } | null>(null)
  const committed = clampWidth(width)
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const mobileContext = React.useMemo(() => ({ open: mobileOpen, setOpen: setMobileOpen }), [mobileOpen])

  // The drawer is a below-lg affordance; close it when the viewport grows into the docked layout.
  React.useEffect(() => {
    if (!mobileOpen || typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(min-width: 1024px)")
    const close = () => { if (query.matches) setMobileOpen(false) }
    query.addEventListener("change", close)
    return () => query.removeEventListener("change", close)
  }, [mobileOpen])

  // Mirror state onto <html> so the pre-paint script's attributes never disagree with React.
  React.useLayoutEffect(() => {
    const root = document.documentElement
    if (open) root.removeAttribute("data-sidebar")
    else root.setAttribute("data-sidebar", "closed")
  }, [open])
  React.useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width-user", `${committed}px`)
  }, [committed])

  const paint = (value: number) => wrapperRef.current?.style.setProperty("--sidebar-width", `${value}px`)
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!onWidthChange || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
    event.preventDefault()
    const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP
    onWidthChange(clampWidth(committed + (event.key === "ArrowRight" ? step : -step)))
  }
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!onWidthChange || event.button > 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { raw: committed, frame: 0, cursor: document.body.style.cursor, select: document.body.style.userSelect }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    wrapperRef.current?.setAttribute("data-dragging", "true")
  }
  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current
    if (!state) return
    const left = wrapperRef.current?.getBoundingClientRect().left ?? 0
    state.raw = event.clientX - left
    if (state.frame) return
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      paint(clampWidth(state.raw))
    })
  }
  const stop = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current
    if (!state) return
    drag.current = null
    if (state.frame) cancelAnimationFrame(state.frame)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    document.body.style.cursor = state.cursor
    document.body.style.userSelect = state.select
    wrapperRef.current?.removeAttribute("data-dragging")
    if (event.type === "pointercancel") { paint(committed); return }
    if (state.raw < SIDEBAR_COLLAPSE_WIDTH) {
      paint(committed)
      onOpenChange?.(false)
      return
    }
    const next = clampWidth(state.raw)
    paint(next)
    onWidthChange?.(next)
  }

  return (
    <MobileSidebarContext.Provider value={mobileContext}>
    <div
      ref={wrapperRef}
      data-slot="sidebar-wrapper"
      data-open={open || undefined}
      style={{ "--sidebar-width": `${committed}px` } as React.CSSProperties}
      className={cn("group/sidebar relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--chrome,var(--background))] text-foreground max-lg:bg-panel", className)}
    >
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative shrink-0 transition-[width] duration-[var(--duration-base,200ms)] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] group-data-[dragging]/sidebar:duration-0 motion-reduce:transition-none max-lg:hidden",
          open ? "w-(--sidebar-width)" : "w-0",
          "[html[data-sidebar=closed]_&]:w-0"
        )}
      />
      <div
        data-slot="sidebar-container"
        inert={!open}
        className={cn(
          "absolute inset-y-0 left-0 z-[var(--z-sidebar,50)] flex w-(--sidebar-width) transition-[translate] duration-[var(--duration-base,200ms)] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] group-data-[dragging]/sidebar:duration-0 motion-reduce:transition-none max-lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
          "[html[data-sidebar=closed]_&]:-translate-x-full"
        )}
      >
        <div
          data-slot="sidebar-content"
          className={cn(
            "flex h-full min-w-0 flex-1 flex-col overflow-hidden transition-[opacity,translate] delay-[40ms] duration-[var(--duration-base,200ms)] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] group-data-[dragging]/sidebar:duration-0 motion-reduce:translate-x-0 motion-reduce:delay-0 motion-reduce:duration-[110ms]",
            open ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0",
            "[html[data-sidebar=closed]_&]:-translate-x-2 [html[data-sidebar=closed]_&]:opacity-0"
          )}
        >{sidebar}</div>
        {onWidthChange && open && (
          <button
            type="button"
            data-slot="sidebar-rail"
            aria-label="Resize sidebar"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={onKeyDown}
            onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
            className="absolute inset-y-0 -right-2 z-10 w-4 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:rounded-full focus-visible:after:bg-ring group-data-[dragging]/sidebar:after:bg-ring"
          />
        )}
      </div>
      <div
        data-slot="sidebar-panel"
        data-sidebar-closed={!open || undefined}
        className={cn(
          "relative isolate flex min-w-0 flex-1 flex-col overflow-clip bg-panel transition-[margin-left] duration-[var(--duration-base,200ms)] ease-[var(--ease-out-quint,cubic-bezier(.23,1,.32,1))] group-data-[dragging]/sidebar:duration-0 motion-reduce:transition-none lg:my-2 lg:mr-2 lg:rounded-[var(--radius-panel)] lg:border-[0.5px] lg:border-[var(--card-hairline)] lg:shadow-[var(--shadow-card)]",
          // Closed: the strip is gone and the panel keeps an 8px chrome gutter. The dock tab strip gets a left inset
          // wide enough for the floating open button (8px gutter + 28px button + 4px gap).
          "[&_.dv-tabs-and-actions-container]:transition-[padding] [&_.dv-tabs-and-actions-container]:duration-[var(--duration-base,200ms)]",
          open ? "lg:ml-0" : "lg:ml-2 lg:[&_.dv-tabs-and-actions-container]:pl-[44px]!"
        )}
      >
        {!open && openControl && (
          <div data-slot="sidebar-open-control" className="absolute top-1.5 left-2 z-[var(--z-top-bar,10)] max-lg:hidden">{openControl}</div>
        )}
        {children}
      </div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="z-[var(--z-drawer,350)]! flex border-r-[0.5px] border-border-1 bg-panel p-0 shadow-sheet w-[min(88vw,400px)]! max-w-none! sm:max-w-none! data-[side=left]:rounded-none lg:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Workspace navigation</SheetDescription>
          <div data-slot="sidebar-drawer" className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col pt-[var(--safe-top,env(safe-area-inset-top))] pb-[env(safe-area-inset-bottom)]">{mobileSidebar ?? sidebar}</div>
        </SheetContent>
      </Sheet>
    </div>
    </MobileSidebarContext.Provider>
  )
}

/** The 28px-high navigation row shared by every sidebar destination and history entry. */
const sidebarItemClasses =
  "group/nav relative flex h-7 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-muted-foreground-1 outline-none select-none press hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset disabled:pointer-events-none disabled:opacity-40 aria-[current=page]:bg-secondary aria-[current=page]:text-foreground data-[active]:bg-secondary data-[active]:text-foreground [&_svg]:size-(--icon-sm) [&_svg]:shrink-0"

function SidebarHeader({ className, ...props }: React.ComponentProps<"header">) {
  return <header data-slot="sidebar-header" className={cn("flex h-11 shrink-0 items-center gap-1 pr-2 pl-4", className)} {...props} />
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("flex shrink-0 flex-col gap-px px-2 py-1", className)} {...props} />
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"footer">) {
  return <footer data-slot="sidebar-footer" className={cn("flex shrink-0 flex-col gap-px border-t-[0.5px] border-border-1 p-2", className)} {...props} />
}

/**
 * Scrolling region with a hairline that fades in under the header once the list is scrolled.
 * An IntersectionObserver sentinel drives it (no scroll listeners, no React state).
 */
function SidebarScroll({ className, children, ...props }: React.ComponentProps<"div">) {
  const sentinel = React.useRef<HTMLDivElement>(null)
  const divider = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const target = sentinel.current
    const line = divider.current
    if (!target || !line || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) line.removeAttribute("data-visible")
      else line.setAttribute("data-visible", "true")
    }, { root: target.parentElement })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      data-slot="sidebar-scroll"
      className={cn("relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain scroll-fade-y px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
      {...props}
    >
      <div ref={sentinel} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" />
      <div ref={divider} data-slot="scroll-divider" aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-1.5 -mb-px h-px bg-border-1 opacity-0 transition-opacity duration-[var(--duration-fast,150ms)] data-[visible]:opacity-100 motion-reduce:transition-none" />
      {children}
    </div>
  )
}

/** Truncating label: fades out at the right edge instead of showing an ellipsis. */
function SidebarLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-var(--mask-fade-ramp,16px)),transparent)]", className)} {...props} />
}

function SidebarKbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn("pointer-events-none ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-secondary px-1 font-sans text-xs font-normal text-muted-foreground-1 opacity-0 transition-opacity duration-100 group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100 pointer-coarse:hidden", className)}
      {...props}
    />
  )
}

export {
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarKbd,
  SidebarLabel,
  SidebarLayout,
  SidebarScroll,
  sidebarItemClasses,
}
