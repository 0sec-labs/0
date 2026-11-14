import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CapyComposeIcon as SquarePen, CapyMoreIcon as Ellipsis, CapySearchIcon as Search } from "@/ui/icons/capy";
import { PanelLeftIcon } from "@/ui/icons/panel";
import { AccountMenu } from "@/components/team-access";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { backendRoute } from "@/lib/backend-client";
import { Tooltip } from "@/components/ui/tooltip";
import { openAppSearch } from "@/components/search-events";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarKbd,
  SidebarLabel,
  SidebarScroll,
  sidebarItemClasses,
} from "@/ui/components/sidebar";
import { cn } from "@/lib/utils";
import { useBackendApi } from "@/api";
import { WORKSPACE_DESTINATIONS, canonicalWorkspacePath } from "@/lib/workspace-navigation";
import { backendRouteHref } from "./chat-host";
import { SidebarCards } from "./sidebar-cards";
import { SentinelSidebarSection } from "@/components/sentinels/sentinel-sidebar-section";

/** ⇧⌘S toggles the sidebar from anywhere in the app. */
export function useSidebarShortcut(toggle: () => void) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [toggle]);
}

/** ⇧⌘O opens a new chat and ⌘, opens settings from anywhere in the app. */
export function useShellNavigationShortcuts(settingsHref: string) {
  const navigate = useNavigate();
  const newChatHref = useNewChatHref();
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "o") {
        event.preventDefault();
        navigate(newChatHref);
      } else if (!event.shiftKey && event.key === ",") {
        event.preventDefault();
        navigate(settingsHref);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [navigate, newChatHref, settingsHref]);
}

function useNewChatHref() {
  const { client } = useBackendApi();
  const location = useLocation();
  const requestedHost = new URLSearchParams(location.search).get("host");
  const routeHost = backendRoute(location.pathname).backendId;
  const activeHost =
    requestedHost && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requestedHost)
      ? requestedHost
      : routeHost !== "local"
        ? routeHost
        : client.backendId;
  return backendRouteHref(activeHost, "/chats?new=1");
}

