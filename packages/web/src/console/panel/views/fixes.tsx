import { queryKeys } from "@/queries";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CapyArrowUpRightIcon as ExternalLink,
  CapyBranchIcon as GitBranch,
  CapyPullRequestIcon as GitPullRequest,
} from "@/ui/icons/capy";
import { useBackendApi } from "@/api";
import type { Workflow } from "@/components/console-control/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { backendRouteHref } from "../../chat-host";
import type { PanelViewComponent } from "../types";
import {
  countLabel,
  FIX_STAGE_LABEL,
  FIXES_WORKFLOWS_PATH,
  fixBucket,
  fixDiffText,
  fixesFromWorkflows,
  fixStage,
  isActiveWorkflow,
  parseDiff,
  prLabel,
  safePrUrl,
  type FixBucket,
  type FixStage,
  type PanelFix,
} from "./fixes-model";

const STAGE_VARIANT: Record<FixStage, "success" | "info" | "accent" | "neutral" | "warning"> = {
  "pr-opened": "success",
  applied: "success",
  retested: "info",
  proposed: "accent",
  prepared: "neutral",
  ineligible: "warning",
};
const TABS: readonly { value: FixBucket | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "ready", label: "Ready to merge" },
  { value: "applied", label: "Applied" },
];

const LINE_CLASS = {
  add: "bg-[var(--diff-add-wash)] text-[var(--diff-add)]",
  del: "bg-[var(--diff-del-wash)] text-[var(--diff-del)]",
  hunk: "text-muted-foreground-2",
  meta: "text-muted-foreground",
  context: "text-foreground/80",
} as const;

