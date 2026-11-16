import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";
import type { ConnectorRowDto, ConnectorStatusDto } from "@/lib/connector-model";

const ROUTE = "/api/console/extensions/connectors";

/** Every connector extension with its live status. Polls while a browser sign-in is waiting. */
export function useConnectors() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.extensionConnectors(),
    queryFn: ({ signal }) => webFetchJson<{ connectors: ConnectorRowDto[] }>(ROUTE, { signal }),
    refetchInterval: query => query.state.data?.connectors.some(c => c.status.state === "signing-in") ? 1000 : 30_000,
  });
  const act = useMutation({
    mutationFn: ({ name, action, token }: { name: string; action: "connect" | "sign-in" | "cancel" | "disconnect"; token?: string }) =>
      webFetchJson<{ status: ConnectorStatusDto }>(`${ROUTE}/${encodeURIComponent(name)}/${action}`, { method: "POST", body: JSON.stringify(token === undefined ? {} : { token }) }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.extensionConnectors() }); },
  });
  return { list, act };
}
