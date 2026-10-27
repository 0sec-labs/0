import { LoadingState } from "@/components/state-panel";
import { useNavigate } from "react-router-dom";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared/dist/desktop-console.js";
import { createChatOnExecutionHost } from "@/console/model-source";
import { backendRouteHref } from "@/console/chat-host";
import { Tooltip } from "@/components/ui/tooltip";
import { PageHeader, PageContent } from "@/components/page-header";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, Trash2, Square, RefreshCw } from "lucide-react";
import { localControlFetch } from "@/api";
import { useBackendSelection } from "@/backend-context";
import type { BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SshHostEntry { alias: string; hostname?: string; user?: string; port?: string }
async function workerControlJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await localControlFetch(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Worker controls returned ${response.status}.`);
  return data as T;
}
interface DeployResult { backendId: string; engine: string; target: string; backendsConfig: string; tokenEnv: string }

export function WorkersPage() {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const connection = useBackendSelection();
  const hosts = useQuery({ queryKey: ["worker-hosts"], queryFn: ({ signal }) => workerControlJson<{ hosts: SshHostEntry[] }>("/api/workers/hosts", { signal }) });
  const backends = useQuery({ queryKey: ["worker-backends"], queryFn: ({ signal }) => workerControlJson<{ backends: BackendDescriptor[] }>("/api/backends", { signal }), refetchInterval: 15000 });
  const managed = useQuery({ queryKey: ["managed-workers"], queryFn: ({ signal }) => workerControlJson<{ workers: { backendId: string }[] }>("/api/workers/managed", { signal }), refetchInterval: 15000 });
  const [stopCandidate, setStopCandidate] = useState<BackendDescriptor | null>(null);
  const availableHosts = backends.data?.backends ?? connection?.backends ?? [];
  const remoteHosts = availableHosts.filter(backend => backend.id !== "local");
  const [removeCandidate, setRemoveCandidate] = useState<BackendDescriptor | null>(null);
  const [ssh, setSsh] = useState("");
  const [targetGit, setTargetGit] = useState("");
  const [forwardKey, setForwardKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DeployResult | null>(null);

  const deploy = async (body: Record<string, unknown>, label: string) => {
    if (busy) return;
    setBusy(label); setError(""); setResult(null);
    try {
      const deployed = await workerControlJson<DeployResult>("/api/workers/deploy", { method: "POST", body: JSON.stringify(body) });
      setResult(deployed);
      await cache.invalidateQueries({ queryKey: ["worker-backends"] });
      await cache.invalidateQueries({ queryKey: ["managed-workers"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deploy failed.");
    } finally {
      setBusy(null);
    }
  };

  const openHostChat = async (backendId: string) => {
    if (busy) return;
    setBusy(`open:${backendId}`); setError("");
    try {
      const created = await createChatOnExecutionHost(backendId, { title: "New chat", role: "audit", autonomyMode: DEFAULT_AUTONOMY_MODE });
      navigate(backendRouteHref(backendId, `/console/${encodeURIComponent(created.id)}`));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t create a chat on this host."); }
    finally { setBusy(null); }
  };

  const checkConnection = async (backendId: string) => {
    if (busy) return;
    setBusy(`check:${backendId}`); setError("");
    try {
      await workerControlJson(`/api/backends/${encodeURIComponent(backendId)}/handshake`);
      await cache.invalidateQueries({ queryKey: ["worker-backends"] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t connect to this host."); }
    finally { setBusy(null); }
  };

  const reconnectHost = async (backend: BackendDescriptor) => {
    if (busy) return;
    setBusy(`reconnect:${backend.id}`); setError("");
    try {
      await workerControlJson("/api/control/repair-worker", { method: "POST", body: JSON.stringify({ backendId: backend.id }) });
      await Promise.all([cache.invalidateQueries({ queryKey: ["worker-backends"] }), cache.invalidateQueries({ queryKey: ["managed-workers"] })]);
      connection?.reconnect();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t reconnect this host."); }
    finally { setBusy(null); }
  };

  const stopEngine = async () => {
    if (!stopCandidate || busy) return;
    setBusy("stop"); setError("");
    try {
      await workerControlJson(`/api/workers/${encodeURIComponent(stopCandidate.id)}/stop`, { method: "POST" });
      const stoppedId = stopCandidate.id;
      setStopCandidate(null);
      await cache.invalidateQueries({ queryKey: ["worker-backends"] });
      if (connection?.backendId === stoppedId) navigate(backendRouteHref("local", "/workers"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t stop this engine."); }
    finally { setBusy(null); }
  };

  const removeBackend = async () => {
    if (!removeCandidate || busy) return;
    setBusy("remove"); setError("");
    try {
      await workerControlJson(`/api/backends/${encodeURIComponent(removeCandidate.id)}`, { method: "DELETE" });
      const removedId = removeCandidate.id;
      setRemoveCandidate(null);
      await cache.invalidateQueries({ queryKey: ["worker-backends"] });
      await cache.invalidateQueries({ queryKey: ["managed-workers"] });
      if (connection?.backendId === removedId) navigate(backendRouteHref("local", "/workers"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t remove this connection."); }
    finally { setBusy(null); }
  };

  return (
    <PageContent>
      <PageHeader title="Hosts" summary="Manage your Mac and remote servers. Choose a host for each chat to run its agents and workflows there." />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Available hosts</h2>
        {backends.isPending && <LoadingState label="Loading registered hosts…" rows={2} />}
        {backends.error && <p role="alert" className="text-sm text-destructive">{backends.error.message}</p>}
        {backends.isSuccess && remoteHosts.length === 0 && <p className="text-sm text-muted-foreground">No remote hosts added. Add one below to run work on another machine.</p>}
        <div className="space-y-2">
          {availableHosts.map(backend => {
            const connected = backend.status === "connected";
            const isManaged = managed.data?.workers.some(worker => worker.backendId === backend.id);
            return <div key={backend.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel,16px)] bg-muted px-4 py-3 text-sm">
              <div className="min-w-0 flex-1"><p className="flex items-center gap-2 break-words font-medium"><span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${connected ? "bg-emerald-500" : backend.status === "connecting" ? "bg-amber-500" : "bg-muted-foreground/40"}`} />{backend.name}</p><p className="mt-1 text-xs text-muted-foreground">{backend.id === "local" ? "This computer" : "Remote host"} · {connected ? "Connected" : backend.status === "connecting" ? "Connecting…" : "Disconnected"}</p></div>
              <div className="flex flex-wrap gap-2">
                {connected ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void openHostChat(backend.id)}>{busy === `open:${backend.id}` ? "Opening…" : "New chat"}</Button> : isManaged ? <Button size="sm" disabled={busy !== null} onClick={() => void reconnectHost(backend)}><RefreshCw aria-hidden="true" className={busy === `reconnect:${backend.id}` ? "animate-spin motion-reduce:animate-none" : undefined} />{busy === `reconnect:${backend.id}` ? "Reconnecting…" : "Reconnect"}</Button> : <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void checkConnection(backend.id)}>{busy === `check:${backend.id}` ? "Checking…" : "Check connection"}</Button>}
                {backend.id !== "local" && connected && isManaged && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setError(""); setStopCandidate(backend); }}><Square aria-hidden="true" />Stop engine</Button>}
                {backend.id !== "local" && <Tooltip content={busy !== null ? "Wait for the current operation" : `Remove ${backend.name} connection`}><span className="inline-flex" tabIndex={busy !== null ? 0 : undefined}><Button size="icon-sm" variant="ghost" disabled={busy !== null} aria-label={`Remove ${backend.name} connection`} onClick={() => { setError(""); setRemoveCandidate(backend); }}><Trash2 aria-hidden="true" /></Button></span></Tooltip>}
              </div>
            </div>
          })}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Discovered SSH hosts</h2>
        {hosts.error && <p role="alert" className="text-sm text-destructive">{hosts.error.message}</p>}
        {hosts.isSuccess && (hosts.data?.hosts ?? []).length === 0 && <p className="text-sm text-muted-foreground">No hosts found in ~/.ssh/config.</p>}
        <div className="space-y-2">
          {(hosts.data?.hosts ?? []).map(host => (
            <div key={host.alias} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel,16px)] bg-muted px-4 py-3 text-sm">
              <span>
                <span className="font-medium">{host.alias}</span>
                <span className="ml-2 text-muted-foreground">{[host.user, host.hostname].filter(Boolean).join("@")}</span>
              </span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => deploy({ ssh: host.alias, ...(targetGit ? { targetGit } : {}), forwardProviderKey: forwardKey }, host.alias)}>
                <Play aria-hidden="true" />{busy === host.alias ? "Deploying…" : "Deploy"}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Deploy to any SSH host</h2>
        <form className="space-y-3 rounded-[var(--radius-panel,16px)] bg-muted p-4" onSubmit={event => { event.preventDefault(); if (ssh.trim()) deploy({ ssh: ssh.trim(), ...(targetGit.trim() ? { targetGit: targetGit.trim() } : {}), forwardProviderKey: forwardKey }, "manual"); }}>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>SSH host (alias from ~/.ssh/config or user@host)</span>
            <Input value={ssh} onChange={event => setSsh(event.target.value)} placeholder="user@host or config alias" disabled={busy !== null} />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>Target repository (optional — remote host clones it)</span>
            <Input value={targetGit} onChange={event => setTargetGit(event.target.value)} placeholder="https://github.com/org/repo.git" disabled={busy !== null} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={forwardKey} onChange={event => setForwardKey(event.target.checked)} disabled={busy !== null} />
            <span>Forward this machine's OpenAI key to the remote engine (user-owned hosts only)</span>
          </label>
          <Button type="submit" size="sm" disabled={busy !== null || !ssh.trim()}>
            <Plus aria-hidden="true" />{busy === "manual" ? "Deploying…" : "Deploy engine"}
          </Button>
        </form>
        {result && (
          <div className="rounded-[var(--radius-panel,16px)] bg-muted p-4 text-xs">
            <p className="font-medium">Host ready</p>
            <p className="mt-1 break-words text-muted-foreground">{result.target}</p>
            <p className="mt-1 text-muted-foreground">Start a new chat to run work on this host.</p><Button className="mt-3" size="sm" disabled={busy !== null} onClick={() => void openHostChat(result.backendId)}>{busy === `open:${result.backendId}` ? "Opening…" : "New chat on this host"}</Button>
          </div>
        )}
      </section>
      <Dialog open={stopCandidate !== null} onOpenChange={open => { if (!open && !busy) setStopCandidate(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Stop {stopCandidate?.name}?</DialogTitle><DialogDescription>Stop the Zero engine and disconnect its tunnel. Active work on that engine will be interrupted. Its files and saved connection remain.</DialogDescription></DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" disabled={busy !== null} onClick={() => setStopCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy !== null} onClick={() => void stopEngine()}>{busy === "stop" ? "Stopping…" : "Stop engine"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={removeCandidate !== null} onOpenChange={open => { if (!open && !busy) setRemoveCandidate(null); }}>
        <DialogContent><DialogHeader><DialogTitle>Remove {removeCandidate?.name}?</DialogTitle><DialogDescription>Remove this saved connection and its local credential. The engine and files on the remote host stay in place.</DialogDescription></DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" disabled={busy !== null} onClick={() => setRemoveCandidate(null)}>Cancel</Button><Button variant="destructive" disabled={busy !== null} onClick={() => void removeBackend()}>{busy === "remove" ? "Removing…" : "Remove connection"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}
