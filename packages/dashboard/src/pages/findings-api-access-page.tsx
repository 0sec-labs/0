import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus } from "lucide-react";
import { localControlFetch } from "@/api";
import { useTeamAccess } from "@/components/team-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback, QueryState } from "@/components/console-control/control-ui";

type ApiCredential = {
  id: string; name: string; scopes: string[]; createdAt: string;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt?: string | null;
};
type CreatedCredential = { credential: ApiCredential; token: string };
const dateLabel = (value: string) => new Date(value).toLocaleDateString();

export function FindingsApiAccessPage() {
  const team = useTeamAccess();
  const canManage = !team.enabled || team.user?.role === "owner";
  const cache = useQueryClient();
  const queryKey = ["findings-api-credentials", team.workspace?.id ?? "personal"];
  const credentials = useQuery({
    queryKey, enabled: canManage,
    queryFn: async ({ signal }): Promise<{ credentials: ApiCredential[] }> => {
      const response = await localControlFetch("/api/findings-access", { signal });
      if (!response.ok) throw new Error("Could not load findings API keys.");
      return response.json() as Promise<{ credentials: ApiCredential[] }>;
    },
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedCredential | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const createKey = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await localControlFetch("/api/findings-access", { method: "POST", body: JSON.stringify({ name: name.trim(), scopes: ["read:findings"] }) });
      if (!response.ok) throw new Error("Could not create this key. Check its name and your workspace access.");
      const result = await response.json() as CreatedCredential;
      if (typeof result.token !== "string" || !result.credential?.id) throw new Error("The key response was incomplete. Refresh the list before trying again.");
      // The returned secret lives only in this component, never a query/mutation cache.
      setCreated(result); setCreating(false); setName("");
      await cache.invalidateQueries({ queryKey });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this key."); }
    finally { setBusy(false); }
  };
  const revokeKey = async () => {
    if (!pendingRevoke) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await localControlFetch(`/api/findings-access/${encodeURIComponent(pendingRevoke.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not revoke this key. Refresh the list and try again.");
      if (created?.credential.id === pendingRevoke.id) setCreated(null);
      setPendingRevoke(null); setMessage("API key revoked.");
      await cache.invalidateQueries({ queryKey });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke this key."); }
    finally { setBusy(false); }
  };
  const copyKey = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.token); setMessage("API key copied."); }
    catch { setError("Could not copy automatically. Select and copy the key below."); }
  };
  const endpoint = `${window.location.origin}/api/v1/findings`;

  return <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><h1 className="text-xl font-medium">Findings API</h1><p className="text-sm text-muted-foreground">Read-only integrations for {team.workspace?.name ?? "your personal workspace"} on this server.</p></div>
      {canManage && !creating && !created && <Button onClick={() => { setCreating(true); setPendingRevoke(null); setError(""); setMessage(""); }}><Plus className="size-4" />Create API key</Button>}
    </header>
    {!canManage ? <p className="text-sm text-muted-foreground">Your workspace owner manages API access.</p> : <>
      {created && <section aria-label="New API key" className="space-y-4 rounded-xl border border-border p-5">
        <h2 className="text-base font-medium">{created.credential.name}</h2>
        <p className="text-sm text-muted-foreground">Copy this key now. It is shown only once.</p>
        <label className="block space-y-2 text-sm"><span>API key</span><Input aria-label="New findings API key" value={created.token} readOnly autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" className="font-mono" onFocus={event => event.target.select()} /></label>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void copyKey()}><Copy className="size-4" />Copy key</Button><Button variant="outline" onClick={() => { setCreated(null); setMessage(""); setError(""); }}>Done</Button></div>
      </section>}
      {creating && <form className="space-y-4 rounded-xl border border-border p-5" onSubmit={event => { event.preventDefault(); void createKey(); }}>
        <label className="block space-y-2 text-sm"><span>Key name</span><Input autoComplete="off" value={name} onChange={event => setName(event.target.value)} maxLength={160} required disabled={busy} placeholder="Reporting integration" /></label>
        <p className="text-xs text-muted-foreground">Reads findings and evidence. Expires in 90 days.</p>
        <div className="flex gap-2"><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create key"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setCreating(false); setName(""); setError(""); }}>Cancel</Button></div>
      </form>}
      <QueryState pending={credentials.isPending} error={credentials.error} retry={credentials.refetch} />
      {credentials.data && <ul className="divide-y divide-border rounded-xl border border-border px-4">
        {credentials.data.credentials.map(credential => {
          const expired = credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now();
          return <li key={credential.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="min-w-0 space-y-1"><p className="break-words text-sm font-medium">{credential.name}</p><p className="text-xs text-muted-foreground">Read findings · Created {dateLabel(credential.createdAt)}{credential.revokedAt ? " · Revoked" : expired ? " · Expired" : credential.expiresAt ? ` · Expires ${dateLabel(credential.expiresAt)}` : " · No expiry"}</p>{credential.lastUsedAt && <p className="text-xs text-muted-foreground">Last used {dateLabel(credential.lastUsedAt)}</p>}</div>
            {!credential.revokedAt && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPendingRevoke(credential); setError(""); setMessage(""); }}>Revoke</Button>}
          </li>;
        })}
        {credentials.data.credentials.length === 0 && <li className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><KeyRound className="size-4" />No API keys yet.</li>}
      </ul>}
      {pendingRevoke && <section aria-label="Confirm key revocation" className="space-y-3 rounded-xl border border-border p-5"><h2 className="break-words text-base font-medium">Revoke “{pendingRevoke.name}”?</h2><p className="text-sm text-muted-foreground">Integrations using this key will lose access. You can create a new key afterward.</p><div className="flex gap-2"><Button disabled={busy} onClick={() => void revokeKey()}>{busy ? "Revoking…" : "Revoke this key"}</Button><Button variant="outline" disabled={busy} onClick={() => setPendingRevoke(null)}>Cancel</Button></div></section>}
    </>}
    <Feedback error={error} message={message} />
    <details className="rounded-xl border border-border p-4"><summary className="text-sm font-medium">API details</summary><div className="mt-4 space-y-3 text-sm"><p className="break-all"><span className="text-muted-foreground">Endpoint</span><br /><code>{endpoint}</code></p><pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{`curl --header "Authorization: Bearer <FINDINGS_API_KEY>" "${endpoint}?limit=50"`}</pre><p className="text-xs text-muted-foreground">Send the key in the Authorization header. GET and HEAD only. Use the returned nextCursor to read additional pages.</p><p className="text-xs text-muted-foreground">Finding detail: /api/v1/findings/&lt;id&gt; · Selected export: /api/v1/findings/export?id=&lt;id&gt;</p></div></details>
    {team.enabled && <Link className="text-sm underline" to="/team">Workspace members</Link>}
  </main>;
}
