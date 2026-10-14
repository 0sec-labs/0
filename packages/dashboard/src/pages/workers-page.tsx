import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, Server } from "lucide-react";
import { localControlFetch } from "@/api";
import { useBackendSelection } from "@/backend-context";
import type { BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const connection = useBackendSelection();
  const hosts = useQuery({ queryKey: ["worker-hosts"], queryFn: ({ signal }) => workerControlJson<{ hosts: SshHostEntry[] }>("/api/workers/hosts", { signal }) });
  const backends = useQuery({ queryKey: ["worker-backends"], queryFn: ({ signal }) => workerControlJson<{ backends: BackendDescriptor[] }>("/api/backends", { signal }), refetchInterval: 15000 });
  const remoteBackends = backends.data?.backends.filter(backend => backend.id !== "local") ?? [];
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deploy failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 p-6">
      <header className="flex items-center gap-3">
        <Server className="size-5 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-medium">Workers</h1>
          <p className="text-sm text-muted-foreground">Deploy a Zero engine onto a remote host. Workflows then run there; evidence returns here.</p>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Registered backends</h2>
        {backends.isPending && <p className="text-sm text-muted-foreground">Loading registered computers…</p>}
        {backends.error && <p role="alert" className="text-sm text-destructive">{backends.error.message}</p>}
        {backends.isSuccess && remoteBackends.length === 0 && <p className="text-sm text-muted-foreground">No remote backends registered. Deploy one below.</p>}
        <div className="space-y-2">
          {remoteBackends.map(backend => (
            <div key={backend.id} className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3 text-sm">
              <span className="font-medium">{backend.name}</span>
              <span className="text-muted-foreground">{backend.id} · {backend.status}</span>
              <Button size="sm" variant="outline" onClick={() => connection?.select(backend.id)}>Connect</Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Discovered SSH hosts</h2>
        {hosts.error && <p role="alert" className="text-sm text-destructive">{hosts.error.message}</p>}
        {hosts.isSuccess && (hosts.data?.hosts ?? []).length === 0 && <p className="text-sm text-muted-foreground">No hosts found in ~/.ssh/config.</p>}
        <div className="space-y-2">
          {(hosts.data?.hosts ?? []).map(host => (
            <div key={host.alias} className="flex items-center justify-between rounded-2xl bg-muted px-4 py-3 text-sm">
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
        <form className="space-y-3 rounded-2xl bg-muted p-4" onSubmit={event => { event.preventDefault(); if (ssh.trim()) deploy({ ssh: ssh.trim(), ...(targetGit.trim() ? { targetGit: targetGit.trim() } : {}), forwardProviderKey: forwardKey }, "manual"); }}>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>SSH host (alias from ~/.ssh/config or user@host)</span>
            <Input value={ssh} onChange={event => setSsh(event.target.value)} placeholder="user@host or config alias" disabled={busy !== null} />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>Target repository (optional — worker clones it)</span>
            <Input value={targetGit} onChange={event => setTargetGit(event.target.value)} placeholder="https://github.com/org/repo.git" disabled={busy !== null} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={forwardKey} onChange={event => setForwardKey(event.target.checked)} disabled={busy !== null} />
            <span>Forward this machine's OpenAI key to the worker engine (user-owned hosts only)</span>
          </label>
          <Button type="submit" size="sm" disabled={busy !== null || !ssh.trim()}>
            <Plus aria-hidden="true" />{busy === "manual" ? "Deploying…" : "Deploy worker"}
          </Button>
        </form>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {result && (
          <div className="rounded-2xl bg-muted p-4 text-xs">
            <p className="font-medium">Worker ready</p>
            <p className="mt-1 text-muted-foreground">backend <span className="font-mono">{result.backendId}</span> · engine <span className="font-mono">{result.engine}</span> · target <span className="font-mono">{result.target}</span></p>
            <p className="mt-1 text-muted-foreground">Select it in the backend switcher, then start a conversation or workflow there.</p>
          </div>
        )}
      </section>
    </div>
  );
}
