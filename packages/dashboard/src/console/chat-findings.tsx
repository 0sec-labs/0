import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import type { FindingRecord } from "@/types";
import { findingsForChat } from "./finding-context";

export function ChatFindings({ sessionId, savedId, onAdd, busy }: { sessionId: string; savedId?: string; onAdd: (finding: FindingRecord) => void; busy: boolean }) {
  const { getDashboard } = useBackendApi();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: getDashboard, refetchInterval: 3000 });
  const findings = findingsForChat(dashboard.data?.groups ?? [], sessionId, savedId);
  if (!findings.length) return null;
  return <details className="shrink-0 border-b border-border/50 px-4 py-2 text-xs">
    <summary className="rounded-lg py-1 font-medium">Findings from this chat · {findings.length}</summary>
    <ul className="max-h-48 space-y-1 overflow-y-auto pt-2">{findings.map(({ fingerprint, latest }) => <li key={fingerprint} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1 hover:bg-muted/50"><Link className="min-w-0 truncate rounded-lg py-1 hover:underline" to={`/findings/${encodeURIComponent(fingerprint)}`}>{latest.title}<span className="ml-2 capitalize text-muted-foreground">{latest.severity}</span></Link><Button variant="ghost" size="sm" disabled={busy} onClick={() => onAdd(latest)}>Add to chat</Button></li>)}</ul>
  </details>;
}
