import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { LoadingState } from "@/components/state-panel";
import { useNavigate } from "react-router-dom";
import { DEFAULT_AUTONOMY_MODE } from "@0/engine/dist/shared/desktop-console.js";
import { createChatOnExecutionHost } from "@/console/model-source";
import { backendRouteHref } from "@/console/chat-host";
import { Tooltip } from "@/components/ui/tooltip";
import { PageHeader, PageContent } from "@/components/page-header";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Square, RefreshCw, Search } from "lucide-react";
import { CapyPlayIcon as Play, CapyPlusIcon as Plus, CapyMoreIcon as MoreHorizontal } from "@/ui/icons/capy";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Disclosure } from "@/components/ui/disclosure";
import { localControlFetch } from "@/api";
import { useBackendSelection } from "@/backend-context";
import type { BackendDescriptor } from "@0/engine/dist/shared/backend-protocol.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { errorText } from "@/lib/api-error";

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
  const hosts = useQuery({ queryKey: queryKeys.workerHosts(), queryFn: ({ signal }) => workerControlJson<{ hosts: SshHostEntry[] }>("/api/workers/hosts", { signal }) });
  const backends = useQuery({ queryKey: queryKeys.workerBackends(), queryFn: ({ signal }) => workerControlJson<{ backends: BackendDescriptor[] }>("/api/backends", { signal }), refetchInterval: 15000 });
  const managed = useQuery({ queryKey: queryKeys.managedWorkers(), queryFn: ({ signal }) => workerControlJson<{ workers: { backendId: string }[] }>("/api/workers/managed", { signal }), refetchInterval: 15000 });
  const [stopCandidate, setStopCandidate] = useState<BackendDescriptor | null>(null);
  const availableHosts = backends.data?.backends ?? connection?.backends ?? [];
  const remoteHosts = availableHosts.filter(backend => backend.id !== "local");
  const [removeCandidate, setRemoveCandidate] = useState<BackendDescriptor | null>(null);
  const [ssh, setSsh] = useState("");
  const [targetGit, setTargetGit] = useState("");
  const [forwardKey, setForwardKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<DeployResult | null>(null);

  const deploy = async (body: Record<string, unknown>, label: string) => {
    if (busy) return;
    setBusy(label); setError(""); setResult(null);
    try {
      const deployed = await workerControlJson<DeployResult>("/api/workers/deploy", { method: "POST", body: JSON.stringify(body) });
      setResult(deployed); setAddOpen(false); setQuery("");
      await cache.invalidateQueries({ queryKey: queryKeys.workerBackends() });
      await cache.invalidateQueries({ queryKey: queryKeys.managedWorkers() });
    } catch (cause) {
      setError(errorText(cause, "Deploy failed."));
    } finally {
      setBusy(null);
    }
  };

  const openHostChat = async (backendId: string) => {
    if (busy) return;
    setBusy(`open:${backendId}`); setError("");
    try {
      const created = await createChatOnExecutionHost(backendId, { title: v("New {mission}"), role: "audit", autonomyMode: DEFAULT_AUTONOMY_MODE });
      navigate(backendRouteHref(backendId, `/chats/${encodeURIComponent(created.id)}`));
    } catch (cause) { setError(errorText(cause, v("Couldn’t create {a mission} on this engine."))); }
    finally { setBusy(null); }
  };

  const checkConnection = async (backendId: string) => {
    if (busy) return;
    setBusy(`check:${backendId}`); setError("");
    try {
      await workerControlJson(`/api/backends/${encodeURIComponent(backendId)}/handshake`);
      await cache.invalidateQueries({ queryKey: queryKeys.workerBackends() });
    } catch (cause) { setError(errorText(cause, "Couldn’t connect to this engine.")); }
    finally { setBusy(null); }
  };

  const reconnectHost = async (backend: BackendDescriptor) => {
    if (busy) return;
    setBusy(`reconnect:${backend.id}`); setError("");
    try {
      await workerControlJson("/api/control/repair-worker", { method: "POST", body: JSON.stringify({ backendId: backend.id }) });
      await Promise.all([cache.invalidateQueries({ queryKey: queryKeys.workerBackends() }), cache.invalidateQueries({ queryKey: queryKeys.managedWorkers() })]);
      connection?.reconnect();
    } catch (cause) { setError(errorText(cause, "Couldn’t reconnect this engine.")); }
    finally { setBusy(null); }
  };

  const stopEngine = async () => {
    if (!stopCandidate || busy) return;
    setBusy("stop"); setError("");
    try {
      await workerControlJson(`/api/workers/${encodeURIComponent(stopCandidate.id)}/stop`, { method: "POST" });
      const stoppedId = stopCandidate.id;
      setStopCandidate(null);
      await cache.invalidateQueries({ queryKey: queryKeys.workerBackends() });
      if (connection?.backendId === stoppedId) navigate(backendRouteHref("local", "/engines"));
    } catch (cause) { setError(errorText(cause, "Couldn’t stop this engine.")); }
    finally { setBusy(null); }
  };

  const removeBackend = async () => {
    if (!removeCandidate || busy) return;
    setBusy("remove"); setError("");
    try {
      await workerControlJson(`/api/backends/${encodeURIComponent(removeCandidate.id)}`, { method: "DELETE" });
      const removedId = removeCandidate.id;
      setRemoveCandidate(null);
      await cache.invalidateQueries({ queryKey: queryKeys.workerBackends() });
      await cache.invalidateQueries({ queryKey: queryKeys.managedWorkers() });
      if (connection?.backendId === removedId) navigate(backendRouteHref("local", "/engines"));
    } catch (cause) { setError(errorText(cause, "Couldn’t remove this connection.")); }
    finally { setBusy(null); }
  };

  const needle = query.trim().toLowerCase();
  const discovered = (hosts.data?.hosts ?? []).filter(host => !needle || `${host.alias} ${host.user ?? ""} ${host.hostname ?? ""}`.toLowerCase().includes(needle));
  const statusLabel = (backend: BackendDescriptor) => backend.status === "connected" ? "Connected" : backend.status === "connecting" ? "Connecting…" : "Disconnected";

  return (
    <PageContent>
      <PageHeader title="Engines" summary={v("Run {missions} on this computer or a remote server.")} actions={<Button size="sm" disabled={busy !== null} onClick={() => { setError(""); setAddOpen(true); }}><Plus aria-hidden="true" />Add engine</Button>} />

      <section aria-label="Engines" className="space-y-3">
        {backends.isPending && <LoadingState label="Loading engines…" rows={2} />}
        {backends.error && <p role="alert" className="text-sm text-destructive">{backends.error.message}</p>}
        {availableHosts.length > 0 && <ul className="divide-y-[0.5px] divide-[var(--card-hairline)] overflow-hidden rounded-[var(--radius-panel,16px)] border-[0.5px] border-[var(--card-hairline)] bg-card">
          {availableHosts.map(backend => {
            const connected = backend.status === "connected";
            const isManaged = managed.data?.workers.some(worker => worker.backendId === backend.id) ?? false;
            const remote = backend.id !== "local";
            return <li key={backend.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${connected ? "bg-emerald-500" : backend.status === "connecting" ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{backend.name}</p><p className="truncate text-xs text-muted-foreground">{remote ? "Remote engine" : "This computer"} · {statusLabel(backend)}</p></div>
              {connected && <Button size="sm" variant="outline" className="shrink-0" disabled={busy !== null} onClick={() => void openHostChat(backend.id)}>{busy === `open:${backend.id}` ? "Opening…" : v("New {mission}")}</Button>}
              {remote && <DropdownMenu><DropdownMenu.Trigger aria-label={`${backend.name} options`} className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  {isManaged ? <DropdownMenu.Item disabled={busy !== null} icon={<RefreshCw className="size-4" />} onClick={() => void reconnectHost(backend)}>{busy === `reconnect:${backend.id}` ? "Reconnecting…" : "Reconnect"}</DropdownMenu.Item> : <DropdownMenu.Item disabled={busy !== null} icon={<RefreshCw className="size-4" />} onClick={() => void checkConnection(backend.id)}>{busy === `check:${backend.id}` ? "Checking…" : "Check connection"}</DropdownMenu.Item>}
                  {connected && isManaged && <DropdownMenu.Item disabled={busy !== null} icon={<Square className="size-4" />} onClick={() => { setError(""); setStopCandidate(backend); }}>Stop engine</DropdownMenu.Item>}
                  <DropdownMenu.Item variant="danger" disabled={busy !== null} icon={<Trash2 className="size-4" />} onClick={() => { setError(""); setRemoveCandidate(backend); }}>Remove</DropdownMenu.Item>
                </DropdownMenu.Content></DropdownMenu>}
            </li>;
          })}
        </ul>}
        {backends.isSuccess && remoteHosts.length === 0 && <p className="text-sm text-muted-foreground">No remote engines yet.</p>}
        {error && !addOpen && !stopCandidate && !removeCandidate && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-panel,16px)] border-[0.5px] border-[var(--card-hairline)] bg-card px-4 py-3 text-sm">
            <div className="min-w-0"><p className="font-medium">Engine ready</p><p className="truncate text-xs text-muted-foreground">{result.target}</p></div>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void openHostChat(result.backendId)}>{busy === `open:${result.backendId}` ? "Opening…" : v("New {mission}")}</Button>
          </div>
        )}
      </section>

      <Dialog open={addOpen} onOpenChange={open => { if (!open && !busy) setAddOpen(false); }}>
        <DialogContent><DialogHeader><DialogTitle>Add engine</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {hosts.error && <p role="alert" className="text-sm text-destructive">{hosts.error.message}</p>}
            {(hosts.data?.hosts ?? []).length > 0 ? <>
              <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search SSH hosts" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search hosts from ~/.ssh/config" /></div>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-[var(--radius-menu,12px)] border border-border">
                {discovered.map(host => <li key={host.alias} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{host.alias}</p><p className="truncate text-xs text-muted-foreground">{[host.user, host.hostname].filter(Boolean).join("@")}</p></div>
                  <Button size="sm" variant="outline" className="shrink-0" disabled={busy !== null} onClick={() => deploy({ ssh: host.alias, ...(targetGit ? { targetGit } : {}), forwardProviderKey: forwardKey }, host.alias)}><Play aria-hidden="true" />{busy === host.alias ? "Deploying…" : "Deploy"}</Button>
                </li>)}
                {discovered.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No matching engines.</li>}
              </ul>
            </> : hosts.isSuccess && <p className="text-sm text-muted-foreground">No SSH hosts found in ~/.ssh/config. Enter one below.</p>}
            <Disclosure summary={<>Other server or options</>} triggerClassName="cursor-pointer py-1 text-xs text-muted-foreground">
              <form className="space-y-3 pt-2" onSubmit={event => { event.preventDefault(); if (ssh.trim()) deploy({ ssh: ssh.trim(), ...(targetGit.trim() ? { targetGit: targetGit.trim() } : {}), forwardProviderKey: forwardKey }, "manual"); }}>
                <label className="block space-y-1 text-xs text-muted-foreground"><span>SSH host (user@host or config alias)</span><Input value={ssh} onChange={event => setSsh(event.target.value)} placeholder="user@host" disabled={busy !== null} /></label>
                <label className="block space-y-1 text-xs text-muted-foreground"><span>Target repository (optional)</span><Input value={targetGit} onChange={event => setTargetGit(event.target.value)} placeholder="https://github.com/org/repo.git" disabled={busy !== null} /></label>
                <label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" className="mt-0.5" checked={forwardKey} onChange={event => setForwardKey(event.target.checked)} disabled={busy !== null} /><span>Forward this machine's OpenAI key to the remote engine (user-owned hosts only)</span></label>
                <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !ssh.trim()}>{busy === "manual" ? "Deploying…" : "Deploy engine"}</Button>
              </form>
            </Disclosure>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={stopCandidate !== null} onOpenChange={open => { if (!open) setStopCandidate(null); }} pending={busy !== null} destructive
        title={`Stop ${stopCandidate?.name}?`}
        description="Active work on that engine will be interrupted."
        error={error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        confirmLabel={busy === "stop" ? "Stopping…" : "Stop engine"} onConfirm={() => void stopEngine()} />
      <ConfirmDialog open={removeCandidate !== null} onOpenChange={open => { if (!open) setRemoveCandidate(null); }} pending={busy !== null} destructive
        title={`Remove ${removeCandidate?.name}?`}
        description="Removes the saved connection and its local credential."
        error={error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        confirmLabel={busy === "remove" ? "Removing…" : "Remove connection"} onConfirm={() => void removeBackend()} />
    </PageContent>
  );
}
