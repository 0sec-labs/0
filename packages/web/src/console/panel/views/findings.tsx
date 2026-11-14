import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { CapyArrowUpRightIcon as ExternalLink, CapyPullRequestIcon as GitPullRequest } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { backendRouteHref } from "../../chat-host";
import { findingViewId, type PanelViewComponent } from "../types";
import { useFindingActions } from "./finding-actions";
import {
  DEFAULT_FINDING_FILTERS,
  fixPrByFindingId,
  groupBySeverity,
  prLabel,
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  severityCounts,
  statusLabel,
  type FindingFilters,
  type FindingStatusFilter,
  type SeverityLevel,
} from "./findings-model";
import { useChatFindings } from "./use-chat-findings";

export const SEVERITY_DOT: Record<SeverityLevel, string> = {
  critical: "bg-destructive",
  high: "bg-destructive/70",
  medium: "bg-warning-foreground",
  low: "bg-muted-foreground-2",
  info: "bg-border-2",
};
export function SeverityDot({ severity, className }: { severity: SeverityLevel; className?: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", SEVERITY_DOT[severity], className)} />;
}

const STATUS_FILTERS: readonly { value: FindingStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "verified", label: "Verified" },
  { value: "fixed", label: "Fixed" },
];

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors outline-none focus-visible:outline-ring-inset",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export const FindingsView: PanelViewComponent = ({ snapshot, sessionId, backendId, busy, openView }) => {
  const { findings, loading, error, runsError, retry } = useChatFindings(sessionId, snapshot?.session.savedId);
  const { onAddFinding, fixes } = useFindingActions();
  const [filters, setFilters] = useState<FindingFilters>(DEFAULT_FINDING_FILTERS);
  const prs = useMemo(() => fixPrByFindingId(fixes), [fixes]);
  const groups = useMemo(() => groupBySeverity(findings, filters), [findings, filters]);
  const counts = useMemo(() => severityCounts(findings), [findings]);
  const working = snapshot?.session.status === "working";
  const visible = groups.reduce((sum, group) => sum + group.findings.length, 0);

  return (
    <section aria-label="Findings from this chat" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b-[0.5px] border-border-1 px-2 py-1.5">
        <div role="group" aria-label="Status filter" className="flex items-center gap-0.5 overflow-x-auto">
          {STATUS_FILTERS.map((option) => (
            <Pill
              key={option.value}
              active={filters.status === option.value}
              onClick={() => setFilters((current) => ({ ...current, status: option.value }))}
            >
              {option.label}
            </Pill>
          ))}
        </div>
        <div role="group" aria-label="Severity filter" className="flex items-center gap-0.5 overflow-x-auto">
          <Pill
            active={filters.severity === "all"}
            onClick={() => setFilters((current) => ({ ...current, severity: "all" }))}
          >
            Any severity
          </Pill>
          {SEVERITY_ORDER.filter((level) => counts[level] > 0).map((level) => (
            <Pill
              key={level}
              active={filters.severity === level}
              onClick={() =>
                setFilters((current) => ({ ...current, severity: current.severity === level ? "all" : level }))
              }
            >
              <SeverityDot severity={level} />
              {SEVERITY_LABELS[level]}
              <span className="tabular-nums text-muted-foreground-2">{counts[level]}</span>
            </Pill>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y p-1">
        {runsError && !error && (
          <p role="status" className="px-2 py-1 text-2xs text-muted-foreground-2">
            Couldn't load linked runs. Findings from automations may be missing.
          </p>
        )}
        {error ? (
          <div role="status" className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            Couldn't load findings.
            <Button variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : loading && !findings.length ? (
          <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
            Loading…
          </p>
        ) : !findings.length ? (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center text-xs text-muted-foreground">
            <p>No findings in this chat yet.</p>
            {working && <p className="text-2xs text-muted-foreground-2">Agent is investigating…</p>}
          </div>
        ) : !visible ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <p>No findings match these filters</p>
            <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FINDING_FILTERS)}>
              Clear filters
            </Button>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.severity} role="group" aria-label={`${group.label} findings`} className="mb-1">
              <div className="flex h-7 items-center gap-2 rounded-lg bg-card px-2 text-xs font-medium">
                <SeverityDot severity={group.severity} />
                {group.label}
                <span className="tabular-nums text-muted-foreground-2">{group.findings.length}</span>
              </div>
              <ul>
                {group.findings.map(({ fingerprint, latest, workflow }) => {
                  const pr = prs.get(latest.id);
                  return (
                    <li
                      key={fingerprint}
                      className="group/row relative flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-secondary/50"
                    >
                      <button
                        type="button"
                        onClick={() => openView(findingViewId(fingerprint), { title: latest.title })}
                        title={latest.title}
                        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:outline-ring-inset"
                      >
                        <SeverityDot severity={group.severity} />
                        <span className="min-w-0 flex-1 truncate text-sm">{latest.title}</span>
                        <span className="shrink-0 rounded-full bg-secondary px-1.5 text-2xs text-muted-foreground">
                          {statusLabel(workflow?.status ?? latest.status)}
                        </span>
                      </button>
                      {pr && (
                        <a
                          href={pr}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Pull request ${prLabel(pr)} for ${latest.title}`}
                          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-2xs text-muted-foreground hover:text-foreground"
                        >
                          <GitPullRequest className="size-3" />
                          {prLabel(pr)}
                        </a>
                      )}
                      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Open ${latest.title}`}
                          title="Open finding page"
                          render={<Link to={backendRouteHref(backendId, `/findings/${encodeURIComponent(fingerprint)}`)} />}
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>
                        {onAddFinding && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            aria-label={`Add ${latest.title} to chat`}
                            title="Add to chat"
                            onClick={() => onAddFinding(latest)}
                          >
                            <MessageSquarePlus className="size-3.5" />
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
