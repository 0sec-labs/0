import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import type { FindingRecord } from "@/types";
import { findingsForChat } from "./finding-context";

export function ChatFindings({ sessionId, savedId, onAdd, busy }: { sessionId: string; savedId?: string; onAdd: (finding: FindingRecord) => void; busy: boolean }) {
  const { client, getDashboard } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["chat-findings", client.backendId], queryFn: getDashboard, refetchInterval: 3000 });
  const findings = findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId);
  return <section aria-label="Findings from this chat" className="space-y-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Findings</h3>{findings.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{findings.length}</span>}</div>
    {dashboard.error ? <div className="text-xs text-muted-foreground">Couldn't load findings.<Button variant="ghost" size="sm" onClick={() => void dashboard.refetch()}>Retry</Button></div> : dashboard.isPending ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : findings.length ? <ul className="space-y-1">{findings.map(({ fingerprint, latest }) => <li key={fingerprint} className="group flex items-start gap-1 rounded-xl transition-colors hover:bg-muted/40">
      <Link className="min-w-0 flex-1 rounded-xl px-2 py-2 focus-visible:outline-2 focus-visible:outline-ring" to={`/findings/${encodeURIComponent(fingerprint)}`}><span className="block text-xs leading-5">{latest.title}</span><span className="mt-0.5 block text-xs capitalize text-muted-foreground">{latest.severity} · {latest.status.replaceAll("_", " ")}</span></Link>
      <Button variant="ghost" size="icon-sm" className="mt-1 shrink-0" disabled={busy} aria-label={`Add ${latest.title} to chat`} title="Add to chat" onClick={() => onAdd(latest)}><MessageSquarePlus className="size-3.5" /></Button>
    </li>)}</ul> : <p className="text-xs leading-5 text-muted-foreground">No findings in this chat yet.</p>}
  </section>;
}
