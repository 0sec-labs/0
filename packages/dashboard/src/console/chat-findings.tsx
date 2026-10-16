import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FindingRecord } from "@/types";
import { existingFindingsForChat, findingsForChat } from "./finding-context";

export function ChatFindings({ sessionId, savedId, onAdd, busy }: { sessionId: string; savedId?: string; onAdd: (finding: FindingRecord) => void; busy: boolean }) {
  const { client, getDashboard } = useBackendApi();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [addedTitle, setAddedTitle] = useState<string | null>(null);
  const dashboard = useQuery({ queryKey: ["chat-findings", client.backendId], queryFn: getDashboard, refetchInterval: 3000 });
  const findings = findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId);
  const existing = existingFindingsForChat(dashboard.data?.groups ?? [], sessionId, savedId, search);
  return <section aria-label="Findings from this chat" className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Findings</h3>{findings.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{findings.length}</span>}</div>
    {dashboard.error ? <div className="text-xs text-muted-foreground">Couldn't load findings.<Button variant="ghost" size="sm" onClick={() => void dashboard.refetch()}>Retry</Button></div> : dashboard.isPending ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : findings.length ? <ul className="space-y-1">{findings.map(({ fingerprint, latest }) => <li key={fingerprint} className="group flex items-start gap-1 rounded-xl transition-colors hover:bg-muted/40">
      <Link className="min-w-0 flex-1 rounded-xl px-2 py-2 focus-visible:outline-2 focus-visible:outline-ring" to={`/findings/${encodeURIComponent(fingerprint)}`}><span className="block text-xs leading-5">{latest.title}</span><span className="mt-0.5 block text-xs capitalize text-muted-foreground">{latest.severity} · {latest.status.replaceAll("_", " ")}</span></Link>
      <Button variant="ghost" size="icon-sm" className="mt-1 shrink-0" disabled={busy} aria-label={`Add ${latest.title} to chat`} title="Add to chat" onClick={() => onAdd(latest)}><MessageSquarePlus className="size-3.5" /></Button>
    </li>)}</ul> : <p className="text-xs leading-5 text-muted-foreground">No findings in this chat yet.</p>}
    <Button variant="outline" size="sm" className="w-full" aria-expanded={pickerOpen} onClick={() => setPickerOpen(!pickerOpen)}><MessageSquarePlus className="size-3.5" />{pickerOpen ? "Close finding picker" : "Add an existing finding"}</Button>
    {pickerOpen && <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">Bring a finding from another chat or scan into your message.</p>
      <Input aria-label="Search existing findings" placeholder="Search title, severity or source…" value={search} onChange={event => setSearch(event.target.value)} />
      {dashboard.error ? <p className="text-xs text-muted-foreground">Existing findings are unavailable. Retry above.</p> : dashboard.isPending ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : existing.length ? <>
        <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label="Existing findings">{existing.slice(0, 20).map(({ fingerprint, latest }) => <li key={fingerprint} className="flex items-start gap-1 rounded-xl hover:bg-muted/40">
          <Link className="min-w-0 flex-1 rounded-xl px-2 py-2 focus-visible:outline-2 focus-visible:outline-ring" to={`/findings/${encodeURIComponent(fingerprint)}`}><span className="block text-xs leading-5">{latest.title}</span><span className="mt-0.5 block text-xs capitalize text-muted-foreground">{latest.severity} · {latest.status.replaceAll("_", " ")}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground" title={`Source chat / scan: ${latest.scanId}`}>Source: {latest.scanId}</span></Link>
          <Button variant="ghost" size="icon-sm" className="mt-1 shrink-0" disabled={busy} aria-label={`Add ${latest.title} from ${latest.scanId} to message`} title="Add to message" onClick={() => { onAdd(latest); setAddedTitle(latest.title); }}><MessageSquarePlus className="size-3.5" /></Button>
        </li>)}</ul>
        {existing.length > 20 && <p className="text-xs text-muted-foreground">Showing 20 of {existing.length}. Refine your search to find more.</p>}
      </> : <p className="text-xs text-muted-foreground">{search.trim() ? "No matching findings." : "No findings from other chats or scans yet."}</p>}
      {addedTitle && <p role="status" className="text-xs text-muted-foreground">Added “{addedTitle}” to your message.</p>}
    </div>}
  </section>;
}