/** Capy-style sidebar content: brand and actions, chat history, destinations, account. */
export function ConsoleNavigationRail({
  settingsHref,
  onHistorySlot,
  onToggle,
}: {
  settingsHref: string;
  onHistorySlot?: (element: HTMLDivElement | null) => void;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  const { getDashboard, client } = useBackendApi();
  const location = useLocation();
  const route = backendRoute(location.pathname);
  const currentPath = canonicalWorkspacePath(location.pathname.slice(route.basename.length) || "/");
  const newChatHref = useNewChatHref();
  const newChatActive = currentPath === "/chats" && new URLSearchParams(location.search).get("new") === "1";
  const dashboard = useQuery({
    queryKey: queryKeys.dashboard(client.backendId),
    queryFn: getDashboard,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const findingCount = dashboard.data?.groups.length ?? 0; // same total the Findings page shows (it lists suppressed groups too)
  // Short primary list like Capy; Plugins, Memory and Hosts stay reachable under More. A "run" is just a chat, so there is no Runs destination.
  const pick = (order: readonly string[]) =>
    order.flatMap((to) => WORKSPACE_DESTINATIONS.filter((item) => item.to === to));
  const destinations = pick(["/findings", "/automations", "/plugins/skills"]);
  const moreDestinations = pick(["/plugins", "/learning", "/engines"]);
  const active = (to: string) => currentPath === to || currentPath.startsWith(`${to}/`);
  // /plugins/skills has its own row, so it must not also light up More… through the /plugins prefix.
  const ownRow = (path: string) =>
    destinations.some(({ to }) => active(to) && (to === path || to.startsWith(`${path}/`)));
  const moreActive = moreDestinations.some(({ to }) => active(to) && !ownRow(to));

  return (
    <nav aria-label="Command Center navigation" className="flex h-full min-h-0 w-full flex-col pt-2">
      <SidebarHeader>
        <Tooltip content="Home" side="bottom">
          <a
            href={newChatHref}
            aria-label={v("0.security new {mission}")}
            className="-ml-1 flex h-(--h-control-sm) shrink-0 items-center justify-center rounded-(--radius-button) px-1 outline-none transition-colors duration-100 hover:bg-secondary focus-visible:outline-ring-inset"
          >
            <BrandMark className="h-auto w-28" />
          </a>
        </Tooltip>
        <div className="ml-auto flex items-center">
          <Tooltip content="Search anything" shortcut="⌘K" side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search anything"
              aria-keyshortcuts="Meta+K Control+K"
              onClick={(event) => openAppSearch("all", event.currentTarget)}
              className="text-muted-foreground-1"
            >
              <Search />
            </Button>
          </Tooltip>
          <Tooltip content="Close sidebar" shortcut="⇧⌘S" side="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-keyshortcuts="Meta+Shift+S Control+Shift+S"
              aria-label="Close sidebar"
              onClick={onToggle}
              className="text-muted-foreground-1"
            >
              <PanelLeftIcon filled />
            </Button>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarGroup aria-label="Workspace destinations">
        <a
          href={newChatHref}
          aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
          data-active={newChatActive || undefined}
          className={sidebarItemClasses}
        >
          <SquarePen aria-hidden="true" />
          <SidebarLabel>{v("New {mission}")}</SidebarLabel>
          <SidebarKbd aria-hidden="true">⇧⌘O</SidebarKbd>
        </a>
        {destinations.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} data-active={active(to) || undefined} className={sidebarItemClasses}>
            <Icon aria-hidden="true" />
            <SidebarLabel>{label}</SidebarLabel>
            {label === "Findings" && findingCount > 0 && (
              <span
                aria-label={`${findingCount} findings`}
                className="ml-auto inline-flex h-3.5 min-w-4.5 shrink-0 items-center justify-center translate-y-px rounded-full border-[0.5px] border-[color-mix(in_oklch,var(--primary)_80%,black)] bg-primary px-1 text-[11px] leading-none font-bold tabular-nums text-primary-foreground shadow-[inset_0_1px_oklch(1_0_0/.12),var(--sh-plate)]"
              >
                {findingCount > 99 ? "99+" : findingCount}
              </span>
            )}
          </NavLink>
        ))}
        <DropdownMenu>
          <DropdownMenu.Trigger
            aria-label="More"
            data-active={moreActive || undefined}
            className={cn(sidebarItemClasses, "data-[popup-open]:bg-secondary data-[popup-open]:text-foreground")}
          >
            <Ellipsis aria-hidden="true" />
            <SidebarLabel>More…</SidebarLabel>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="w-48">
            <DropdownMenu.Group>
              {moreDestinations.map(({ to, label, icon: Icon }) => (
                <DropdownMenu.Item key={to} icon={<Icon aria-hidden="true" />} onClick={() => navigate(to)}>
                  {label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu>
      </SidebarGroup>
      <SentinelSidebarSection />
      <SidebarScroll id="navigation-chat-history">
        <div ref={onHistorySlot} className="flex h-full min-h-0 flex-col" />
      </SidebarScroll>
      <SidebarCards />
      <SidebarFooter>
        <AccountMenu settingsHref={settingsHref} />
      </SidebarFooter>
    </nav>
  );
}

/** The one floating control left on the chrome while the sidebar is closed. Search and new chat stay on the palette and shortcuts. */
export function ConsoleNavigationOpenButton({ onToggle }: { onToggle: () => void }) {
  return (
    <Tooltip content="Open sidebar" shortcut="⇧⌘S" side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-keyshortcuts="Meta+Shift+S Control+Shift+S"
        aria-label="Open sidebar"
        onClick={onToggle}
        className="text-muted-foreground-1"
      >
        <PanelLeftIcon filled={false} />
      </Button>
    </Tooltip>
  );
}
