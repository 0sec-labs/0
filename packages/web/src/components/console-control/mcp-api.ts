import { queryKeys } from "@/queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import type { McpServerPayload } from "./mcp-model";
import { connectionsClient, isUnsupported, mcpClient, type ConnectionsState } from "./mcp-contract";

export const mcpQueryKey = ["console-mcp-servers"] as const;
export const connectionsQueryKey = queryKeys.consoleConnections();
const retryUnlessUnsupported = (count: number, error: unknown) => !isUnsupported(error) && count < 2;

/** Custom MCP servers and GitHub plugins. `supported` is false against a host that predates these routes, so the page keeps today's behaviour. */
export function useMcpServers() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const client = mcpClient(webFetchJson);
  const query = useQuery({ queryKey: mcpQueryKey, queryFn: ({ signal }) => client.list(signal), refetchInterval: 15_000, retry: retryUnlessUnsupported });
  const supported = !query.isError || !isUnsupported(query.error);
  const refresh = async () => { await Promise.all([mcpQueryKey, ["console-plugins"], ["console-tools"], ["workflow-tool-catalog"]].map(queryKey => queryClient.invalidateQueries({ queryKey }))); };
  return {
    query, supported, servers: supported ? query.data ?? [] : [],
    preview: useMutation({ mutationFn: (config: McpServerPayload) => client.preview(config) }),
    create: useMutation({ mutationFn: ({ config, fingerprint, enable }: { config: McpServerPayload; fingerprint: string; enable: boolean }) => client.create(config, fingerprint, enable), onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ id, ...patch }: { id: string; enabled?: boolean; approvedFingerprint?: string }) => client.update(id, patch), onSuccess: refresh, onError: () => { void query.refetch(); } }),
    remove: useMutation({ mutationFn: ({ id }: { id: string }) => client.remove(id), onSuccess: refresh }),
    test: useMutation({ mutationFn: ({ id }: { id: string }) => client.test(id), onSettled: refresh }),
    githubReview: useMutation({ mutationFn: (input: { repo: string; ref?: string }) => client.githubReview(input) }),
    githubApprove: useMutation({ mutationFn: (input: Parameters<typeof client.githubApprove>[0]) => client.githubApprove(input), onSuccess: refresh }),
  };
}
export type McpActions = ReturnType<typeof useMcpServers>;

/** Labels, order, spread, per-model switches and usage. `supported` is false on an older host. */
export function useConnectionExtras() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const client = connectionsClient(webFetchJson);
  const query = useQuery({ queryKey: connectionsQueryKey, queryFn: ({ signal }) => client.list(signal), retry: retryUnlessUnsupported });
  const supported = Boolean(query.data) && !query.isError;
  const store = (state: ConnectionsState) => { queryClient.setQueryData(connectionsQueryKey, state); };
  const providersChanged = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.consoleProviders() }); void queryClient.invalidateQueries({ queryKey: queryKeys.consoleModels() }); };
  return {
    query, supported, state: supported ? query.data! : null,
    rename: useMutation({ mutationFn: ({ id, label }: { id: string; label: string | null }) => client.rename(id, label), onSuccess: store }),
    reorder: useMutation({ mutationFn: ({ providerId, accountIds }: { providerId: string; accountIds: string[] }) => client.reorder(providerId, accountIds), onSuccess: store, onSettled: () => { void query.refetch(); } }),
    spread: useMutation({ mutationFn: ({ providerId, enabled }: { providerId: string; enabled: boolean }) => client.spread(providerId, enabled), onSuccess: store }),
    models: useMutation({ mutationFn: ({ id, disabled }: { id: string; disabled: string[] }) => client.setDisabledModels(id, disabled), onSuccess: async () => { await query.refetch(); providersChanged(); } }),
  };
}
export type ConnectionExtras = ReturnType<typeof useConnectionExtras>;

export const CONNECTION_USAGE_STALE_MS = 60_000;
/** Lazy per-connection usage: fetched only while `enabled` (row expanded or visible), cached for a minute. */
export function useConnectionUsage(id: string, enabled: boolean) {
  const { webFetchJson, client: backend } = useBackendApi();
  const client = connectionsClient(webFetchJson);
  return useQuery({ queryKey: queryKeys.consoleConnectionUsage(backend.backendId, id), queryFn: ({ signal }) => client.usage(id, signal), enabled, staleTime: CONNECTION_USAGE_STALE_MS, retry: false });
}
