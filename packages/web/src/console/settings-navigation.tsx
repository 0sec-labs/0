import { PanelLeftIcon } from "@/ui/icons/panel";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  CapyApiKeyIcon,
  CapyPeopleIcon,
  CapyPlugIcon,
  CapySparkleFourIcon,
  CapyThreadListIcon,
  CapyUsageIcon,
  CapyAppearanceIcon,
  CapyArrowLeftIcon as ArrowLeft,
  CapyChatBubbleIcon,
  CapyChipIcon,
  CapyGaugeIcon,
  CapyInboxIcon,
  CapyKeyboardIcon,
  CapyBellIcon,
  CapyPullRequestIcon,
  CapyPuzzleIcon,
  CapySearchIcon as Search,
  CapySettingsIcon,
  CapyShieldIcon,
  CapySubagentsIcon,
  CapyTerminalSparkleIcon,
  type IconComponent,
} from "@/ui/icons/capy";
import { AccountMenu } from "@/components/team-access";
import { settingsPages, searchSettings } from "@/components/console-control/settings-index";
import { consoleReturn } from "@/components/console-control/control-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import {
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarLabel,
  SidebarScroll,
  sidebarItemClasses,
} from "@/ui/components/sidebar";

type Item = { key: string; label: string; icon: IconComponent; path: string; section?: string };

const PREFERENCE_ICONS: Record<string, IconComponent> = {
  general: CapySettingsIcon,
  appearance: CapyAppearanceIcon,
  conversation: CapyChatBubbleIcon,
  agents: CapySubagentsIcon,
  privacy: CapyShieldIcon,
  shortcuts: CapyKeyboardIcon,
  notifications: CapyBellIcon,
  transcript: CapyThreadListIcon,
  telemetry: CapyGaugeIcon,
  usage: CapyUsageIcon,
  members: CapyPeopleIcon,
  integrations: CapyPlugIcon,
  skills: CapySparkleFourIcon,
};
const preferenceItems: Item[] = settingsPages.map((category) => ({
  key: `settings-${category.id}`,
  label: category.label,
  icon: PREFERENCE_ICONS[category.id] ?? CapySettingsIcon,
  path: "/settings",
  section: category.id,
}));
const groups: { label: string; items: Item[] }[] = [
  { label: "Preferences", items: preferenceItems },
  {
    label: "Agent",
    items: [
      { key: "connections", label: "Connections", icon: CapyApiKeyIcon, path: "/connections" },
      { key: "models", label: "Models", icon: CapyChipIcon, path: "/models" },
      { key: "tools", label: "Tools", icon: CapyTerminalSparkleIcon, path: "/tools" },
    ],
  },
  {
    label: "System",
    items: [
      { key: "project", label: "Workspace", icon: CapyInboxIcon, path: "/project" },
      { key: "doctor", label: "Diagnostics", icon: CapyGaugeIcon, path: "/doctor" },
      { key: "fix", label: "Fixes", icon: CapyPullRequestIcon, path: "/fix" },
    ],
  },
];

