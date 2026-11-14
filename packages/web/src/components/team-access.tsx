import { v } from "@/lib/vocabulary";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { localControlFetch } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CapyApiKeyIcon as KeyRound, CapyAppearanceIcon as Palette, CapyBuildingIcon as Users, CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyChevronUpIcon as ChevronUp, CapyKeyboardIcon as Keyboard, CapyLogOutIcon as LogOut, CapySettingsIcon as Settings } from "@/ui/icons/capy";
import { useWebTheme, type WebTheme } from "@/lib/web-theme";
import { cn } from "@/lib/utils";
import { Kbd } from "@/ui/components/kbd";
import { BrandMark } from "@/components/brand-mark";
import { ShellSkeleton } from "@/components/shell-skeleton";

type TeamUser = { workspaceId: string; userId: string; displayName: string; role: "owner" | "editor" | "viewer" };
type TeamStatus = { enabled: boolean; workspace?: { id: string; name: string }; user?: TeamUser | null; sso: boolean };
const TeamAccessContext = createContext<TeamStatus>({ enabled: false, sso: false });
export const useTeamAccess = () => useContext(TeamAccessContext);

const TEAM_MODE_HINT_KEY = "0-team-mode";
const LOCAL_TEAM_STATUS: TeamStatus = { enabled: false, sso: false };
/** The last observed team-mode flag. Only a known "off" lets the shell render before /api/team/session answers. */
export function readTeamModeHint(): boolean | null {
  try { const value = window.localStorage.getItem(TEAM_MODE_HINT_KEY); return value === "1" ? true : value === "0" ? false : null; } catch { return null; }
}
function writeTeamModeHint(enabled: boolean) { try { window.localStorage.setItem(TEAM_MODE_HINT_KEY, enabled ? "1" : "0"); } catch { /* Hint only. */ } }

export function TeamAccess({ children }: { children: ReactNode }) {
  const readTeamStatus = async (signal?: AbortSignal): Promise<TeamStatus> => { const response = await localControlFetch("/api/team/session", { signal }); if (!response.ok) throw new Error("Could not open this workspace."); return response.json() as Promise<TeamStatus>; };
  const cache = useQueryClient();
  // Known single-user mode: render the shell optimistically with local status while the real answer revalidates.
  const [hint] = useState(readTeamModeHint);
  const status = useQuery({ queryKey: ["team-session"], queryFn: ({ signal }) => readTeamStatus(signal).then(value => { writeTeamModeHint(value.enabled); return value; }), ...(hint === false ? { initialData: LOCAL_TEAM_STATUS, initialDataUpdatedAt: 0 } : {}), retry: 2, retryDelay: attempt => Math.min(1000 * 2 ** attempt, 5000), refetchInterval: query => query.state.error ? 3000 : 30_000 });
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const login = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/auth/login", { method: "POST", body: JSON.stringify({ userId, password }) });
      if (!response.ok) { const failure = await response.json() as { error?: string }; throw new Error(failure.error || "Sign-in failed."); }
      setPassword(""); cache.clear(); await status.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };
  if (status.isPending) return <ShellSkeleton />;
  if (status.error && !status.data) return <div role="alert" className="grid min-h-dvh place-items-center p-6"><div className="space-y-3 text-sm"><p>Reconnecting to the local engine…</p><p className="text-xs text-muted-foreground">{v("Your {missions} are saved. This page will recover automatically when the engine is available.")}</p><Button onClick={() => void status.refetch()}>Reconnect now</Button></div></div>;
  const value = status.data!;
  if (value.enabled && !value.user) return <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground"><div className="w-full max-w-sm space-y-6"><BrandMark /><h1 className="text-xl font-medium">Sign in to {value.workspace?.name ?? "your workspace"}</h1><form className="space-y-4" onSubmit={event => { event.preventDefault(); void login(); }}><label className="block space-y-2 text-sm"><span>Account</span><Input autoComplete="username" required value={userId} onChange={event => setUserId(event.target.value)} disabled={busy} /></label><label className="block space-y-2 text-sm"><span>Password</span><Input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy || !userId || !password} className="w-full">{busy ? "Signing in…" : "Sign in"}</Button></form>{value.sso && <Button variant="outline" className="w-full" onClick={() => { window.location.assign("/api/team/auth/sso"); }}>Continue with SSO</Button>}</div></main>;
  return <TeamAccessContext key={value.user ? `${value.user.workspaceId}:${value.user.userId}` : "local"} value={value}>{children}</TeamAccessContext>;
}

export function TeamAccount({ rail = false, collapsed = false }: { rail?: boolean; collapsed?: boolean }) {
  const team = useTeamAccess();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signOut = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/auth/logout", { method: "POST", body: "{}" });
      if (!response.ok) throw new Error("Sign-out failed.");
      cache.clear(); window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-out failed."); }
    finally { setBusy(false); }
  };
  if (!team.enabled || !team.user) return null;
  const displayName = team.user.displayName;
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  return <DropdownMenu>
    <DropdownMenu.Trigger aria-label={`Account: ${displayName}`} className={cn("flex h-10 w-full items-center overflow-hidden rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", rail && collapsed ? "justify-center gap-0" : "justify-start gap-2.5")}><button type="button">
      <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground", rail ? "mx-0" : "mx-1.5")}>{initials || "?"}</span>
      <span className={cn("truncate text-sm", rail && collapsed && "sr-only")}>{displayName}</span>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Content side={rail && collapsed ? "right" : "top"} align={rail && !collapsed ? "start" : "end"} sideOffset={8}>
      <DropdownMenu.Group>
      <DropdownMenu.Label><span className="block truncate">{displayName}</span><span className="block truncate font-normal">{team.workspace?.name}</span></DropdownMenu.Label>
      <DropdownMenu.Item onClick={() => navigate("/team")}><Users className="size-(--icon-sm)" />Workspace settings</DropdownMenu.Item>
      {team.user?.role === "owner" && <DropdownMenu.Item onClick={() => navigate("/api-access")}><KeyRound className="size-(--icon-sm)" />Findings API</DropdownMenu.Item>}
      <DropdownMenu.Item disabled={busy} onClick={() => void signOut()}><LogOut className="size-(--icon-sm)" />{busy ? "Signing out…" : "Sign out"}</DropdownMenu.Item>
      {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu>;
}

