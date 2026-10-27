import { createContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BackendDescriptorSchema, parseBackendHandshake, type BackendDescriptor } from "@0/shared/dist/backend-protocol.js";
import { createBackendApi, localControlFetch, useBackendApi } from "./api";
import { BackendApiContext, BackendSelectionContext, useBackendSelection } from "./backend-context";

import { useTeamAccess } from "./components/team-access";
import { ActivityMark } from "./console/loading-state";
import { Button } from "./components/ui/button";
import { chatHostReadiness } from "./console/chat-host-readiness";
import { boundChatHostSelection, chatHostScopeKey } from "./console/chat-host";

export interface ChatHostActions { backendId: string; onSelectHost?: (backendId: string) => void }
export const ChatHostActionsContext = createContext<ChatHostActions | null>(null);
/** Bind selector actions to this chat; absent callbacks never mutate the global host. */
export function ChatHostSelectionScope({ backendId, onSelectHost, children, reconnect }: ChatHostActions & { children: ReactNode; reconnect?: () => void }) {
  const registry = useBackendSelection();
  const bound = useMemo(() => boundChatHostSelection(registry, backendId, onSelectHost, reconnect), [registry?.backends, registry?.backendId, registry?.status, backendId, onSelectHost, reconnect]);
  return <BackendSelectionContext value={bound}><ChatHostActionsContext value={{ backendId, onSelectHost }}>{children}</ChatHostActionsContext></BackendSelectionContext>;
}

/** A chat's transport and query cache stay attached to its host for its entire lifetime. */
function ConnectedChatHost({ descriptor, children }: { descriptor: BackendDescriptor; children: ReactNode }) {
  const team = useTeamAccess();
  const scope = chatHostScopeKey(descriptor.id, team.user?.workspaceId, team.user?.userId);
  const api = useMemo(() => createBackendApi(descriptor.id, descriptor), [scope]);
  const cache = useMemo(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true } } }), [scope]);
  const liveApis = useRef(new Set<typeof api>());
  useEffect(() => {
    liveApis.current.add(api);
    return () => {
      liveApis.current.delete(api);
      // A StrictMode probe can re-acquire this exact API; a new account cannot.
      queueMicrotask(() => { if (!liveApis.current.has(api)) { api.client.dispose(); void cache.cancelQueries(); cache.clear(); } });
    };
  }, [api, cache]);
  return <BackendApiContext value={api}><QueryClientProvider client={cache}>{children}</QueryClientProvider></BackendApiContext>;
}

function RemoteChatHost({ backendId, children, onSelectHost }: ChatHostActions & { children: ReactNode }) {
  const team = useTeamAccess();
  const accountScope = chatHostScopeKey(backendId, team.user?.workspaceId, team.user?.userId);
  const selection = useBackendSelection();
  const registered = selection?.backends.some(backend => backend.id === backendId) === true;
  const handshake = useQuery({
    queryKey: ["chat-host-handshake", accountScope], enabled: registered, retry: false, networkMode: "always", staleTime: 15_000, refetchInterval: 15_000, refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const response = await localControlFetch(`/api/backends/${encodeURIComponent(backendId)}/handshake`, { signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(`Host connection returned ${response.status}.`);
      const value = await response.json() as { backend?: unknown; handshake?: unknown; error?: string };
      const descriptor = BackendDescriptorSchema.parse(value.backend);
      if (descriptor.id !== backendId || descriptor.status !== "connected" || !value.handshake) throw new Error(value.error || descriptor.error || "Host is disconnected.");
      const protocol = parseBackendHandshake(value.handshake);
      return { descriptor: { ...descriptor, protocolVersion: protocol.protocolVersion, capabilities: protocol.capabilities, platform: protocol.platform }, epoch: protocol.serverInstanceId };
    },
  });
  const verifiedSelection=useMemo(()=>{
    const verified=handshake.data?.descriptor;
    const status=handshake.error?"disconnected":"connected";
    const current=verified?{...verified,status:status as "connected"|"disconnected"}:undefined;
    return {backends:(selection?.backends??[]).map(host=>current && host.id===backendId?current:host),backendId,status,select:onSelectHost??(()=>{}),reconnect:()=>{void handshake.refetch();}};
  },[selection?.backends,handshake.data?.descriptor,Boolean(handshake.error),backendId,onSelectHost,handshake.refetch]);
  const readiness=chatHostReadiness({registryReady:Boolean(selection && (selection.backends.length>0 || selection.status==="disconnected")),registered,fetchedAfterMount:handshake.isFetchedAfterMount,fetching:handshake.isFetching,hasData:Boolean(handshake.data),hasError:Boolean(handshake.error)});
  if(readiness==="connecting")return <div role="status" className="flex items-center gap-2.5 p-6 text-sm text-muted-foreground"><ActivityMark /><span>Connecting to {selection?.backends.find(host=>host.id===backendId)?.name || "this chat’s host"}…</span></div>;
  if(readiness==="unregistered")return <div role="status" className="p-6 text-sm text-muted-foreground">This chat’s host is no longer registered. Reconnect it from Hosts.</div>;
  if(readiness==="failed" || !handshake.data)return <div role="status" className="space-y-3 p-6 text-sm text-muted-foreground"><p>{handshake.error?.message || "Couldn't connect to this host."}</p><Button variant="outline" size="sm" onClick={()=>void handshake.refetch()}>Reconnect host</Button></div>;
  return <BackendSelectionContext value={verifiedSelection}><ConnectedChatHost key={`${accountScope}:${handshake.data.epoch}`} descriptor={handshake.data.descriptor}><ChatHostSelectionScope backendId={backendId} onSelectHost={onSelectHost} reconnect={verifiedSelection.reconnect}>{children}</ChatHostSelectionScope></ConnectedChatHost></BackendSelectionContext>;
}

/** Nest around embedded chats only; it never changes the workspace's selected host. */
export function ChatBackendScope({ backendId, children, onSelectHost }: ChatHostActions & { children: ReactNode }) {
  const parent = useBackendApi();
  return backendId === parent.client.backendId ? <ChatHostSelectionScope backendId={backendId} onSelectHost={onSelectHost}>{children}</ChatHostSelectionScope> : <RemoteChatHost backendId={backendId} onSelectHost={onSelectHost}>{children}</RemoteChatHost>;
}
