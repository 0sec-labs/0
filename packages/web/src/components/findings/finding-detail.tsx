import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getFindingPriority } from "@0/engine/dist/shared/finding-priority.js";
import { ChevronLeft, ShieldCheck, ShieldOff, ShieldQuestion, Wrench } from "lucide-react";
import { CapyChevronDownIcon as ChevronDown, CapyChevronRightIcon as ChevronRight, CapyCopyIcon as Copy, CapyArrowUpRightIcon as ExternalLink, CapyPullRequestIcon as GitPullRequest, CapyChatIcon as MessageSquare, CapyUserIcon as User, CapyCloseIcon as X } from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import { AssessmentAccessMilestones } from "@/components/access-milestone";
import { FindingImpactEditor } from "@/components/finding-impact-editor";
import { ReportExportControl } from "@/components/report-export-control";
import { EmptyState, ErrorState } from "@/components/state-panel";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { CopyButton, EvidenceArtifactRow } from "@/console/panel/views/evidence";
import { buildEvidence } from "@/console/panel/views/evidence-model";
import { prLabel } from "@/console/panel/views/findings-model";
import { formatTime } from "@/lib/format";
import { formatRelativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { v } from "@/lib/vocabulary";
import { Skeleton } from "@/ui/components/skeleton";
import type { FindingFamilyResponse, FindingGroup } from "@/types";
import { SeverityIcon, StatusIcon } from "./finding-icons";
import {
  SETTABLE_STATUSES, REVIEW_LOCK_NOTE, statusLockedByReview, SEVERITY_LABELS, STATUS_LABEL, buildActivity, findingCode, findingStatus, normalizeSeverity, type FindingStatus,
} from "./findings-model";
import type { useFindingMutations } from "./use-finding-mutations";

export type FindingDetailProps = {
  fingerprint: string;
  /** Dashboard summary: lets the panel paint before the family request resolves. */
  group: FindingGroup | null;
  variant: "panel" | "page";
  fixPrUrl?: string;
  missionName?: string;
  mutations: ReturnType<typeof useFindingMutations>;
  onClose?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
};

const iconButton = "size-7 text-muted-foreground-1";

export function FindingDetail(props: FindingDetailProps) {
  const { fingerprint, group, variant, mutations } = props;
  const { client, getFindingFamily } = useBackendApi();
  const familyQuery = useQuery({
    queryKey: ["finding-family", client.backendId, fingerprint],
    queryFn: () => getFindingFamily(fingerprint),
  });
  const family = familyQuery.data ?? null;
  const latest = family?.latest ?? group?.latest ?? null;
  const workflow = family?.workflow ?? group?.workflow ?? null;
  const saving = mutations.triage.isPending || mutations.workflow.isPending;
  const mutationError = mutations.triage.error ?? mutations.workflow.error;
  const shareUrl = `${typeof window === "undefined" ? "" : window.location.origin}/findings?finding=${encodeURIComponent(fingerprint)}`;

  if (!latest || !workflow) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PanelHeader {...props} title="Finding" status={null} shareUrl={shareUrl} />
        <div className="p-4">
          {familyQuery.isLoading ? <DetailSkeleton /> : familyQuery.error ? <ErrorState error={familyQuery.error} /> : <EmptyState title="Finding not found" body="It may have been removed." />}
        </div>
      </div>
    );
  }

  const status = group ? findingStatus({ ...group, latest, workflow }) : workflow.status;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PanelHeader {...props} title={latest.title} status={status} shareUrl={shareUrl} exportId={latest.id} />
      <div className={cn("no-scrollbar scroll-fade-y min-h-0 flex-1 overflow-y-auto")}>
        <div className={cn("mx-auto flex w-full flex-col gap-8 px-4 pt-3 pb-16", variant === "page" ? "max-w-3xl" : "max-w-3xl")}>
          <section aria-label="Summary" className="flex flex-col gap-1.5">
            <h2 className="text-[22px] leading-7 font-medium text-balance text-foreground">{latest.title}</h2>
            <p className="text-xs text-muted-foreground-1"><span className="tabular-nums">{findingCode(fingerprint)}</span> · {formatRelativeAge(latest.timestamp) || "now"} ago</p>
          </section>

          <Properties {...props} group={group} family={family} latest={latest} workflow={workflow} status={status} />

          {blockedNotice(family, workflow.phase)}

          <section aria-label="Description" className="flex flex-col gap-2">
            <SectionLabel>Description</SectionLabel>
            <p className="text-[13px] leading-6 whitespace-pre-wrap text-muted-foreground-1">{latest.description || "No description recorded."}</p>
          </section>

          <AssessmentAccessMilestones scanId={latest.scanId} />
          <EvidenceSection group={group} latest={latest} workflow={workflow} fingerprint={fingerprint} />

          <section aria-label="Review" className="flex flex-col gap-3">
            <SectionLabel>Review</SectionLabel>
            <ReviewControls key={fingerprint} fingerprint={fingerprint} initialNote={latest.triageNote ?? ""} triageStatus={latest.triageStatus} saving={saving} mutations={mutations} />
            <FindingImpactEditor key={latest.id} finding={latest} />
            {mutationError ? <ErrorState error={mutationError} /> : null}
          </section>

          {family ? <Handoff family={family} /> : null}

          <ActivitySection family={family} loading={familyQuery.isLoading} />

          {family ? <SupportingDetails family={family} /> : null}
        </div>
      </div>
    </div>
  );
}

