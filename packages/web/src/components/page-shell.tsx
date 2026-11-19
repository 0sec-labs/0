import { createContext, useContext, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { pageVariantFor, type PageVariant } from "@/lib/workspace-navigation";
import { cn } from "@/lib/utils";

/**
 * The one page layout. Routes declare a variant in PAGE_ROUTES (lib/workspace-navigation.ts) and RoutedPageShell applies it, so
 * a page renders only its PageHeader and content. Widths are the CSS variables --page-width-list / --page-width-form (styles.css);
 * the shell publishes the active one as --page-width so nested content can follow it without choosing a width of its own.
 * - list: centred 872px column (Capy's Explore column), standard gutters, title at a fixed offset.
 * - form: centred 672px column for settings sections and other form pages.
 * - full: edge to edge; the page owns its height and scrolling. PageHeader keeps the standard gutter and offset.
 */
const VARIANT_CLASS: Record<PageVariant, string> = {
  list: "ui-surface-enter mx-auto max-w-(--page-width-list) gap-10 px-6 pt-6 pb-10 md:pt-16 [[data-has-topbar]_&]:md:pt-12 [--page-width:var(--page-width-list)]",
  form: "ui-surface-enter mx-auto max-w-(--page-width-form) gap-10 px-6 pt-6 pb-10 md:pt-16 [[data-has-topbar]_&]:md:pt-12 [--page-width:var(--page-width-form)]",
  full: "min-h-0 flex-1 gap-0",
};

export function PageShell({ variant, className, ...props }: ComponentProps<"div"> & { variant: PageVariant }) {
  return <div {...props} data-page-shell={variant} className={cn("flex w-full min-w-0 flex-col", VARIANT_CLASS[variant], className)} />;
}

const VariantOverride = createContext<(variant: PageVariant | null) => void>(() => undefined);

/** A page whose layout depends on its own state states the variant here; the route table is the default. */
export function usePageVariant(variant: PageVariant | undefined) {
  const set = useContext(VariantOverride);
  useLayoutEffect(() => { set(variant ?? null); return () => set(null); }, [set, variant]);
}

/** Layout route: wraps every page route in the shell variant the route table gives its path. */
export function RoutedPageShell() {
  const { pathname } = useLocation();
  const [override, setOverride] = useState<PageVariant | null>(null);
  return <VariantOverride.Provider value={setOverride}><PageShell variant={override ?? pageVariantFor(pathname)}><Outlet /></PageShell></VariantOverride.Provider>;
}

/** Title (22px/500) at the shell's fixed offset, summary below, actions (search, buttons) top right. */
export function PageHeader({ title, summary, actions, className, ...props }: Omit<ComponentProps<"header">, "title"> & { title: ReactNode; summary?: ReactNode; actions?: ReactNode }) {
  return (
    <header {...props} className={cn("flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between [[data-page-shell=full]_&]:px-6 [[data-page-shell=full]_&]:pt-6 [[data-page-shell=full]_&]:md:pt-12", className)}>
      <div className="min-w-0">
        <h1 className="break-words font-sans text-[22px]/7 font-medium tracking-[-0.02em] text-foreground">{title}</h1>
        {summary ? <p className="mt-1 max-w-3xl text-[13px] break-words leading-5 text-muted-foreground-2">{summary}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:max-w-[55%] sm:justify-end">{actions}</div> : null}
    </header>
  );
}
