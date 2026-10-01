import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackendDescriptorSchema, BackendListSchema, parseBackendHandshake, type BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import { createBackendApi, localControlFetch } from "./api";
import { BackendApiContext } from "./backend-context";
import { backendRoute } from "./lib/backend-client";
import { App } from "./App";

async function controlJson(path: string, signal?: AbortSignal) {
  const response = await localControlFetch(path, { signal });
  if (response.status === 404) throw new Error("The running engine does not support backend connections. Restart 0 web from the current build, then reload this page.");
  if (!response.ok) throw new Error(`Connection service returned ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("json")) throw new Error("Connection discovery returned a page instead of engine data. Open the URL printed by 0 web, rather than a standalone frontend development server.");
  return response.json() as Promise<unknown>;
}

/** One mounted engine scope owns all queries, local state, requests, and event cursors. */
function BackendView({ descriptor, basename }: { descriptor: BackendDescriptor; basename: string }) {
  const api = useMemo(() => createBackendApi(descriptor.id, descriptor), [descriptor.id]);
  const cache = useMemo(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } } }), [descriptor.id]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode's probe remount retains the scope; a real unmount disposes it.
      queueMicrotask(() => { if (!mounted.current) { api.client.dispose(); void cache.cancelQueries(); cache.clear(); } });
    };
  }, [api, cache]);
  return <BackendApiContext value={api}><QueryClientProvider client={cache}><BrowserRouter basename={basename}><div className="backend-content min-h-0 flex-1"><App /></div></BrowserRouter></QueryClientProvider></BackendApiContext>;
}

export function BackendShell() {
  const [route, setRoute] = useState(() => backendRoute(window.location.pathname));
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [selected, setSelected] = useState<BackendDescriptor | null>(null);
  const [error, setError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const identity = useRef("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const listener = () => setRoute(backendRoute(window.location.pathname));
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    let live = true;
    setSelected(null); setError(""); setConnectionStatus("connecting");
    void (async () => {
      const registry = BackendListSchema.parse(await controlJson("/api/backends"));
      if (!live) return;
      setBackends(registry.backends);
      if (!registry.backends.some(backend => backend.id === route.backendId)) throw new Error("This engine connection is not registered on the trusted host.");
      const result = await controlJson(`/api/backends/${encodeURIComponent(route.backendId)}/handshake`) as { backend?: unknown; handshake?: unknown; error?: string };
      const backend = BackendDescriptorSchema.parse(result.backend);
      if (backend.id !== route.backendId) throw new Error("Connection service returned another engine identity.");
      if (!result.handshake || backend.status !== "connected") throw new Error(result.error || backend.error || `Engine is ${backend.status}.`);
      const handshake = parseBackendHandshake(result.handshake);
      if (live) { identity.current = JSON.stringify([handshake.engineId, handshake.serverInstanceId, handshake.capabilities]); setConnectionStatus("connected"); setBackends(current => current.map(item => item.id === backend.id ? backend : item)); setSelected({ ...backend, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities, platform: handshake.platform }); }
    })().catch(cause => { if (live) { setConnectionStatus("disconnected"); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, [route.backendId, refresh]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let pending = false;
    const heartbeat = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await controlJson(`/api/backends/${encodeURIComponent(selected.id)}/handshake`, controller.signal) as { backend?: unknown; handshake?: unknown; error?: string };
        if (controller.signal.aborted) return;
        const descriptor = BackendDescriptorSchema.parse(result.backend);
        if (descriptor.id !== selected.id || descriptor.status !== "connected" || !result.handshake) throw new Error(result.error || descriptor.error || "Engine connection is disconnected.");
        const handshake = parseBackendHandshake(result.handshake);
        const nextIdentity = JSON.stringify([handshake.engineId, handshake.serverInstanceId, handshake.capabilities]);
        if (nextIdentity !== identity.current) {
          // A changed engine epoch/capability contract discards local pending grants and reloads snapshots.
          identity.current = nextIdentity;
          setRefresh(value => value + 1);
        } else { setConnectionStatus("connected"); setBackends(current => current.map(item => item.id === descriptor.id ? descriptor : item)); }
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setConnectionStatus("disconnected");
          setBackends(current => current.map(item => item.id === selected.id ? { ...item, status: "disconnected" } : item));
          if (/incompatible/i.test(message)) { setSelected(null); setError(message); }
        }
      } finally { pending = false; }
    };
    const timer = setInterval(() => { void heartbeat(); }, 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [selected?.id]);
  const select = (backendId: string) => {
    if (backendId === route.backendId) return;
    // Resource navigation never carries another engine's session/run IDs.
    window.history.pushState(null, "", `/b/${encodeURIComponent(backendId)}/console`);
    setSelected(null); setConnectionStatus("connecting");
    setRoute({ backendId, basename: `/b/${backendId}` });
  };
  return <div className="backend-shell flex h-dvh flex-col overflow-hidden">
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2 text-xs">
      <label className="flex items-center gap-2">Engine<select aria-label="Execution engine" className="max-w-64 rounded bg-muted px-2 py-1" value={route.backendId} onChange={event => select(event.target.value)}>{backends.length ? backends.map(backend => <option key={backend.id} value={backend.id}>{backend.name} · {backend.status}</option>) : <option value={route.backendId}>{route.backendId}</option>}</select></label>
      <span className="text-muted-foreground">{selected ? `${connectionStatus} · ${selected.platform?.os ?? "Engine workspace"} · paths belong to this engine` : error ? "Disconnected" : "Connecting…"}</span>
    </div>
    {selected ? <BackendView key={`${route.backendId}:${refresh}`} descriptor={selected} basename={route.basename} /> : <div className="mx-auto max-w-xl p-8 text-sm" role="status">{error || "Connecting to execution engine…"}{error && <button className="ml-3 underline" onClick={() => setRefresh(value => value + 1)}>Reconnect</button>}</div>}
  </div>;
}
