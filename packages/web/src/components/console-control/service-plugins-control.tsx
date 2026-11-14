import { queryKeys } from "@/queries";
import type { ServicePluginsResponse } from "@0/engine/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeXml, GitBranch, Hash, Layers, ShieldCheck, Users, Waypoints } from "lucide-react";
import { CapyCloudIcon as Cloud, CapyDatabaseIcon as Database, CapyPlugIcon as Plug } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";

/** Service logo inside the shared 28px tile. */
export function ServiceIcon({ id, className = "size-4" }: { id: string; className?: string }) {
  const Icon = ({ github: GitBranch, slack: Hash, teams: Users, elastic: Database, semgrep: CodeXml, snyk: ShieldCheck, linear: Waypoints, jira: Layers, cloudflare: Cloud } as Record<string, typeof Plug>)[id] ?? Plug;
  return <Icon aria-hidden="true" className={className} />;
}

export function useServicePlugins() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: queryKeys.consoleServicePlugins(), queryFn: ({ signal }) => webFetchJson<ServicePluginsResponse>("/api/console/service-plugins", { signal }), refetchInterval: 15_000 });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.consoleServicePlugins() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.consoleTools() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowToolCatalog() }),
    ]);
  };
  const connect = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Record<string, string> }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}/connect`, { method: "POST", body: JSON.stringify({ fields, approved: true }) }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: refresh,
    onError: () => { void inventory.refetch(); },
  });
  const forget = useMutation({
    mutationFn: ({ id }: { id: string }) => webFetchJson(`/api/console/service-plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  return { inventory, connect, toggle, forget };
}
export type ServicePluginActions = ReturnType<typeof useServicePlugins>;
