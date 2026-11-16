import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { BackendDescriptorSchema, BackendListSchema, parseBackendHandshake, type BackendDescriptor } from "@0/engine/shared/backend-protocol";
import { startVisibleInterval } from "./lib/polling";
import { makeQueryClient, SCOPED_QUERY_DEFAULTS } from "./lib/query-client";
import { createBackendApi, localControlFetch } from "./api";
import { BackendApiContext, BackendSelectionContext } from "./backend-context";
import { backendRoute } from "./lib/backend-client";
import { App } from "./App";
import { BackendConnectionPicker } from "./components/backend-connection-picker";
import { ActivityMark } from "./console/loading-state";
import { descriptorForRoute } from "./console/chat-host-readiness";
import { Button } from "./components/ui/button";
import { TeamAccess, useTeamAccess } from "./components/team-access";
import { ConnectionLost } from "./components/connection-lost";
import { ShellFrame } from "./components/shell-skeleton";
import { attachQueryPersistence } from "./lib/query-persist";
import { errorText } from "@/lib/api-error";

/** Connection health and the registry change rarely; both pause while the tab is hidden and refresh when it returns. */
const HEARTBEAT_MS = 30_000;
const BACKEND_LIST_MS = 60_000;

async function controlJson(path: string, signal?: AbortSignal) {
  const response = await localControlFetch(path, { signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (response.status === 404) throw new Error("The running computer does not support computers. Restart 0 from the current build, then reload this page.");
  if (!response.ok) throw new Error(`Connection service returned ${response.status}.`);
  if (!response.headers.get("content-type")?.includes("json")) throw new Error("Connection discovery returned a page instead of engine data. Open the URL printed by 0, rather than a standalone frontend development server.");
  return response.json() as Promise<unknown>;
}

/** Identity of an engine epoch (engine + server instance), independent of capability ordering. */
function epochOf(handshake: { engineId: string; serverInstanceId?: string }) { return `${handshake.engineId}\u0000${handshake.serverInstanceId ?? ""}`; }
/** Capabilities are a set; compare them sorted so a reordered list is not a contract change. */
function capabilityKey(capabilities: readonly string[]) { return [...capabilities].sort().join(","); }

/** Requests started at module load, before TeamAccess has answered, so the handshake and registry overlap /api/team/session. */
const EARLY_TTL_MS = 5000;
const early = new Map<string, { at: number; promise: Promise<unknown> }>();
function startEarly(path: string) { const promise = controlJson(path); promise.catch(() => {}); early.set(path, { at: Date.now(), promise }); }
function takeEarly(path: string, signal: AbortSignal): Promise<unknown> {
  const hit = early.get(path); early.delete(path);
  if (!hit || Date.now() - hit.at > EARLY_TTL_MS) return controlJson(path, signal);
  return hit.promise.catch(() => controlJson(path, signal));
}
if (typeof window !== "undefined" && backendRoute(window.location.pathname).backendId === "local") {
  startEarly("/api/backends"); startEarly("/api/backends/local/handshake");
}

/** One mounted engine scope owns all queries, local state, requests, and event cursors. */
function BackendView({ descriptor, basename }: { descriptor: BackendDescriptor; basename: string }) {
  const api = useMemo(() => createBackendApi(descriptor.id, descriptor), [descriptor.id]);
  const cache = useMemo(() => makeQueryClient({ ...SCOPED_QUERY_DEFAULTS, gcTime: 30 * 60_000 }), [descriptor.id]);
  const team = useTeamAccess();
  // Stale-while-revalidate: lists and recent mission snapshots hydrate from IndexedDB before the first render of the app,
  // then revalidate through the normal queries. Team workspaces never persist transcripts to the browser.
  // Render immediately: hydrate() never overwrites fresher data, so the restore fills in lists a few ms later without a skeleton gate.
  useEffect(() => {
    const persistence = attachQueryPersistence(cache, { backendId: descriptor.id, version: __ZERO_VERSION__, enabled: !team.enabled });
    return () => persistence.dispose();
  }, [cache, descriptor.id, team.enabled]);
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
  const api = useMemo(() => createBackendApi("local"), []);
  const cache = useMemo(() => makeQueryClient(), []);
  return <BackendApiContext value={api}><QueryClientProvider client={cache}><TeamAccess><ConnectedBackendShell /></TeamAccess></QueryClientProvider></BackendApiContext>;
}

function ConnectedBackendShell() {
  const [route, setRoute] = useState(() => backendRoute(window.location.pathname));
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [selected, setSelected] = useState<BackendDescriptor | null>(null);
  const [error, setError] = useState("");
  const [attemptBackendId,setAttemptBackendId]=useState(route.backendId);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const identity = useRef("");
  const capabilities = useRef("");
  const [refresh, setRefresh] = useState(0);
  /** A heartbeat-triggered re-handshake keeps the mounted UI until the new epoch is ready. */
  const silentRefresh = useRef(false);
  useEffect(() => {
    const listener = () => setRoute(backendRoute(window.location.pathname));
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    let live = true;
    const controller=new AbortController();
    setAttemptBackendId(route.backendId);
    const silent = silentRefresh.current; silentRefresh.current = false;
    if (!silent) setSelected(null);
    setError(""); setConnectionStatus("connecting");
    void (async () => {
      // The registry and the route's handshake are independent; start both so the handshake is not serialized behind the list.
      const handshakePath = `/api/backends/${encodeURIComponent(route.backendId)}/handshake`;
      const handshakeRequest = takeEarly(handshakePath, controller.signal);
      handshakeRequest.catch(() => {});
      const registry = BackendListSchema.parse(await takeEarly("/api/backends", controller.signal));
      if (!live) return;
      setBackends(registry.backends);
      if (!registry.backends.some(backend => backend.id === route.backendId)) throw new Error("This computer connection is not registered on the trusted host.");
      const result = await handshakeRequest as { backend?: unknown; handshake?: unknown; error?: string };
      const backend = BackendDescriptorSchema.parse(result.backend);
      if (backend.id !== route.backendId) throw new Error("Connection service returned another computer identity.");
      if (!result.handshake || backend.status !== "connected") throw new Error(result.error || backend.error || `Computer is ${backend.status}.`);
      const handshake = parseBackendHandshake(result.handshake);
      if (live) { identity.current = epochOf(handshake); capabilities.current = capabilityKey(handshake.capabilities); setConnectionStatus("connected"); setBackends(current => current.map(item => item.id === backend.id ? backend : item)); setSelected({ ...backend, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities, platform: handshake.platform }); }
    })().catch(cause => { if (live) { setConnectionStatus("disconnected"); setError(errorText(cause)); } });
    return () => { live = false;controller.abort(); };
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
        if (descriptor.id !== selected.id || descriptor.status !== "connected" || !result.handshake) throw new Error(result.error || descriptor.error || "Computer connection is disconnected.");
        const handshake = parseBackendHandshake(result.handshake);
        const nextIdentity = epochOf(handshake);
        const nextCapabilities = capabilityKey(handshake.capabilities);
        if (nextIdentity !== identity.current) {
          // A changed engine epoch discards local pending grants and reloads snapshots. The old UI stays mounted
          // (with the Reconnecting notice) until the new handshake replaces it, never a full-screen skeleton.
          identity.current = nextIdentity; capabilities.current = nextCapabilities;
          silentRefresh.current = true;
          setConnectionStatus("connecting");
          setRefresh(value => value + 1);
        } else if (nextCapabilities !== capabilities.current) {
          // Same engine, different capability set: update in place without remounting the app.
          capabilities.current = nextCapabilities;
          setConnectionStatus("connected"); setBackends(current => current.map(item => item.id === descriptor.id ? descriptor : item));
          setSelected(current => current && { ...current, ...descriptor, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities, platform: handshake.platform });
        } else { setConnectionStatus("connected"); setBackends(current => current.map(item => item.id === descriptor.id ? descriptor : item)); }
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = errorText(cause);
          setConnectionStatus("disconnected");
          setBackends(current => current.map(item => item.id === selected.id ? { ...item, status: "disconnected" } : item));
          if (/incompatible/i.test(message)) { setSelected(null); setError(message); }
        }
      } finally { pending = false; }
    };
    const stop = startVisibleInterval(() => { void heartbeat(); }, HEARTBEAT_MS);
    return () => { stop(); controller.abort(); };
  }, [selected?.id]);
  useEffect(() => {
    const controller = new AbortController();
    const stop = startVisibleInterval(() => {
      void controlJson("/api/backends", controller.signal).then(value => {
        if (!controller.signal.aborted) setBackends(BackendListSchema.parse(value).backends);
      }).catch(() => {});
    }, BACKEND_LIST_MS);
    return () => { stop(); controller.abort(); };
  }, []);
  const select = (backendId: string) => {
    if (backendId === route.backendId) return;
    // Resource navigation never carries another engine's session/run IDs.
    window.history.pushState(null, "", `/b/${encodeURIComponent(backendId)}/chats`);
    setSelected(null); setError("");setConnectionStatus("connecting");
    setRoute({ backendId, basename: `/b/${backendId}` });
  };
  const owner=descriptorForRoute(route.backendId,selected);
  const currentError=attemptBackendId===route.backendId?error:"";
  const status=attemptBackendId===route.backendId?connectionStatus:"connecting";
  const reconnect=()=>{setSelected(null);setError("");setConnectionStatus("connecting");setRefresh(value=>value+1);};
  return <BackendSelectionContext value={{ backends, backendId: route.backendId, status, select, reconnect }}><div className="backend-shell flex h-dvh flex-col overflow-hidden">
    {owner ? <BackendView key={`${route.backendId}:${refresh}`} descriptor={owner} basename={route.basename} /> : !currentError && route.backendId === "local" ? <ShellFrame /> : currentError ? <ConnectionLost backendId={route.backendId} message={currentError} onReachable={reconnect} /> : <div className="mx-auto max-w-xl space-y-3 p-8 text-sm" role="status"><BackendConnectionPicker /><div className="flex items-center gap-2.5 text-muted-foreground"><ActivityMark /><span>Connecting to host…</span></div></div>}
  </div></BackendSelectionContext>;
}