/** Capy-style settings sidebar: back link, search, grouped navigation and account. */
export function SettingsNavigation({ returnTo, onToggle }: { returnTo: string; onToggle: () => void }) {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");
  const leaf = location.pathname.replace(/^\/console\//, "/").replace(/\/$/, "");
  const currentPath = leaf.includes("/settings") ? "/settings" : leaf.slice(leaf.lastIndexOf("/")) || "/settings";
  const currentSection = settingsPages.find((item) => item.id === params.get("section"))?.id ?? "general";
  const contextReturn = consoleReturn(location.search);
  const href = (item: Item) => {
    const search = new URLSearchParams();
    if (item.section) search.set("section", item.section);
    if (sessionId) search.set("session", sessionId);
    search.set("return", contextReturn);
    return `${item.path}?${search}`;
  };
  const isActive = (item: Item) => item.path === currentPath && (!item.section || item.section === currentSection);
  const needle = query.trim().toLowerCase();
  const navigate = useNavigate();
  const results = useRef<HTMLDivElement>(null);
  const searching = needle.length > 0;
  const found = useMemo(() => searchSettings(needle), [needle]);
  const pageHits = useMemo(
    () =>
      groups
        .filter((group) => group.label !== "Preferences")
        .flatMap((group) => group.items)
        .filter((item) => item.label.toLowerCase().includes(needle)),
    [needle],
  );
  const resultHref = (category: string, key?: string) => {
    const search = new URLSearchParams({ section: category });
    if (sessionId) search.set("session", sessionId);
    search.set("return", contextReturn);
    return `/settings?${search}${key ? `#setting-${encodeURIComponent(key)}` : ""}`;
  };
  const links = () => Array.from(results.current?.querySelectorAll<HTMLAnchorElement>("a[data-search-result]") ?? []);
  const empty = searching && found.length === 0 && pageHits.length === 0;
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
    } else if (event.key === "ArrowDown") {
      const first = links()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "Enter") {
      const first = links()[0];
      if (first) {
        event.preventDefault();
        navigate(first.getAttribute("href")!);
      }
    }
  };
  const onResultsKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const all = links();
    const index = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      all[Math.min(index + 1, all.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) (document.getElementById(searchId) as HTMLInputElement | null)?.focus();
      else all[index - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      document.getElementById(searchId)?.focus();
    }
  };
  const rowClasses = cn(sidebarItemClasses, "h-7");

  return (
    <nav aria-label="Settings navigation" className="flex h-full min-h-0 w-full flex-col pt-2">
      <SidebarHeader className="pl-2">
        <Link
          to={returnTo}
          aria-label="Back to app"
          className="flex h-7 min-w-0 items-center gap-2 rounded-(--radius-button) px-2 text-sm font-medium text-muted-foreground-1 outline-none transition-colors duration-100 hover:bg-secondary hover:text-foreground focus-visible:outline-ring-inset"
        >
          <ArrowLeft aria-hidden="true" className="size-(--icon-sm) shrink-0" />
          <span className="truncate">Settings</span>
        </Link>
        <div className="ml-auto flex items-center">
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
      <div className="shrink-0 px-2 pb-1">
        <label htmlFor={searchId} className="sr-only">
          Search settings
        </label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2"
          />
          <input
            id={searchId}
            type="search"
            aria-controls={`${searchId}-results`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search settings"
            autoComplete="off"
            className="h-(--h-control-sm) w-full rounded-(--radius-button) border-[0.5px] border-border-2 bg-transparent pr-2 pl-7 text-sm outline-none placeholder:text-muted-foreground-3 focus-visible:border-border-3"
          />
        </div>
      </div>
      <SidebarScroll>
        {empty && (
          <p role="status" className="px-2 py-3 text-xs text-muted-foreground-2">
            No settings found
          </p>
        )}
        {searching ? (
          <div
            id={`${searchId}-results`}
            ref={results}
            onKeyDown={onResultsKeyDown}
            className="flex flex-col gap-2 px-0.5 pb-2"
          >
            {found.map((group) => (
              <SidebarGroup
                key={group.category.id}
                role="group"
                aria-label={group.category.label}
                className="px-0 pb-0"
              >
                <Link
                  data-search-result
                  to={resultHref(group.category.id)}
                  data-active={(currentPath === "/settings" && group.category.id === currentSection) || undefined}
                  aria-current={
                    currentPath === "/settings" && group.category.id === currentSection ? "page" : undefined
                  }
                  className={cn(rowClasses, "text-foreground")}
                >
                  <CapySettingsIcon aria-hidden="true" />
                  <SidebarLabel>{group.category.label}</SidebarLabel>
                </Link>
                {group.entries.map((entry) => (
                  <Link
                    key={entry.key}
                    data-search-result
                    to={resultHref(entry.category, entry.key)}
                    className={cn(rowClasses, "pl-7 font-normal")}
                  >
                    <SidebarLabel>{entry.title}</SidebarLabel>
                  </Link>
                ))}
              </SidebarGroup>
            ))}
            {pageHits.length > 0 && (
              <SidebarGroup role="group" aria-label="Pages" className="px-0 pb-0">
                {pageHits.map((item) => (
                  <Link
                    key={item.key}
                    data-search-result
                    to={href(item)}
                    data-active={isActive(item) || undefined}
                    aria-current={isActive(item) ? "page" : undefined}
                    className={rowClasses}
                  >
                    <item.icon aria-hidden="true" />
                    <SidebarLabel>{item.label}</SidebarLabel>
                  </Link>
                ))}
              </SidebarGroup>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <SidebarGroup key={group.label} role="group" aria-label={group.label} className="px-0.5 pb-4">
              {group.label !== "Preferences" && (
                <div className="h-7 px-2 text-xs leading-7 font-medium text-muted-foreground-2">{group.label}</div>
              )}
              {group.items.map((item) => (
                <Link
                  key={item.key}
                  to={href(item)}
                  data-active={isActive(item) || undefined}
                  aria-current={isActive(item) ? "page" : undefined}
                  className={sidebarItemClasses}
                >
                  <item.icon aria-hidden="true" />
                  <SidebarLabel>{item.label}</SidebarLabel>
                </Link>
              ))}
            </SidebarGroup>
          ))
        )}
      </SidebarScroll>
      <SidebarFooter>
        <AccountMenu
          settingsHref={`/settings?return=${encodeURIComponent(contextReturn)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ""}`}
        />
      </SidebarFooter>
    </nav>
  );
}
