import { Button } from "@/components/ui/button";
import { SheetPanel } from "@/ui/components/sheet-panel";
import type { PromptView } from "@/lib/extensions-model";

function Lines({ label, items, prefix }: { label: string; items: string[]; prefix?: string }) {
  if (!items.length) return null;
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground-2">{label}</dt><dd className="mt-1 font-mono text-xs break-words text-foreground">{items.map(item => <span key={item} className="block">{prefix}{item}</span>)}</dd></div>;
}

/** The install prompt: repo @ commit, what it can do, and the diff when updating. The only way to install or update; the button echoes the commit. */
export function ReviewSheet({ view, open, pending, error, onConfirm, onClose }: { view: PromptView | null; open: boolean; pending: boolean; error: string; onConfirm: () => void; onClose: () => void }) {
  return <SheetPanel open={open} onOpenChange={next => { if (!next) onClose(); }} locked={pending} title={view?.title ?? "Review"} description={view?.description || undefined}
    footer={view && <><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="inverse" aria-busy={pending || undefined} disabled={pending} onClick={onConfirm}>{pending ? `${view.confirmLabel}…` : view.confirmLabel}</Button></>}>
    {view && <>
      <section aria-label="Source" className="min-w-0"><h3 className="text-xs text-muted-foreground-2">Source</h3><p className="mt-1 font-mono text-xs break-all text-foreground">{view.repoAtCommit}</p></section>
      <section aria-label="What it can do" className="min-w-0"><h3 className="text-sm font-medium text-foreground">It can</h3><ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground-1">{view.canDo.map(line => <li key={line}>{line}</li>)}</ul></section>
      {view.warnings.length > 0 && <ul aria-label="Warnings" className="flex flex-col gap-1 text-sm text-warning">{view.warnings.map(line => <li key={line}>{line}</li>)}</ul>}
      {view.diff && <section aria-label="Changes" className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Changes since {view.diff.from}</h3>
        {!view.diff.hasChanges && <p className="text-sm text-muted-foreground-1">No file changes.</p>}
        <dl className="flex flex-col gap-3">
          <Lines label="Added" items={view.diff.added} /><Lines label="Removed" items={view.diff.removed} /><Lines label="Changed" items={view.diff.changed} />
          <Lines label="It can now" items={view.diff.capabilityAdded} prefix="+ " /><Lines label="It can no longer" items={view.diff.capabilityRemoved} prefix="- " />
        </dl>
        {view.diff.patch && <pre aria-label="Diff" className="max-h-72 overflow-auto rounded-md border-[0.5px] border-border-2 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{view.diff.patch}{view.diff.patchTruncated ? "\n… diff shortened" : ""}</pre>}
      </section>}
      <p className="text-xs text-muted-foreground-2">It never updates on its own. Any change asks again.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>}
  </SheetPanel>;
}