function blockedNotice(family: FindingFamilyResponse | null, phase: string) {
  const blocked = family?.workItems.find(item => item.status === "blocked");
  if (!blocked && phase !== "blocked") return null;
  return (
    <div role="status" className="rounded-lg border-[0.5px] border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px]">
      <span className="font-medium text-foreground">Blocked: </span>
      <span className="text-muted-foreground-1">{blocked?.summary || family?.workflow.reviewReason || "Needs your input."}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground-1">{children}</h3>;
}

function PanelHeader({ title, status, variant, fingerprint, onClose, onPrev, onNext, shareUrl, exportId }: FindingDetailProps & { title: string; status: FindingStatus | null; shareUrl: string; exportId?: string }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b-[0.5px] border-border-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
        {status ? <StatusIcon status={status} /> : null}
        <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground-1">{findingCode(fingerprint)}</span>
        <span className="min-w-0 truncate text-[13px] font-medium" title={title}>{title}</span>
      </div>
      {onPrev || onNext ? (
        <>
          <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Previous finding" disabled={!onPrev} onClick={onPrev}><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Next finding" disabled={!onNext} onClick={onNext}><ChevronRight /></Button>
        </>
      ) : null}
      <CopyButton text={shareUrl} label="link" />
      {variant === "panel" ? (
        <Button variant="ghost" size="icon-sm" className={iconButton} asChild><Link to={`/findings/${encodeURIComponent(fingerprint)}`} aria-label="Open finding page"><ExternalLink /></Link></Button>
      ) : exportId ? (
        <ReportExportControl label="Export finding" path={`/api/findings/export?ids=${encodeURIComponent(exportId)}`} />
      ) : null}
      {onClose ? <Button variant="ghost" size="icon-sm" className={iconButton} aria-label="Close finding panel" onClick={onClose}><X /></Button> : null}
    </header>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[96px_minmax(0,1fr)] items-center gap-2 py-0.5">
      <dt className="text-xs text-muted-foreground-1">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

const valueButton = "h-7 max-w-full justify-start gap-2 px-2 text-[13px] font-normal text-foreground";

function Properties({ group, family, latest, workflow, status, fingerprint, fixPrUrl, missionName, mutations }: FindingDetailProps & {
  family: FindingFamilyResponse | null;
  latest: NonNullable<FindingGroup["latest"]>;
  workflow: FindingGroup["workflow"];
  status: FindingStatus;
}) {
  const severity = normalizeSeverity(latest.severity);
  const priority = getFindingPriority(latest);
  const firstSeen = family?.rows.length ? Math.min(...family.rows.map(row => row.timestamp)) : null;
  const confidence = typeof latest.confidence === "number" && Number.isFinite(latest.confidence) ? Math.round(latest.confidence <= 1 ? latest.confidence * 100 : latest.confidence) : null;
  const count = group?.count ?? family?.rows.length ?? 1;
  return (
    <dl aria-label="Properties" className="flex flex-col">
      <Prop label="Status">
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" className={valueButton} aria-label={`Status: ${STATUS_LABEL[status]}`} />}>
            <StatusIcon status={status} />{STATUS_LABEL[status]}<ChevronDown className="size-3 text-muted-foreground-2" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" className="w-52">
            {status === "human_review" ? <p role="note" className="px-2 py-1.5 text-xs text-muted-foreground-1">{REVIEW_LOCK_NOTE}</p> : null}
            {SETTABLE_STATUSES.map(option => (
              <DropdownMenu.Item
                key={option}
                disabled={statusLockedByReview(status, option)}
                icon={<StatusIcon status={option} />}
                selected={status === option}
                onClick={() => mutations.workflow.mutate({ fingerprint, workflowStatus: option, workflowAssignee: workflow.assignee ?? "", optimisticStatus: option })}
              >{STATUS_LABEL[option]}</DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      </Prop>
      <Prop label="Severity">
        <Tooltip content={latest.cvssVector || "Technical severity"}>
          <span tabIndex={0} className="inline-flex items-center gap-2 px-2">
            <SeverityIcon severity={severity} />{SEVERITY_LABELS[severity]}
            {typeof latest.cvssScore === "number" && Number.isFinite(latest.cvssScore) ? <span className="text-muted-foreground-1">CVSS {latest.cvssScore}</span> : null}
          </span>
        </Tooltip>
      </Prop>
      <Prop label="Business impact"><span className="px-2">{priority.label}</span></Prop>
      <Prop label="Category"><span className="min-w-0 truncate px-2">{latest.category || "Uncategorized"}</span></Prop>
      {confidence !== null ? <Prop label="Confidence"><span className="px-2 tabular-nums">{confidence}%</span></Prop> : null}
      <Prop label={v("{Mission}")}>
        <Button variant="ghost" size="sm" className={valueButton} asChild>
          <Link to={`/runs/${encodeURIComponent(latest.scanId)}`}><span className="min-w-0 truncate">{missionName ?? `Run ${latest.scanId.slice(0, 8)}`}</span></Link>
        </Button>
      </Prop>
      <Prop label="Fix PR">
        {fixPrUrl ? (
          <Button variant="ghost" size="sm" className={cn(valueButton, "text-success")} asChild><a href={fixPrUrl} target="_blank" rel="noreferrer noopener"><GitPullRequest />{prLabel(fixPrUrl)}</a></Button>
        ) : (
          <Button variant="ghost" size="sm" className={cn(valueButton, "text-muted-foreground-1")} asChild><Link to={`/fix?finding=${encodeURIComponent(latest.id)}&return=${encodeURIComponent(`/findings?finding=${fingerprint}`)}`}><Wrench />Prepare a fix</Link></Button>
        )}
      </Prop>
      <Prop label="Triage"><span className="px-2">{latest.triageStatus === "new" ? "Not reviewed" : latest.triageStatus === "accepted" ? "Accepted" : "Dismissed"}</span></Prop>
      <Prop label="Occurrences"><span className="px-2 tabular-nums">{count}{group && group.scanCount > 1 ? ` in ${group.scanCount} runs` : count === 1 ? " time" : " times"}</span></Prop>
      <Prop label="First seen"><span className="px-2 text-muted-foreground-1">{firstSeen === null ? "—" : formatTime(firstSeen)}</span></Prop>
      <Prop label="Last seen"><span className="px-2 text-muted-foreground-1">{formatTime(latest.timestamp)}</span></Prop>
      <Prop label="Assignee">
        <Tooltip content={`Assigning to a ${v("sentinel")} or teammate is not available yet.`}>
          <span className="inline-flex h-7 items-center gap-2 px-2 text-muted-foreground-1"><User className="size-3.5" />{workflow.assignee || "Unassigned"}</span>
        </Tooltip>
      </Prop>
    </dl>
  );
}

function EvidenceSection({ group, latest, workflow, fingerprint }: { group: FindingGroup | null; latest: FindingGroup["latest"]; workflow: FindingGroup["workflow"]; fingerprint: string }) {
  const artifacts = useMemo(
    () => buildEvidence([{ fingerprint, latest, count: group?.count ?? 1, scanCount: group?.scanCount ?? 1, workflow }])[0]?.artifacts ?? [],
    [fingerprint, latest, group?.count, group?.scanCount, workflow],
  );
  if (!artifacts.length) return null;
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2">
      <SectionLabel>Evidence</SectionLabel>
      <div className="rounded-lg border-[0.5px] border-border-1 bg-card">
        {artifacts.map(artifact => <EvidenceArtifactRow key={artifact.kind} artifact={artifact} defaultOpen={artifact.kind === "analysis"} />)}
      </div>
    </section>
  );
}

function ReviewControls({ fingerprint, initialNote, triageStatus, saving, mutations }: {
  fingerprint: string; initialNote: string; triageStatus: "new" | "accepted" | "suppressed"; saving: boolean; mutations: ReturnType<typeof useFindingMutations>;
}) {
  const [note, setNote] = useState(initialNote);
  useEffect(() => setNote(initialNote), [initialNote]);
  const triage = (next: "new" | "accepted" | "suppressed") => mutations.triage.mutate({ fingerprint, triageStatus: next, triageNote: note });
  return (
    <>
      <Textarea value={note} onChange={event => setNote(event.target.value)} aria-label="Review note" placeholder="Note (optional)" />
      <div className="flex flex-wrap gap-2">
        <Button variant="success" onClick={() => triage("accepted")} disabled={saving}><ShieldCheck className="size-4" />Accept</Button>
        <Button variant="warning" onClick={() => triage("suppressed")} disabled={saving}><ShieldOff className="size-4" />Dismiss</Button>
        {triageStatus !== "new" ? <Button variant="ghost" onClick={() => triage("new")} disabled={saving}><ShieldQuestion className="size-4" />Undo</Button> : null}
      </div>
    </>
  );
}

function Handoff({ family }: { family: FindingFamilyResponse }) {
  const intent = family.case?.targetType === "repository" && family.workflow.consensus === "verified" ? "draft_fix" : family.workflow.reviewGate === "human_review" ? "verify" : "investigate";
  const command = family.consoleCommand.replace("--finding-intent investigate", `--finding-intent ${intent}`);
  const title = intent === "draft_fix" ? v("Fix in {a mission}") : intent === "verify" ? v("Verify in {a mission}") : v("Investigate in {a mission}");
  return (
    <section aria-label="Hand off" className="flex flex-col gap-2">
      <Button variant="outline" className="w-full" asChild><Link to={`/chats?finding=${encodeURIComponent(family.latest.id)}&intent=${intent}`}><MessageSquare className="size-4" />{title}</Link></Button>
      <Disclosure summary="Terminal command" className="rounded-lg border-[0.5px] border-border-1 px-3 py-2 text-sm" triggerClassName="cursor-pointer text-muted-foreground-1">
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground-1">{title}</span>
            <CopyCommand text={command} />
          </div>
          <code className="block overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-xs text-foreground">{command}</code>
        </div>
      </Disclosure>
    </section>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(text);
      setNotice("Copied. Paste it in a terminal.");
    } catch { setNotice("Couldn't copy. Select the command and copy it manually."); }
  };
  return (
    <span className="flex items-center gap-2">
      {notice ? <span role="status" className="text-xs text-muted-foreground-1">{notice}</span> : null}
      <Button variant="outline" size="sm" onClick={() => void copy()}><Copy className="size-4" />Copy</Button>
    </span>
  );
}

function ActivitySection({ family, loading }: { family: FindingFamilyResponse | null; loading: boolean }) {
  const events = useMemo(() => family ? buildActivity(family) : [], [family]);
  return (
    <section aria-label="Activity" className="flex flex-col gap-2">
      <SectionLabel>Activity</SectionLabel>
      {loading ? <DetailSkeleton rows={3} /> : events.length === 0 ? <p className="text-xs text-muted-foreground-2">Nothing has happened yet.</p> : (
        <ol className="flex flex-col">
          {events.map(event => (
            <li key={event.id} className="flex min-h-7 flex-col justify-center py-1 text-xs">
              <div className="flex items-baseline gap-1.5 text-muted-foreground-1">
                <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", event.kind === "detected" ? "bg-border-3" : event.kind === "step" ? "bg-primary" : "bg-warning-foreground")} aria-hidden="true" />
                <span className="text-foreground">{event.text}</span>
                {event.at !== null ? <span className="tabular-nums text-muted-foreground-2">· {formatTime(event.at)}</span> : null}
              </div>
              {event.detail ? <p className="ml-3 line-clamp-3 text-muted-foreground-2">{event.detail}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SupportingDetails({ family }: { family: FindingFamilyResponse }) {
  const { workflow } = family;
  const metrics: [string, string, boolean?][] = [
    ["Verdict", `${workflow.consensus} · ${workflow.evidenceSignal} signal`],
    ["Votes (real / false / unsure)", `${workflow.verdictCounts.truePositive} / ${workflow.verdictCounts.falsePositive} / ${workflow.verdictCounts.unsure}`],
    ["Seen", `${family.rows.length}×`],
    ["Target type", family.case ? family.case.targetType.replaceAll("-", " ") : "Unknown"],
    ["Fingerprint", family.fingerprint, true],
  ];
  return (
    <div className="flex flex-col gap-2">
      {family.workItems.length ? (
        <Disclosure summary={<>Steps ({family.workItems.length})</>} className="rounded-lg bg-section px-3 py-2 text-sm" triggerClassName="cursor-pointer font-medium text-foreground">
          <ul className="mt-2 flex flex-col gap-2">
            {family.workItems.map(item => (
              <li key={item.id} className="text-xs">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{item.title}</span><span className="text-muted-foreground-1">{item.status.replaceAll("_", " ")}</span></div>
                {item.summary ? <p className="mt-0.5 text-muted-foreground-2">{item.summary}</p> : null}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {family.artifacts.length ? (
        <Disclosure summary={<>Files ({family.artifacts.length})</>} className="rounded-lg bg-section px-3 py-2 text-sm" triggerClassName="cursor-pointer font-medium text-foreground">
          <ul className="mt-2 flex flex-col gap-2">
            {family.artifacts.map(artifact => (
              <li key={artifact.id} className="text-xs">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{artifact.label}</span><span className="text-muted-foreground-1">{artifact.kind.replaceAll("_", " ")}</span></div>
                <p className="mt-0.5 text-muted-foreground-2">{artifact.summary}</p>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <Disclosure summary={<>Details</>} className="rounded-lg bg-section px-3 py-2 text-sm" triggerClassName="cursor-pointer font-medium text-foreground">
        <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
          {metrics.map(([label, value, mono]) => (
            <div key={label} className="min-w-0"><dt className="text-muted-foreground-2">{label}</dt><dd className={cn("truncate text-foreground", mono && "font-mono tabular-nums")} title={value}>{value}</dd></div>
          ))}
        </dl>
        {workflow.reviewReason ? <p className="mt-2 text-xs text-muted-foreground-1">{workflow.reviewReason}{workflow.persistedStatus !== workflow.phase ? ` You set it to ${workflow.persistedStatus.replaceAll("_", " ")}.` : ""}</p> : null}
      </Disclosure>
    </div>
  );
}

function DetailSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading finding" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-7" style={{ width: `${60 + ((index * 13) % 35)}%` }} />)}
    </div>
  );
}
