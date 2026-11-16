import { queryKeys } from "@/queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { connectionsClient, isUnsupported, type ConnectionsState } from "./connections-contract";

export const connectionsQueryKey = queryKeys.consoleConnections();
const retryUnlessUnsupported = (count: number, error: unknown) => !isUnsupported(error) && count < 2;

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
