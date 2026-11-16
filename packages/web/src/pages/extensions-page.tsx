import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageContent, PageHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/ui/components/confirm-dialog";
import { CapyPlusIcon } from "@/ui/icons/capy";
import { AddExtensionDialog } from "@/components/extensions/add-extension-dialog";
import { AddMcpDialog } from "@/components/extensions/add-mcp-dialog";
import { ConnectionsSection } from "@/components/extensions/connections-section";
import { ExtensionRow } from "@/components/extensions/extension-row";
import { ReviewSheet } from "@/components/extensions/review-sheet";
import { useExtensions } from "@/components/extensions/use-extensions";
import { useReviewFlow } from "@/components/extensions/use-review-flow";
import { errorText } from "@/lib/api-error";
import { importNote, toggleIntent, type ExtensionRowDto } from "@/lib/extensions-model";

/** One-line status that stays hidden for the first 250 ms so a quick load never flashes. */
function useAfter(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => { if (!active) { setLate(false); return; } const timer = setTimeout(() => setLate(true), ms); return () => clearTimeout(timer); }, [active, ms]);
  return late;
}

type Confirm = { kind: "remove" | "disable-builtin"; row: ExtensionRowDto } | null;

export function ExtensionsPage() {
  const api = useExtensions();
  const flow = useReviewFlow(api);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [actionError, setActionError] = useState("");
  const showLoading = useAfter(api.overview.isPending, 250);
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

  return <PageContent aria-label="Extensions">
    <PageHeader title="Extensions" summary="Add-ons that give 0 skills, commands and connections. Each is pinned to a commit and never updates on its own."
      actions={<div className="flex gap-2"><Button size="sm" variant="outline" disabled={!api.canChange || busy} onClick={flow.openAddMcp}>Add MCP server</Button><Button size="sm" variant="inverse" disabled={!api.canChange || busy} onClick={flow.openAdd}><CapyPlusIcon className="size-4" />Add extension</Button></div>} />
    {!api.canChange && <p className="text-sm text-muted-foreground-1">Only owners can add or change extensions.</p>}
    <ConnectionsSection canChange={api.canChange} />
    {note && <p role="status" className="text-sm text-muted-foreground-1">{note}</p>}
    {flow.notice && <p role="status" className="text-sm text-muted-foreground-1">{flow.notice}</p>}
    {(actionError || (flow.error && flow.step === "closed")) && <p role="alert" className="text-sm text-destructive">{actionError || flow.error}</p>}
    {api.overview.error ? <p role="alert" className="text-sm text-destructive">{errorText(api.overview.error, "Could not load extensions.")} <Button variant="ghost" size="sm" onClick={() => void api.overview.refetch()}>Try again</Button></p>
      : data?.error ? <p role="alert" className="text-sm text-destructive">{data.error}</p>
      : api.overview.isPending ? (showLoading ? <p role="status" className="text-sm text-muted-foreground-1">Loading extensions…</p> : null)
      : data && data.rows.length === 0 ? <p className="text-sm text-muted-foreground-1">No extensions yet.</p>
      : data && <ul aria-label="Installed extensions" className="-mx-4 flex flex-col divide-y-[0.5px] divide-border-1 overflow-clip rounded-md border-[0.5px] border-border-2">
        {data.rows.map(row => <ExtensionRow key={row.name} row={row} disabled={!api.canChange || busy} onToggle={toggle} onUpdate={r => void flow.startUpdate(r)} onRemove={r => setConfirm({ kind: "remove", row: r })} />)}
      </ul>}
    <AddExtensionDialog open={flow.step === "source"} pending={flow.pending} error={flow.error} problem={flow.problem} onSubmit={source => void flow.submitSource(source)} onClose={flow.close} />
    <AddMcpDialog open={flow.step === "mcp"} pending={flow.pending} error={flow.error} onSubmit={input => void flow.submitInput(input)} onClose={flow.close} />
    <ReviewSheet open={flow.step === "review"} view={flow.view} pending={flow.pending} error={flow.error} onConfirm={() => void flow.confirm()} onClose={flow.close} />
    <ConfirmDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }} pending={busy} destructive={confirm?.kind === "remove"} confirmLabel={confirm?.kind === "remove" ? "Remove" : "Turn off"} onConfirm={confirmed}
      title={confirm?.kind === "remove" ? `Remove ${confirm.row.name}?` : `Turn off ${confirm?.row.name ?? ""}?`}
      description={confirm?.kind === "remove" ? "Its files are deleted. You can add it again later." : "Commands then run without its checks."} />
  </PageContent>;
}
