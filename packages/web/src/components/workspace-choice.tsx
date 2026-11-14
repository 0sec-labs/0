import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Monitor, Users, ArrowRight } from "lucide-react";
import { localControlFetch } from "@/api";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/console-control/control-ui";
import { ChoiceCard } from "@/components/ui/choice-card";

export interface WorkspaceChoiceHandle { submit: () => void }
export interface WorkspaceChoiceAction { ready: boolean; busy: boolean; label: string; showAction: boolean }
export const WorkspaceChoice = forwardRef<WorkspaceChoiceHandle, { stacked?: boolean; teamName?: string; initialMode?: "personal" | "team"; onContinue: () => void; externalActions?: boolean; onActionChange?: (action: WorkspaceChoiceAction) => void }>(function WorkspaceChoice({ teamName, initialMode = "personal", onContinue, stacked = false, externalActions = false, onActionChange }, ref) {
  const [mode, setMode] = useState<"personal" | "team">(teamName ? "team" : initialMode);
  const [workspaceName, setWorkspaceName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const ready = Boolean(teamName || mode === "personal" || (workspaceName.trim() && displayName.trim() && userId.trim() && password.length >= 12));
  const label = busy ? "Creating workspace…" : teamName || mode === "personal" ? "Continue" : "Create team workspace";
  useEffect(() => { onActionChange?.({ ready, busy, label, showAction: Boolean(teamName || mode === "team") }); }, [ready, busy, label, teamName, mode, onActionChange]);
  useImperativeHandle(ref, () => ({ submit: () => { if (!busy) { if (teamName) onContinue(); else form.current?.requestSubmit(); } } }));
  const createTeam = async () => {
    setBusy(true); setError("");
    try {
      const response = await localControlFetch("/api/team/setup", { method: "POST", body: JSON.stringify({ workspaceName, displayName, userId, password }) });
      const result = await response.json() as { enabled?: boolean; error?: string };
      if (!response.ok || !result.enabled) throw new Error(result.error || "Could not create the workspace.");
      setPassword("");
      window.location.assign("/onboarding?step=connect");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the workspace."); }
    finally { setBusy(false); }
  };
  if (teamName) return <div className="space-y-4"><p className="text-sm text-muted-foreground">Signed in to {teamName}.</p>{!externalActions && <Button onClick={onContinue}>Continue<ArrowRight className="size-4" /></Button>}</div>;
  return <form ref={form} className="space-y-5" onSubmit={event => { event.preventDefault(); if (mode === "personal") onContinue(); else void createTeam(); }}>
    <div role="group" aria-label="Workspace type" className={stacked ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
      {([{ id: "personal", title: "Solo", description: "Your work stays on this host. No team login required.", icon: Monitor }, { id: "team", title: "Team", description: "Shared access for your team on this host.", icon: Users }] as const).map(item => <ChoiceCard key={item.id} selected={mode === item.id} disabled={busy} onClick={() => { setMode(item.id); setError(""); if (item.id === "personal") onContinue(); }} className="flex-col items-start gap-2"><item.icon className="size-5" /><span className="block text-sm font-medium">{item.title}</span><span className="block text-xs text-muted-foreground">{item.description}</span></ChoiceCard>)}
    </div>
    {mode === "personal" ? null
      : <div className="space-y-4">
        <TextField label="Workspace name" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} placeholder="Security team" maxLength={160} required disabled={busy} />
        <div className={stacked ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}><TextField label="Your name" autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={160} required disabled={busy} /><TextField label="Username" autoComplete="username" value={userId} onChange={event => setUserId(event.target.value)} maxLength={128} required disabled={busy} /></div>
        <TextField label="Password" hint="At least 12 characters." type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={1024} required disabled={busy} />
        <p className="text-xs text-muted-foreground">You’ll own the team workspace. Solo work stays separate.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!externalActions && <Button type="submit" disabled={busy}>{busy ? "Creating workspace…" : "Create team workspace"}<ArrowRight className="size-4" /></Button>}
      </div>}
  </form>;
});