/** Compact unified-diff viewer: hairline card, add/delete colours, bounded height with edge fades. */
export function DiffSummary({ diff, label }: { diff: string; label?: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  if (!parsed.lines.length) return <p className="text-xs text-muted-foreground">No diff.</p>;
  return (
    <figure className="overflow-hidden rounded-lg border-[0.5px] border-[var(--card-hairline)] bg-card">
      <figcaption className="flex h-9 items-center gap-2 border-b-[0.5px] border-[var(--card-hairline)] px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={parsed.files.join(", ")}>
          {label ??
            (parsed.files.length
              ? parsed.files.length === 1
                ? parsed.files[0]
                : countLabel(parsed.files.length, "file")
              : "Diff")}
        </span>
        <span className="font-mono tabular-nums text-[var(--diff-add)]">+{parsed.added}</span>
        <span className="font-mono tabular-nums text-[var(--diff-del)]">-{parsed.removed}</span>
      </figcaption>
      <pre
        aria-label="Diff"
        tabIndex={0}
        className="scroll-fade-y max-h-72 overflow-auto py-1 font-mono text-xs leading-5 outline-none focus-visible:outline-ring-inset"
      >
        <code className="block min-w-max">
          {parsed.lines.map((line, index) => (
            <span key={index} className={cn("block whitespace-pre px-3", LINE_CLASS[line.kind])}>
              {line.text || " "}
            </span>
          ))}
        </code>
        {parsed.truncated && <span className="block px-3 pt-1 text-muted-foreground">Diff truncated.</span>}
      </pre>
    </figure>
  );
}

function FixCard({ entry, backendId }: { entry: PanelFix; backendId: string }) {
  const { fix } = entry;
  const stage = fixStage(fix);
  const diff = fixDiffText(fix);
  const prUrl = safePrUrl(fix.published?.prUrl);
  const branch = fix.published?.branch ?? fix.publication?.branch;
  const test = (fix.verification ?? fix.result)?.test;
  const rationale = fix.result?.rationale;
  const error =
    fix.application?.error ?? fix.verification?.error ?? fix.result?.error ?? (!fix.eligible ? fix.reason : undefined);
  const findingHref = fix.finding.fingerprint
    ? backendRouteHref(backendId, `/findings/${encodeURIComponent(fix.finding.fingerprint)}`)
    : undefined;
  return (
    <li className="space-y-2 rounded-lg border-[0.5px] border-[var(--card-hairline)] bg-card p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-5">
            {findingHref ? (
              <Link to={findingHref} className="rounded-sm hover:underline focus-visible:outline-ring-inset">
                {fix.finding.title}
              </Link>
            ) : (
              fix.finding.title
            )}
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="capitalize">{fix.finding.severity}</span>
            {branch && (
              <>
                <span aria-hidden>·</span>
                <GitBranch aria-hidden className="size-3 shrink-0" />
                <span className="truncate font-mono" title={branch}>
                  {branch}
                </span>
              </>
            )}
          </p>
        </div>
        <Badge variant={STAGE_VARIANT[stage]}>{entry.active ? "Working…" : FIX_STAGE_LABEL[stage]}</Badge>
      </div>
      {error && (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {rationale && <p className="line-clamp-4 text-xs leading-5 text-muted-foreground">{rationale}</p>}
      {diff && <DiffSummary diff={diff} />}
      {test && (
        <p className="font-mono text-xs text-muted-foreground">
          {test.command ? `${test.command} · ` : ""}
          {test.timedOut
            ? "timed out"
            : test.exitCode === null
              ? "no exit code"
              : test.exitCode === 0
                ? "passed"
                : `exit ${test.exitCode}`}{" "}
          · {(test.durationMs / 1000).toFixed(1)}s
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {prUrl ? (
          <Button size="sm" variant="outline" render={<a href={prUrl} target="_blank" rel="noopener noreferrer" />}>
            <GitPullRequest aria-hidden className="size-3.5" />
            Open PR {prLabel(prUrl)}
            <ExternalLink aria-hidden className="size-3" />
          </Button>
        ) : (
          <Button size="sm" variant="ghost" render={<Link to={backendRouteHref(backendId, `/fix?finding=${encodeURIComponent(fix.finding.id)}`)} />}>
            {fix.result ? "Review in Fix flow" : "Continue in Fix flow"}
          </Button>
        )}
      </div>
    </li>
  );
}

export const FixesView: PanelViewComponent = ({ sessionId, backendId }) => {
  const { webFetchJson } = useBackendApi();
  const [tab, setTab] = useState<FixBucket | "all">("all");
  const query = useQuery({
    queryKey: queryKeys.panelFixes(backendId, sessionId),
    enabled: Boolean(sessionId),
    queryFn: ({ signal }) => webFetchJson<{ workflows: Workflow[] }>(FIXES_WORKFLOWS_PATH(sessionId!), { signal }),
    refetchInterval: (q) =>
      q.state.data?.workflows.some((w) => w.kind.startsWith("fix-") && isActiveWorkflow(w.status)) ? 2000 : 10000,
  });
  const fixes = useMemo(() => fixesFromWorkflows(query.data?.workflows, sessionId), [query.data, sessionId]);
  const visible = tab === "all" ? fixes : fixes.filter((entry) => fixBucket(fixStage(entry.fix)) === tab);
  const counts = (value: FixBucket | "all") =>
    value === "all" ? fixes.length : fixes.filter((entry) => fixBucket(fixStage(entry.fix)) === value).length;
  const flowHref = backendRouteHref(backendId, "/fix");

  if (query.isPending && sessionId)
    return (
      <p role="status" className="p-4 text-xs text-muted-foreground">
        Loading fixes…
      </p>
    );
  if (query.error)
    return (
      <div role="status" className="p-4 text-xs text-muted-foreground">
        Couldn't load fixes.
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (!fixes.length)
    return (
      <div className="space-y-2 p-4 text-xs leading-5 text-muted-foreground">
        <p>No fixes yet; a fix starts from a finding in the Fix flow.</p>
        <Button size="sm" variant="outline" render={<Link to={flowHref} />}>
          Open Fix flow
        </Button>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="group" aria-label="Filter fixes" className="flex shrink-0 gap-1 px-3 pb-2 pt-3">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={tab === item.value}
            onClick={() => setTab(item.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs outline-none transition-colors focus-visible:outline-ring-inset",
              tab === item.value
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            {item.label}
            <span className="tabular-nums text-muted-foreground-2">{counts(item.value)}</span>
          </button>
        ))}
      </div>
      <ul className="scroll-fade-y min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3">
        {visible.length ? (
          visible.map((entry) => <FixCard key={entry.fix.id} entry={entry} backendId={backendId} />)
        ) : (
          <li className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here.</li>
        )}
      </ul>
    </div>
  );
};
