import { GitHubPublicationControl } from "@/components/console-control/github-publication-control";
import { errorText } from "@/lib/api-error";
import { ConnectorAccess, ConnectorCard } from "./connector-card";
import { useConnectors } from "./use-connectors";

/**
 * One card per connector extension, built-in or installed. A service with extra sign-in steps may register its own
 * card (GitHub: CLI login, device code, fine-grained token, permission refresh); every other connector gets the generic one.
 */
export function ConnectionsSection({ canChange }: { canChange: boolean }) {
  const { list, act } = useConnectors();
  const rows = list.data?.connectors ?? [];
  if (list.error) return <p role="alert" className="text-sm text-destructive">{errorText(list.error, "Could not load connections.")}</p>;
  if (!rows.length) return null;
  return <section aria-label="Connections" className="flex flex-col gap-6">
    {rows.filter(r => r.enabled).map(row => row.extension === "github"
      ? <div key={row.extension} className="flex flex-col gap-2"><GitHubPublicationControl /><ConnectorAccess row={row} /></div>
      : <ConnectorCard key={row.extension} row={row} disabled={!canChange} pending={act.isPending && act.variables?.name === row.extension} error={act.variables?.name === row.extension ? act.error : null} act={act.mutateAsync} />)}
  </section>;
}
