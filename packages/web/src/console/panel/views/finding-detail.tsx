import { useMemo } from "react";
import { Link } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { CapyArrowUpRightIcon as ExternalLink, CapyPullRequestIcon as GitPullRequest } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { backendRouteHref } from "../../chat-host";
import { panelViewEntity, type PanelViewComponent } from "../types";
import { buildEvidence } from "./evidence-model";
import { EvidenceCard } from "./evidence";
import { useFindingActions } from "./finding-actions";
import { SeverityDot } from "./findings";
import { fixPrByFindingId, normalizeSeverity, prLabel, SEVERITY_LABELS, statusLabel } from "./findings-model";
import { useChatFindings } from "./use-chat-findings";

/** `finding:<fingerprint>` tab: a compact version of the finding page, from the dashboard record only. */
export const FindingDetailView: PanelViewComponent = ({ viewId, snapshot, sessionId, backendId, busy }) => {
  const fingerprint = panelViewEntity(viewId);
  const { findings, loading } = useChatFindings(sessionId, snapshot?.session.savedId);
  const { onAddFinding, fixes } = useFindingActions();
  const group = findings.find(item => item.fingerprint === fingerprint);
  const pr = useMemo(() => group ? fixPrByFindingId(fixes).get(group.latest.id) : undefined, [fixes, group]);
  if (!group) return <p role="status" className="px-4 py-10 text-center text-xs text-muted-foreground">{loading ? "Loading…" : "This finding is no longer linked to this chat."}</p>;
  const { latest, workflow } = group;
  const severity = normalizeSeverity(latest.severity);
  const evidence = buildEvidence([group])[0];
  const meta: [string, string][] = [
    ["Status", statusLabel(workflow?.status ?? latest.status)],
    ...(workflow?.consensus ? [["Consensus", statusLabel(workflow.consensus)] as [string, string]] : []),
    ...(latest.cvssScore != null ? [["CVSS", `${latest.cvssScore.toFixed(1)}${latest.cvssVector ? ` ${latest.cvssVector}` : ""}`] as [string, string]] : []),
    ...(latest.confidence != null ? [["Confidence", `${Math.round(latest.confidence <= 1 ? latest.confidence * 100 : latest.confidence)}%`] as [string, string]] : []),
    ["Category", latest.category],
  ];
  return <article aria-label={latest.title} className="h-full space-y-3 overflow-y-auto scroll-fade-y p-3">
    <header className="space-y-1">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground"><SeverityDot severity={severity} />{SEVERITY_LABELS[severity]}</div>
      <h2 className="text-sm font-medium leading-5">{latest.title}</h2>
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <Button variant="ghost" size="sm" render={<Link to={backendRouteHref(backendId, `/findings/${encodeURIComponent(group.fingerprint)}`)} />}><ExternalLink className="size-3.5" />Open page</Button>
        {onAddFinding && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAddFinding(latest)}><MessageSquarePlus className="size-3.5" />Add to chat</Button>}
        {pr && <Button variant="ghost" size="sm" render={<a href={pr} target="_blank" rel="noreferrer" />}><GitPullRequest className="size-3.5" />{prLabel(pr)}</Button>}
      </div>
    </header>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border-[0.5px] border-border-1 bg-card p-3 text-xs">
      {meta.map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground-2">{key}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
    {latest.description && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{latest.description}</p>}
    {evidence && <EvidenceCard item={evidence} />}
  </article>;
};
