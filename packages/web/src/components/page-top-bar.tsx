import { useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Breadcrumb } from "@/ui/components/breadcrumb";
import { resolveCrumbs, useBreadcrumbState } from "@/lib/breadcrumbs";

/** Capy's 44px page bar: breadcrumb on the left, optional page actions on the right. Renders nothing on routes without crumbs. */
export function PageTopBar({ leading, trailing }: { leading?: React.ReactNode; trailing?: React.ReactNode }) {
  const { pathname, search } = useLocation();
  const { label, actions } = useBreadcrumbState();
  const crumbs = resolveCrumbs(pathname, search, label);
  // Routes without crumbs (conversations own their header) still get the compact touch bar so navigation stays reachable.
  if (!crumbs && !leading && !trailing) return null;
  return <div data-slot="page-top-bar" className={cn(!crumbs && "lg:hidden", "flex h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-border-1 px-3 sm:px-5 lg:px-6 lg:[html[data-sidebar=closed]_&]:pl-12")}>
    {leading}
    {crumbs ? <Breadcrumb items={crumbs} className="flex-1" /> : <div className="flex-1" />}
    {(actions || trailing) && <div className="flex shrink-0 items-center gap-2">{actions}{trailing}</div>}
  </div>;
}
