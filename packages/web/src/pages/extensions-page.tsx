import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-shell";
import { ExploreTabs } from "@/components/explore-tabs";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { CapyPlusIcon as Plus, CapySearchIcon as SearchIcon } from "@/ui/icons/capy";
import { AddExtensionDialog, type SourceKind } from "@/components/extensions/add-extension-dialog";
import { AddMcpDialog } from "@/components/extensions/add-mcp-dialog";
import { ConnectorDialog } from "@/components/extensions/connector-dialog";
import { ExtensionCell } from "@/components/extensions/extension-cell";
import { ExtensionSheet } from "@/components/extensions/extension-sheet";
import { GitHubConnectDialog } from "@/components/extensions/github-connect-dialog";
import { ReviewSheet } from "@/components/extensions/review-sheet";
import { useConnectors } from "@/components/extensions/use-connectors";
import { useExtensions } from "@/components/extensions/use-extensions";
import { useReviewFlow } from "@/components/extensions/use-review-flow";
import { useGitHubPublicationAccount } from "@/components/console-control/github-publication-control";
import { errorText } from "@/lib/api-error";
import { buildItems, matchesQuery, type ExtensionItem } from "@/lib/extensions-list";
import { importNote, toggleIntent, type ExtensionRowDto } from "@/lib/extensions-model";
import { usePendingGate } from "@/lib/pending-gate";

type Confirm = { kind: "remove" | "disable-builtin"; row: ExtensionRowDto } | null;

