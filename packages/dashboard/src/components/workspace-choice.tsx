import { useState } from "react";
import { Monitor, Users, ArrowRight } from "lucide-react";
import { localControlFetch } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function WorkspaceChoice({ teamName, initialMode = "personal", onContinue }: { teamName?: string; initialMode?: "personal" | "team"; onContinue: () => void }) {
  const [mode, setMode] = useState<"personal" | "team">(teamName ? "team" : initialMode);
  const [workspaceName, setWorkspaceName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createTeam = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/setup", { method: "POST", body: JSON.stringify({ workspaceName, displayName, userId, password }) });
      const result = await response.json() as { enabled?: boolean; error?: string };
      if (!response.ok || !result.enabled) throw new Error(result.error || "Could not create the workspace.");
      setPassword("");
      window.location.assign("/setup?step=connect");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the workspace."); }
    finally { setBusy(false); }
  };
  if (teamName) return <div className="space-y-4"><p className="text-sm text-muted-foreground">Signed in to {teamName}.</p><Button onClick={onContinue}>Continue<ArrowRight className="size-4" /></Button></div>;
  return <div className="space-y-5">
    <div role="group" aria-label="Workspace type" className="grid gap-3 sm:grid-cols-2">
      {([{ id: "personal", title: "Personal", description: "Your workspace. No account needed.", icon: Monitor }, { id: "team", title: "Team", description: "Shared work and accounts on this server.", icon: Users }] as const).map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} disabled={busy} onClick={() => { setMode(item.id); setError(""); }} className={cn("space-y-2 rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary", mode === item.id ? "border-primary bg-muted/50" : "border-border hover:bg-muted/30")}><item.icon className="size-5" /><span className="block text-sm font-medium">{item.title}</span><span className="block text-xs text-muted-foreground">{item.description}</span></button>)}
    </div>
    {mode === "personal" ? <Button onClick={onContinue}>Continue without an account<ArrowRight className="size-4" /></Button>
      : <form className="space-y-4" onSubmit={event => { event.preventDefault(); void createTeam(); }}>
        <label className="block space-y-2 text-sm"><span>Workspace name</span><Input value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="Security team" maxLength={160} required disabled={busy} /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm"><span>Your name</span><Input autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={160} required disabled={busy} /></label><label className="block space-y-2 text-sm"><span>Username</span><Input autoComplete="username" value={userId} onChange={event => setUserId(event.target.value)} maxLength={128} required disabled={busy} /></label></div>
        <label className="block space-y-2 text-sm"><span>Password</span><Input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={1024} required disabled={busy} /><span className="block text-xs text-muted-foreground">At least 12 characters.</span></label>
        <p className="text-xs text-muted-foreground">You’ll own the team workspace. Personal work stays separate.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Creating workspace…" : "Create team workspace"}<ArrowRight className="size-4" /></Button>
      </form>}
  </div>;
}
