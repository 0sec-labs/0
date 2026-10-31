import { SelectionHighlight } from "@0/ui/components/selection-highlight";
import { useEffect, useRef, useState } from "react";
import { TeamAccount, useTeamAccess } from "@/components/team-access";
import { backendRoute } from "@/lib/backend-client";
import { backendRouteHref } from "./chat-host";
import { NavLink, useLocation } from "react-router-dom";
import { BookOpen, ShieldCheck, Plug, Settings, Workflow, Library, Server, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { openAppSearch } from "@/components/command-palette";
import { NewChatButton } from "@/components/new-chat-button";
import { BrandMark } from "@/components/brand-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePersistentState } from "@/lib/use-persistent-state";
import { useQuery } from "@tanstack/react-query";
import { useBackendApi } from "@/api";

/** Pinned navigation reserves space; temporary hover/focus expansion overlays it. */
export function ConsoleNavigationRail({ settingsHref, onHistorySlot }: { settingsHref: string; onHistorySlot?: (element: HTMLDivElement | null) => void }) {
  const team = useTeamAccess();
  const showAccount = team.enabled && Boolean(team.user);
  const [collapsed, setCollapsed] = usePersistentState("0-console-navigation-collapsed", false);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "s") { event.preventDefault(); setCollapsed(value => !value); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [setCollapsed]);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = undefined; };
  const closePreview = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      // Portalled menus must keep their anchor stable until they close.
      if (rail.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) { closePreview(); return; }
      setHovered(false);
    }, 160);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const expanded = !collapsed || hovered || focusWithin;
  const compact = !expanded;
  const { getDashboard, client } = useBackendApi();
  const location = useLocation();
  const requestedHost = new URLSearchParams(location.search).get("host");
  const route = backendRoute(location.pathname);
  const routeHost = route.backendId;
  const currentPath = (location.pathname.slice(route.basename.length) || "/").replace(/^\/(?:workflows|audits|launcher|launch)(?=\/|$)/, "/automations");
  const activeHost = requestedHost && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requestedHost) ? requestedHost : routeHost !== "local" ? routeHost : client.backendId;
  const newChatHref = backendRouteHref(activeHost, "/console?new=1");
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 3000 });
  const findingCount = dashboard.data?.groups.filter(group => group.latest.triageStatus !== "suppressed").length ?? 0;
  const control = buttonVariants({ variant: "ghost", size: "sm", className: "console-navigation-control w-full justify-start gap-2.5 overflow-hidden px-2.5 font-normal text-muted-foreground" });
  const destinations = [
    { to: "/findings", label: "Findings", icon: ShieldCheck },
    { to: "/automations", label: "Automations", icon: Workflow },
    { to: "/skills", label: "Skills", icon: Library },
    { to: "/workers", label: "Hosts", icon: Server },
    { to: "/plugins", label: "Plugins", icon: Plug },
    { to: "/learning", label: "Memory", icon: BookOpen },
  ];
  return <div className="console-navigation-slot console-sidebar-surface relative hidden h-full min-h-0 shrink-0 lg:block" data-pinned={!collapsed} onPointerEnter={event => { if (event.pointerType === "mouse") { cancelClose(); setHovered(true); } }} onPointerLeave={event => { if (event.pointerType === "mouse") closePreview(); }}>
    {collapsed && hovered && <div aria-hidden="true" className="absolute inset-y-0 left-0 z-20 w-64" />}
    <nav ref={rail} aria-label="Command Center navigation" data-collapsed={compact} data-floating={collapsed && expanded} onFocus={event => setFocusWithin(event.target.matches(":focus-visible"))} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false); }} className="console-navigation-rail hidden h-full min-h-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto bg-background p-2 lg:flex [scrollbar-width:thin]">
      <div className="relative mb-3 h-10 w-60 shrink-0">
        <a href={newChatHref} aria-label="0.security new chat" className={cn("absolute flex h-8 items-center rounded-[var(--radius-control,8px)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", compact ? "left-0 top-0 w-8" : "left-1 top-1 w-36")}>
          <span aria-hidden={!compact} className={cn("console-navigation-brand-compact pointer-events-none absolute left-1.5 top-1.5 transition-opacity duration-150 motion-reduce:transition-none",compact ? "opacity-100" : "opacity-0")}><BrandMark compact className="size-5" /></span>
          <span aria-hidden={compact} className="console-navigation-label pointer-events-none absolute left-1 w-36"><BrandMark className="w-36" /></span>
        </a>
        <Tooltip content="Search anything" shortcut="⌘K" side="right"><Button variant="ghost" size="icon-sm" aria-label="Search anything" aria-keyshortcuts="Meta+K Control+K" onClick={event => openAppSearch("all", event.currentTarget)} className={cn("absolute text-muted-foreground", compact ? "left-0 top-20 size-8" : "left-[168px] top-1")}><Search className="size-4" /></Button></Tooltip>
        <Tooltip content={collapsed ? "Pin navigation open" : "Unpin navigation"} shortcut="⇧⌘S" side="right"><Button type="button" variant="ghost" size="icon-sm" aria-keyshortcuts="Meta+Shift+S Control+Shift+S" aria-label={collapsed ? "Pin navigation open" : "Unpin navigation"} aria-expanded={expanded} aria-controls="navigation-chat-history" onClick={() => setCollapsed(value => !value)} className="console-navigation-toggle console-navigation-control absolute top-1 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control,8px)] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button></Tooltip>
      </div>
      <Tooltip content="New chat" side="right"><NewChatButton iconOnly asChild className="console-navigation-new-chat absolute left-2 top-12 size-8 text-muted-foreground" aria-hidden={!compact}><a href={newChatHref} tabIndex={compact ? 0 : -1} /></NewChatButton></Tooltip>
      <section id="navigation-chat-history" aria-label="Chats" aria-hidden={compact} inert={compact} className="min-h-0 w-60 flex-1 overflow-hidden">
        <div ref={onHistorySlot} className="console-navigation-history-slot console-navigation-label" />
      </section>
      <div aria-label="Workspace destinations" className="relative isolate mt-2 w-60 shrink-0 space-y-0.5">
        <SelectionHighlight activeKey={currentPath} revision={String(expanded)} />
        {destinations.map(({to,label,icon:Icon})=><Tooltip key={to} content={label === "Findings" ? `${label} (${findingCount})` : label} side="right"><NavLink to={to} aria-label={label === "Findings" ? `${label} (${findingCount})` : label} data-ui-selected={currentPath === to || currentPath.startsWith(`${to}/`) || undefined} className={cn(control,"relative z-10",(currentPath === to || currentPath.startsWith(`${to}/`)) && "text-foreground")}>
          <Icon aria-hidden="true" className="size-4 shrink-0" /><span aria-hidden={compact} className="console-navigation-label min-w-0 flex-1 truncate text-sm">{label}</span>
          {label === "Findings" && findingCount > 0 && <span aria-hidden="true" className="console-navigation-label ml-auto text-[10px] tabular-nums text-muted-foreground">{findingCount > 99 ? "99+" : findingCount}</span>}
        </NavLink></Tooltip>)}
      </div>
      <div className="console-navigation-footer mt-0.5 flex w-60 shrink-0 flex-col gap-0.5">
        <Tooltip content="Settings" side="right"><NavLink to={settingsHref} aria-label="Settings" className={cn(control, currentPath.startsWith("/settings") && "bg-muted/70 text-foreground")}><Settings aria-hidden="true" className="size-4 shrink-0" /><span aria-hidden={compact} className="console-navigation-label min-w-0 flex-1 truncate text-sm">Settings</span><span aria-hidden={compact} aria-label={`Version ${__ZERO_VERSION__}`} className="console-navigation-label ml-auto font-mono text-[10px] text-muted-foreground/60">v{__ZERO_VERSION__}</span></NavLink></Tooltip>
        {showAccount && <div className={cn("flex min-w-0 flex-col gap-0.5", compact ? "w-8" : "ml-1 w-[232px]")}>
          <div className={cn("h-8 shrink-0 [&_button]:h-8 [&_button]:rounded-[var(--radius-control)]", compact ? "w-8" : "w-full")}><TeamAccount rail collapsed={compact} /></div>
        </div>}
      </div>
    </nav>
  </div>;
}