export function ExtensionsPage() {
  const api = useExtensions();
  const flow = useReviewFlow(api);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [actionError, setActionError] = useState("");
  const loading = usePendingGate(api.overview.isPending);
  const connectors = useConnectors();
  const github = useGitHubPublicationAccount();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const setQuery = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set("q", value); else next.delete("q"); return next; }, { replace: true });
  const selectedName = params.get("extension");
  const select = (name: string | null) => setParams(previous => { const next = new URLSearchParams(previous); if (name) next.set("extension", name); else next.delete("extension"); return next; });
  const [sourceKind, setSourceKind] = useState<SourceKind>("github");
  const [connecting, setConnecting] = useState<string | null>(null);
  const closeConnect = useCallback(() => setConnecting(null), []);
  const data = api.overview.data;
  const note = importNote(data?.importReport ?? null);
  const busy = flow.pending || api.enable.isPending || api.disable.isPending || api.remove.isPending;

  const run = async (action: () => Promise<unknown>) => { setActionError(""); flow.setNotice(""); try { await action(); } catch (cause) { setActionError(errorText(cause, "Could not change that.")); } };
  const toggle = (row: ExtensionRowDto) => {
    const intent = toggleIntent(row);
    if (intent === "review") void flow.startApprove(row);
    else if (intent === "enable") void run(() => api.enable.mutateAsync({ name: row.name }));
    else if (intent === "disable") void run(() => api.disable.mutateAsync({ name: row.name }));
    else if (intent === "confirm-disable") setConfirm({ kind: "disable-builtin", row });
  };
  const confirmed = () => {
    const current = confirm; if (!current) return;
    void run(async () => { if (current.kind === "remove") await api.remove.mutateAsync(current.row.name); else await api.disable.mutateAsync({ name: current.row.name, confirm: true }); setConfirm(null); });
  };

  const items = useMemo(() => buildItems(data?.rows ?? [], connectors.list.data?.connectors ?? [], github.data), [data, connectors.list.data, github.data]);
  const shown = items.filter(item => matchesQuery(item, query));
  const selected = items.find(item => item.name === selectedName) ?? null;
  const connectorRow = (name: string) => connectors.list.data?.connectors.find(c => c.extension === name) ?? null;
  const act = (item: ExtensionItem) => { if (item.status.action === "review") void flow.startApprove(item.row); else if (item.status.action === "connect") setConnecting(item.name); };
  const lock = !api.canChange || busy;
  const failed = api.overview.error ? errorText(api.overview.error, "Could not load extensions.") : data?.error ?? "";

  return <>
    <PageHeader title="Extensions"
      actions={<>
        <div className="relative w-55"><SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label="Search extensions" className="pl-8" placeholder="Search extensions" autoComplete="off" data-1p-ignore data-lpignore="true" value={query} onChange={event => setQuery(event.target.value)} /></div>
        {api.canChange && <DropdownMenu><DropdownMenu.Trigger render={<Button size="sm" variant="secondary" disabled={busy} />}><Plus className="size-4" />Add</DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onClick={() => { setSourceKind("github"); flow.openAdd(); }}>From GitHub</DropdownMenu.Item>
            <DropdownMenu.Item onClick={() => { setSourceKind("folder"); flow.openAdd(); }}>From a folder</DropdownMenu.Item>
            <DropdownMenu.Item onClick={flow.openAddMcp}>MCP server</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu>}
      </>} />
    <div className="flex flex-col gap-6">
      <ExploreTabs active="extensions" />
      {!api.canChange && <p className="text-sm text-muted-foreground-1">Only owners can add or change extensions.</p>}
      {note && <p role="status" className="text-sm text-muted-foreground-1">{note}</p>}
      {flow.notice && <p role="status" className="text-sm text-muted-foreground-1">{flow.notice}</p>}
      {(actionError || (flow.error && flow.step === "closed")) && <p role="alert" className="text-sm text-destructive">{actionError || flow.error}</p>}
      {failed ? <p role="alert" className="text-sm text-destructive">{failed} {api.overview.error && <Button variant="ghost" size="sm" onClick={() => void api.overview.refetch()}>Try again</Button>}</p>
        : loading ? <LoadingState label="Loading extensions…" rows={4} />
        : <section aria-label="Installed extensions" className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-foreground">Installed</h2>
          {shown.length ? <ul className="flex flex-col gap-4">{shown.map(item => <ExtensionCell key={item.name} item={item} disabled={lock} onOpen={() => select(item.name)} onAction={() => act(item)} />)}</ul>
            : <EmptyState variant="inline" title={query.trim() ? "No matching extensions." : "No extensions yet. Use Add to connect 0 to a service or an MCP server."} />}
        </section>}
    </div>
    <ExtensionSheet item={selected} disabled={lock} onClose={() => select(null)} onConnect={item => { select(null); setConnecting(item.name); }} onToggle={item => toggle(item.row)} onUpdate={item => { select(null); void flow.startUpdate(item.row); }} onRemove={item => { select(null); setConfirm({ kind: "remove", row: item.row }); }} />
    <GitHubConnectDialog open={connecting === "github"} onClose={closeConnect} />
    <ConnectorDialog row={connecting && connecting !== "github" ? connectorRow(connecting) : null} pending={connectors.act.isPending} error={connectors.act.error} act={connectors.act.mutateAsync} onClose={closeConnect} />
    <AddExtensionDialog open={flow.step === "source"} kind={sourceKind} pending={flow.pending} error={flow.error} problem={flow.problem} onSubmit={source => void flow.submitSource(source)} onClose={flow.close} />
    <AddMcpDialog open={flow.step === "mcp"} pending={flow.pending} error={flow.error} onSubmit={input => void flow.submitInput(input)} onClose={flow.close} />
    <ReviewSheet open={flow.step === "review"} view={flow.view} pending={flow.pending} error={flow.error} onConfirm={() => void flow.confirm()} onClose={flow.close} />
    <ConfirmDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }} pending={busy} destructive={confirm?.kind === "remove"} confirmLabel={confirm?.kind === "remove" ? "Remove" : "Turn off"} onConfirm={confirmed}
      title={confirm?.kind === "remove" ? `Remove ${confirm.row.name}?` : `Turn off ${confirm?.row.name ?? ""}?`}
      description={confirm?.kind === "remove" ? "Its files are deleted. You can add it again later." : "Commands then run without its checks."} />
  </>;
}
