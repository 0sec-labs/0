import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { MessageSquarePlus, ShieldCheck } from "lucide-react";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import type { FindingRecord } from "@/types";

export function FindingSidebar({ onAdd, busy, query = "" }: { onAdd: (finding: FindingRecord) => void; busy: boolean; query?: string }) {
  const { getDashboard } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 3000 });
  const findings = [...(dashboard.data?.groups ?? [])].filter(group => group.latest.triageStatus !== "suppressed");
  const visible = findings.filter(group => `${group.latest.title} ${group.latest.severity}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => b.latest.timestamp - a.latest.timestamp).slice(0, 5);
  return <section aria-label="Workspace findings" className="shrink-0 border-t border-border/50 px-2 py-3">
    <div className="mb-1 flex items-center justify-between px-3"><Link to="/findings" className="flex items-center gap-2 rounded-lg py-1 text-xs font-medium text-muted-foreground hover:text-foreground"><ShieldCheck className="size-3.5" />Findings<span aria-label={`${findings.length} findings`} className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{findings.length}</span></Link><Link to="/findings" className="rounded-lg px-1 py-1 text-xs text-muted-foreground hover:text-foreground">View all</Link></div>
    {dashboard.error ? <div className="px-3 py-2 text-xs text-muted-foreground">Couldn't load findings.<Button variant="ghost" size="sm" onClick={() => void dashboard.refetch()}>Retry</Button></div> : dashboard.isPending ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading findings…</p> : visible.length ? <ul>{visible.map(({ fingerprint, latest }) => <li key={fingerprint} className="group flex items-center rounded-xl hover:bg-muted/50">
      <Link to={`/findings/${encodeURIComponent(fingerprint)}`} className="min-w-0 flex-1 rounded-xl px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring"><span className="block truncate text-xs">{latest.title}</span><span className="mt-0.5 block text-[10px] capitalize text-muted-foreground">{latest.severity} · {latest.status}</span></Link>
      <Button variant="ghost" size="icon-sm" className="mr-1 shrink-0" disabled={busy} aria-label={`Add ${latest.title} to chat`} title="Add to current chat" onClick={() => onAdd(latest)}><MessageSquarePlus className="size-3.5" /></Button>
    </li>)}</ul> : <p className="px-3 py-2 text-xs text-muted-foreground">{query ? "No matching findings." : "Findings appear here as they're saved."}</p>}
  </section>;
}
