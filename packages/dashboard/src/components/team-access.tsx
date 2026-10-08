import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { localControlFetch, useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { useNavigate } from "react-router-dom";
import { LogOut, Monitor, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/brand-mark";

type TeamUser = { workspaceId: string; userId: string; displayName: string; role: "owner" | "editor" | "viewer" };
type TeamStatus = { enabled: boolean; workspace?: { id: string; name: string }; user?: TeamUser | null; sso: boolean };
const TeamAccessContext = createContext<TeamStatus>({ enabled: false, sso: false });
export const useTeamAccess = () => useContext(TeamAccessContext);

export function TeamAccess({ children }: { children: ReactNode }) {
  const { client, webFetchJson } = useBackendApi();
  const cache = useQueryClient();
  const status = useQuery({ queryKey: ["team-session", client.backendId], queryFn: ({ signal }) => webFetchJson<TeamStatus>("/api/team/session", { signal }), retry: false, refetchInterval: 30_000 });
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const login = async () => {
    setBusy(true); setError("");
    try {
      await webFetchJson("/api/team/auth/login", { method: "POST", body: JSON.stringify({ userId, password }) });
      setPassword(""); cache.clear(); await status.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };
  if (status.isPending) return <div role="status" className="grid min-h-dvh place-items-center text-sm text-muted-foreground">Opening workspace…</div>;
  if (status.error) return <div role="alert" className="grid min-h-dvh place-items-center p-6"><div className="space-y-3 text-sm"><p>{status.error.message}</p><Button onClick={() => void status.refetch()}>Retry</Button></div></div>;
  const value = status.data!;
  if (value.enabled && !value.user) return <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground"><div className="w-full max-w-sm space-y-6"><BrandMark /><h1 className="text-xl font-medium">Sign in to {value.workspace?.name ?? "your workspace"}</h1><form className="space-y-4" onSubmit={event => { event.preventDefault(); void login(); }}><label className="block space-y-2 text-sm"><span>Account</span><Input autoComplete="username" required value={userId} onChange={event => setUserId(event.target.value)} disabled={busy} /></label><label className="block space-y-2 text-sm"><span>Password</span><Input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy || !userId || !password} className="w-full">{busy ? "Signing in…" : "Sign in"}</Button></form>{value.sso && <Button variant="outline" className="w-full" onClick={() => { window.location.assign(client.route("/api/team/auth/sso")); }}>Continue with SSO</Button>}</div></main>;
  return <TeamAccessContext key={value.user ? `${value.user.workspaceId}:${value.user.userId}` : "local"} value={value}>{children}</TeamAccessContext>;
}

export function TeamAccount({ rail = false }: { rail?: boolean }) {
  const team = useTeamAccess();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const personal = !team.enabled || !team.user;
  const displayName = personal ? "Personal workspace" : team.user!.displayName;
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  const signOut = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/auth/logout", { method: "POST", body: "{}" });
      if (!response.ok) throw new Error("Sign-out failed.");
      cache.clear(); window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-out failed."); }
    finally { setBusy(false); }
  };
  return <DropdownMenu>
    <DropdownMenu.Trigger aria-label={personal ? "Personal workspace" : `Account: ${displayName}`} className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"><button type="button">
      <span aria-hidden="true" className="mx-1.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">{personal ? <Monitor className="size-4" /> : initials || "?"}</span>
      <span className={cn("truncate text-sm", rail && "opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-has-[:focus-visible]:opacity-100 [@media(hover:hover)]:group-hover:opacity-100")}>{displayName}</span>
    </button></DropdownMenu.Trigger>
    <DropdownMenu.Content side={rail ? "right" : "top"} align="end" sideOffset={8} className="w-64 rounded-2xl p-1.5">
      <div className="space-y-1 px-3 py-2"><p className="truncate text-sm font-medium">{displayName}</p><p className="truncate text-xs text-muted-foreground">{personal ? "No account needed" : team.workspace?.name}</p></div>
      <DropdownMenu.Item onClick={() => navigate(personal ? "/setup?step=workspace&mode=team" : "/setup?step=workspace")}><Users className="size-4" />{personal ? "Join a team" : "Workspace setup"}</DropdownMenu.Item>
      {!personal && <DropdownMenu.Item disabled={busy} onClick={() => void signOut()}><LogOut className="size-4" />{busy ? "Signing out…" : "Sign out"}</DropdownMenu.Item>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
    </DropdownMenu.Content>
  </DropdownMenu>;
}
