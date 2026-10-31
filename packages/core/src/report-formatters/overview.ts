import type { Finding, ScanReport } from "@0/shared";
import { findingPresentation } from "./presentation.js";

export interface ReportOverviewGroup {
  title: string;
  summary: string;
  nextStep: string;
  findingIds: string[];
  focus?: boolean;
}
export interface ReportOverview {
  summary: string;
  evidenceNote?: string;
  deploymentNote?: string;
  observedAt?: string;
  observations?: Array<{ title: string; status: string; note: string; url?: string }>;
  groups: ReportOverviewGroup[];
}
export type ReportWithOverview = ScanReport & { overview?: ReportOverview };

/** Groups are editorial context. Original finding records remain the source of truth. */
export function renderOverview(report: ReportWithOverview, findings: Finding[]): string {
  const escape = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const configured = report.overview;
  const seen = new Set<string>();
  const byId = new Map(findings.map((f,i)=>[f.id,{finding:f,index:i}]));
  const groups = (configured?.groups ?? []).map(group=>({ ...group, items: group.findingIds.flatMap(id=>{
    const item = byId.get(id);
    if (!item || seen.has(id)) return [];
    seen.add(id); return [item];
  }) })).filter(group=>group.items.length);
  const remaining = findings.flatMap((finding,index)=>seen.has(finding.id)?[]:[{finding,index}]);
  if (remaining.length) groups.push({title: groups.length ? "Other findings" : "Findings to review", summary:"Review each finding’s evidence and recommended action.", nextStep:"Validate the affected paths and retest each fix.", findingIds:remaining.map(item=>item.finding.id),items:remaining});
  const counts = (["critical","high","medium","low","info"] as const).map(severity=>({severity,count:findings.filter(f=>f.severity===severity).length})).filter(item=>item.count);
  return `<section id="overview" class="overview" aria-labelledby="overview-title"><div class="eyebrow">Review summary</div><h2 id="overview-title">The overall picture<span>.</span></h2><p class="overview-lead">${escape(configured?.summary ?? (findings.length?"A summary of the findings, with the technical evidence and recommended fixes available in each detail view.":"No findings were reported for this assessment."))}</p>
  ${configured?.deploymentNote ? `<aside class="deployment-context"><span class="eyebrow">Deployment context</span><p>${escape(configured.deploymentNote)}</p></aside>` : ""}
  ${configured?.observations?.length ? `<details class="live-observations" open><summary>Live interface check <span>Read-only${configured.observedAt ? ` · ${escape(configured.observedAt)}` : ""}</span></summary><div>${configured.observations.map(item=>`<section><div><strong>${escape(item.title)}</strong><span>${escape(item.status)}</span></div><p>${escape(item.note)}${item.url ? ` <a href="${escape(item.url)}" target="_blank" rel="noreferrer">View interface ↗</a>` : ""}</p></section>`).join("")}</div></details>` : ""}
  <div class="overview-stats"><span><strong>${findings.length}</strong> ${configured?.deploymentNote ? "source findings" : "findings"}</span>${groups.length?`<span><strong>${groups.length}</strong> themes</span>`:""}${counts.map(item=>`<span class="overview-severity ${item.severity}"><strong>${item.count}</strong> ${item.severity}</span>`).join("")}</div>
  ${configured?.evidenceNote?`<p class="evidence-note">${escape(configured.evidenceNote)}</p>`:""}
  <div class="overview-section-label"><h3>Where the issues cluster</h3><span>Open a group to inspect its findings</span></div><div class="group-grid">${groups.map((group,i)=>`<section class="overview-group ${group.focus?"focus-group":""}"><div class="group-top"><span class="group-number">${String(i+1).padStart(2,"0")}</span>${group.focus?'<span class="focus-label">Priority for validation</span>':""}</div><h3>${escape(group.title)}</h3><p>${escape(group.summary)}</p><div class="group-next"><span>Next step</span>${escape(group.nextStep)}</div><details class="group-findings"><summary>${group.items.length} finding${group.items.length===1?"":"s"}<span>＋</span></summary><div>${group.items.map(({finding,index})=>`<a class="overview-finding" href="#finding-${index+1}" data-open-finding="${index}"><span>${String(index+1).padStart(2,"0")}</span><span>${escape(findingPresentation(finding).title)}</span><span aria-hidden="true">↗</span></a>`).join("")}</div></details></section>`).join("")}</div></section>`;
}
