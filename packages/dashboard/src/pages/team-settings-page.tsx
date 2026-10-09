import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { localControlFetch } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Feedback, QueryState } from "@/components/console-control/control-ui";

type WorkspaceMember = { userId: string; displayName: string; role: "owner" | "editor" | "viewer" };
type NewMember = { userId: string; displayName: string; password: string; role: "editor" | "viewer" };

export function TeamSettingsPage() {
  const team = useTeamAccess();
  const cache = useQueryClient();
  const owner = team.user?.role === "owner";
  const queryKey = ["team-users", team.workspace?.id];
  const members = useQuery({
    queryKey,
    enabled: team.enabled && Boolean(team.user),
    queryFn: async ({ signal }): Promise<{ users: WorkspaceMember[] }> => {
      const response = await localControlFetch("/api/team/users", { signal });
      if (!response.ok) throw new Error("Could not load workspace members.");
      return response.json() as Promise<{ users: WorkspaceMember[] }>;
    },
  });
  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<NewMember["role"]>("editor");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addMember = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const input: NewMember = { userId: userId.trim(), displayName: displayName.trim(), password, role };
      const response = await localControlFetch("/api/team/users", { method: "POST", body: JSON.stringify(input) });
      if (!response.ok) {
        // Do not reflect submitted account fields or password into an error.
        if (response.status === 409) throw new Error("Could not save this account. Refresh the member list and try again.");
        if (response.status === 403) throw new Error("Only the workspace owner can add teammates.");
        throw new Error("Could not add this teammate. Check the fields and try again.");
      }
      setPassword(""); setUserId(""); setDisplayName(""); setRole("editor"); setAdding(false);
      setMessage("Teammate added. They can sign in on this server.");
      await cache.invalidateQueries({ queryKey });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this teammate."); }
    finally { setBusy(false); }
  };
  const cancel = () => { setAdding(false); setPassword(""); setError(""); };

  if (!team.enabled) return <main className="mx-auto w-full max-w-3xl space-y-4 p-6">
    <h1 className="text-xl font-medium">Team workspace</h1>
    <p className="text-sm text-muted-foreground">You’re using a personal workspace.</p>
    <Button asChild><Link to="/setup?step=workspace&mode=team">Create a team workspace</Link></Button>
  </main>;

  return <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h1 className="text-xl font-medium">{team.workspace?.name ?? "Team workspace"}</h1><p className="text-sm text-muted-foreground">Workspace members</p></div>
      {owner && !adding && <Button onClick={() => { setAdding(true); setMessage(""); setError(""); }}><Plus className="size-4" />Add teammate</Button>}
    </header>
    <QueryState pending={members.isPending} error={members.error} retry={members.refetch} />
    {members.data && <ul className="divide-y divide-border rounded-xl border border-border px-4">
      {members.data.users.map(member => <li key={member.userId} className="flex items-center gap-3 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs" aria-hidden="true">{member.displayName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span>
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{member.displayName}{member.userId === team.user?.userId && <span className="font-normal text-muted-foreground"> · You</span>}</p><p className="break-words text-xs text-muted-foreground">{member.userId}</p></div>
        <span className="text-xs capitalize text-muted-foreground">{member.role}</span>
      </li>)}
      {members.data.users.length === 0 && <li className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Users className="size-4" />No members found.</li>}
    </ul>}
    {!owner && <p className="text-sm text-muted-foreground">Your workspace owner manages teammates.</p>}
    {owner && adding && <form className="space-y-4 rounded-xl border border-border p-5" onSubmit={event => { event.preventDefault(); void addMember(); }}>
      <h2 className="text-base font-medium">Add teammate</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-2 text-sm"><span>Username</span><Input autoComplete="off" value={userId} onChange={event => setUserId(event.target.value)} maxLength={128} required disabled={busy} /></label>
        <label className="block space-y-2 text-sm"><span>Display name</span><Input autoComplete="off" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={160} required disabled={busy} /></label>
      </div>
      <label className="block space-y-2 text-sm"><span>Initial password</span><Input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} maxLength={1024} required disabled={busy} /><span className="block text-xs text-muted-foreground">At least 12 characters.</span></label>
      <label className="block space-y-2 text-sm"><span>Role</span><Select aria-label="Teammate role" value={role} onValueChange={value => setRole(value as NewMember["role"])} disabled={busy} options={[{ value: "editor", label: "Editor" }, { value: "viewer", label: "Viewer" }]} /><span className="block text-xs text-muted-foreground">Editors can run agents and edit shared work. Viewers can read.</span></label>
      <Feedback error={error} />
      <div className="flex gap-2"><Button type="submit" disabled={busy || !userId.trim() || !displayName.trim() || password.length < 12}>{busy ? "Adding…" : "Add teammate"}</Button><Button type="button" variant="outline" disabled={busy} onClick={cancel}>Cancel</Button></div>
    </form>}
    <Feedback message={message} />
    <Link className="inline-block text-sm underline" to="/api-access">Findings API</Link>
  </main>;
}
