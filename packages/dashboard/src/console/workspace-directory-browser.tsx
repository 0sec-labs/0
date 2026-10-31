import { useEffect, useState } from "react";
import { ArrowUp, Folder, Home } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@0/ui/components/skeleton";

interface DirectoryListing {
  path: string;
  parentPath: string | null;
  homePath: string;
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
}

export function WorkspaceDirectoryBrowser({ request, disabled, onNavigate, onLoaded }: {
  request: { path: string; revision: number };
  disabled: boolean;
  onNavigate: (path: string) => void;
  onLoaded: (path: string) => void;
}) {
  const { client, webFetchJson } = useBackendApi();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setListing(null);
    void webFetchJson<DirectoryListing>("/api/console/project/directories", {
      method: "POST", body: JSON.stringify({ path: request.path }), signal: controller.signal,
    }).then(value => {
      if (controller.signal.aborted || client.signal.aborted) return;
      if (typeof value.path !== "string" || !Array.isArray(value.entries)) throw new Error("This host returned an invalid folder listing.");
      setListing({ ...value, entries: value.entries.slice(0, 200) }); onLoaded(value.path);
    }).catch(cause => {
      if (!controller.signal.aborted && !client.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not browse folders on this host.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, webFetchJson, request.path, request.revision, onLoaded]);

  return <div className="space-y-2">
    <div className="flex items-center gap-1">
      <Button type="button" size="sm" variant="ghost" disabled={disabled || loading || !listing?.parentPath} onClick={() => listing?.parentPath && onNavigate(listing.parentPath)}><ArrowUp className="size-3.5" />Up</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || loading || !listing || listing.path === listing.homePath} onClick={() => listing && onNavigate(listing.homePath)}><Home className="size-3.5" />Home</Button>
      <span className="ml-auto text-xs text-muted-foreground">Folders on this host</span>
    </div>
    {loading ? <div role="status" aria-label="Loading folders" className="space-y-2 py-2">{[0, 1, 2].map(row => <Skeleton key={row} className="h-7 w-full" />)}</div>
      : error ? <div className="space-y-2 text-xs"><p role="alert">{error}</p><p className="text-muted-foreground">You can still enter a folder path above.</p><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onNavigate(request.path)}>Retry</Button></div>
        : <><ul aria-label="Folders" className="max-h-52 overflow-y-auto">{listing?.entries.map(entry => <li key={`${entry.name}:${entry.path}`}><Button type="button" variant="ghost" size="sm" className="w-full justify-start" disabled={disabled} onClick={() => onNavigate(entry.path)}><Folder className="size-4 shrink-0" /><span className="truncate">{entry.name}</span></Button></li>)}</ul>{!listing?.entries.length && <p className="py-2 text-xs text-muted-foreground">No folders available here.</p>}{listing?.truncated && <p className="text-xs text-muted-foreground">Listing limited. Enter a more specific path above.</p>}</>}
  </div>;
}