const menuItemClasses = "relative flex min-h-7 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm font-normal outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))] data-[popup-open]:bg-[var(--popover-hover,color-mix(in_oklch,var(--foreground)_8%,transparent))] [&_svg:not([class*='size-'])]:size-(--icon-sm) [&_svg]:shrink-0 [&_svg]:text-muted-foreground-1";
const menuSurfaceClasses = "ui-popup max-w-[calc(100vw-24px)] max-h-[min(28rem,calc(100dvh-2rem))] overscroll-contain flex origin-(--transform-origin) flex-col overflow-y-auto rounded-[var(--radius-overlay,8px)] border-[0.5px] border-border-2 bg-popover p-1 text-popover-foreground shadow-[var(--sh-overlay,0_6px_18px_rgb(0_0_0/.03),0_3px_9px_rgb(0_0_0/.04),0_1px_1px_rgb(0_0_0/.05))] outline-none";
const menuSeparator = <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border-1" />;

/**
 * Capy-style footer account button and its upward menu. Shared by the main and settings sidebars.
 * Local mode shows "Local / This computer"; team mode shows the signed-in user and workspace.
 */
export function AccountMenu({ settingsHref = "/settings" }: { settingsHref?: string }) {
  const team = useTeamAccess();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [theme, setTheme] = useWebTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const user = team.enabled ? team.user : null;
  const signOut = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/auth/logout", { method: "POST", body: "{}" });
      if (!response.ok) throw new Error("Sign-out failed.");
      cache.clear(); window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-out failed."); }
    finally { setBusy(false); }
  };
  const name = user ? user.displayName : "Local";
  const subtitle = user ? team.workspace?.name ?? "Workspace" : "This computer";
  const initial = (user ? user.displayName.trim().charAt(0) : "L").toUpperCase() || "?";
  const themeItem = (value: WebTheme, label: string) => <MenuPrimitive.Item key={value} className={menuItemClasses} onClick={() => setTheme(value)}>{label}{theme === value && <Check aria-hidden="true" className="ml-auto" />}</MenuPrimitive.Item>;
  return <MenuPrimitive.Root>
    <MenuPrimitive.Trigger aria-label={`Account: ${name}`} className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md p-1.5 text-left outline-none select-none transition-colors duration-100 hover:bg-secondary data-[popup-open]:bg-secondary focus-visible:outline-ring-inset">
      <span aria-hidden="true" className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary text-[10px] font-medium text-foreground">{initial}</span>
      <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-xs leading-[1.3] font-medium text-foreground">{name}</span><span className="truncate text-2xs leading-[1.3] font-normal text-muted-foreground-2">{subtitle}</span></span>
      <ChevronUp aria-hidden="true" className="ml-auto size-(--icon-sm) shrink-0 text-muted-foreground-3" />
    </MenuPrimitive.Trigger>
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="top" align="start" sideOffset={4} alignOffset={4} className="z-[60] outline-none">
        <MenuPrimitive.Popup data-slot="account-menu" className={cn(menuSurfaceClasses, "w-56")}>
          <MenuPrimitive.Item className={menuItemClasses} onClick={() => navigate(settingsHref)}><Settings aria-hidden="true" />Settings<Kbd aria-hidden="true" className="ml-auto">⌘,</Kbd></MenuPrimitive.Item>
          <MenuPrimitive.SubmenuRoot>
            <MenuPrimitive.SubmenuTrigger className={menuItemClasses}><Palette aria-hidden="true" />Appearance<ChevronRight aria-hidden="true" className="ml-auto" /></MenuPrimitive.SubmenuTrigger>
            <MenuPrimitive.Portal><MenuPrimitive.Positioner side="right" align="start" sideOffset={4} className="z-[60] outline-none"><MenuPrimitive.Popup className={cn(menuSurfaceClasses, "min-w-32")}>{themeItem("light", "Light")}{themeItem("dark", "Dark")}</MenuPrimitive.Popup></MenuPrimitive.Positioner></MenuPrimitive.Portal>
          </MenuPrimitive.SubmenuRoot>
          <MenuPrimitive.Item className={menuItemClasses} onClick={() => navigate("/settings?section=shortcuts")}><Keyboard aria-hidden="true" />Shortcuts</MenuPrimitive.Item>
          {user && <>
            {menuSeparator}
            <MenuPrimitive.Item className={menuItemClasses} onClick={() => navigate("/team")}><Users aria-hidden="true" />Workspace settings</MenuPrimitive.Item>
            {user.role === "owner" && <MenuPrimitive.Item className={menuItemClasses} onClick={() => navigate("/api-access")}><KeyRound aria-hidden="true" />Findings API</MenuPrimitive.Item>}
            <MenuPrimitive.Item className={cn(menuItemClasses, "text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive")} disabled={busy} closeOnClick={false} onClick={() => void signOut()}><LogOut aria-hidden="true" />{busy ? "Signing out…" : "Sign out"}</MenuPrimitive.Item>
            {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
          </>}
          {menuSeparator}
          <div aria-label={`Version ${__ZERO_VERSION__}`} className="px-2 py-1 text-2xs text-muted-foreground-2 select-none">Version {__ZERO_VERSION__}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root>;
}
