import { ControlDisclosure } from "./control-disclosure";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { validateScanPlan } from "@0/shared/dist/types.js";
import type { ScanPlan } from "@0/shared";
import { ArrowUpRight, Download } from "lucide-react";
import { listConsoleSessions, webFetchJson } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Check, ControlCard, Empty, Facts, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import { ConnectionsControl, useProviders } from "./connections-control";
import type { FixResult, ProvidersResponse, SessionSnapshot, SessionSummary, WebFix, Workflow } from "./contracts";
import { GitHubPublicationControl, useGitHubPublicationAccount } from "./github-publication-control";

const activeStatuses: Record<string, true> = { queued: true, running: true, cancelling: true };

interface WorkflowOwnerState {
  owner: string;
  providers: UseQueryResult<ProvidersResponse, Error>;
  sessions: UseQueryResult<SessionSummary[], Error>;
  select: (id: string) => void;
  create: UseMutationResult<{ session: SessionSummary }, Error, void, unknown>;
  snapshot: UseQueryResult<SessionSnapshot, Error>;
  connected: boolean;
}

function useWorkflowOwner(provided?: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const owner = provided ?? new URLSearchParams(location.search).get("session") ?? "";
  const providers = useProviders();
  const sessions = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => listConsoleSessions(signal), refetchInterval: 3000 });
  const select = (id: string) => { const params = new URLSearchParams(location.search); params.set("session", id); params.set("return", `/console/${id}`); navigate(`${location.pathname}?${params}`, { replace: true }); };
  const create = useMutation({ mutationFn: () => webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({})), onSuccess: async data => { await queryClient.invalidateQueries({ queryKey: ["console-sessions"] }); select(data.session.id); } });
  const snapshot = useQuery({ queryKey: ["console-control-session", owner], enabled: !!owner, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(owner)}`, { signal })).snapshot, refetchInterval: 3000 });
  const connected = providers.data?.providers.some(provider => provider.configured) ?? false;
  return { owner, providers, sessions, select, create, snapshot, connected };
}

function WorkflowOwner({ state }: { state: WorkflowOwnerState }) {
  return <ControlCard title="Session"><QueryState pending={state.sessions.isPending || state.providers.isPending} error={state.sessions.error ?? state.providers.error} retry={() => { void state.sessions.refetch(); void state.providers.refetch(); }} /><div className="flex flex-col items-end gap-3 sm:flex-row"><div className="w-full"><Field label="Session"><Select aria-label="Session" value={state.owner} onValueChange={state.select} options={[{ value: "", label: "Choose a session" }, ...(state.sessions.data?.filter(session => session.status !== "closed").map(session => ({ value: session.id, label: `${session.title ?? session.target ?? session.id} · ${session.status}` })) ?? [])]} /></Field></div><SubmitButton pending={state.create.isPending} disabled={!state.connected} onClick={() => state.create.mutate()}>New session</SubmitButton></div><Feedback error={state.create.error ?? state.snapshot.error} />{state.snapshot.data && <p className="text-sm text-muted-foreground">{state.snapshot.data.runtime?.providerLabel ?? "No provider"} · {state.snapshot.data.runtime?.model ?? "Default model"} · {state.snapshot.data.session.autonomyMode}</p>}{state.snapshot.data && !state.snapshot.data.scopeEnforcement.enabled && <Feedback error={state.snapshot.data.scopeEnforcement.message || "Scope checks are off."} />}{state.owner && <Link to={`/console/${encodeURIComponent(state.owner)}`} className="inline-flex items-center gap-1 text-sm underline">Open session<ArrowUpRight className="size-3" /></Link>}</ControlCard>;
}

function DataDisclosure({ title, value }: { title: string; value: unknown }) {
  return <ControlDisclosure className="rounded-md border border-border" title={<>{title}</>}><pre className="max-h-[32rem] overflow-auto border-t border-border bg-muted/20 p-4 text-xs">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></ControlDisclosure>;
}

function WorkflowView({ workflow, cancel, cancelling }: { workflow: Workflow; cancel: () => void; cancelling: boolean }) {
  const cost = workflow.outcome?.estimatedCostUsd ?? workflow.outcome?.cost_usd;
  return <article className="space-y-4 rounded-lg border border-border p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-medium">{workflow.request.target ?? workflow.kind}</h3><p className="mt-1 text-xs text-muted-foreground">{workflow.kind} · {new Date(workflow.createdAt).toLocaleString()}</p></div><Badge variant={workflow.status === "failed" ? "destructive" : "outline"}>{workflow.status}</Badge></div>
    <Facts entries={[
      ["Result", workflow.outcome?.exit_reason ?? (activeStatuses[workflow.status] ? "Running" : workflow.status)],
      ["Findings", workflow.outcome?.summary?.totalFindings === undefined ? "—" : String(workflow.outcome.summary.totalFindings)],
      ["Cost", cost === undefined ? "Unknown" : `$${cost.toFixed(4)}`],
    ]} />
    {workflow.error && <Feedback error={workflow.error} />}
    {workflow.outcome?.ok === false && <Feedback error={workflow.outcome.error ?? "The scan failed. Results may be incomplete."} />}
    <ControlDisclosure className="rounded-md border border-border" title={<>Details</>}><div className="space-y-4 border-t border-border p-4">
    <Facts entries={[
      ["Target type", workflow.request.resolved?.kind ?? (workflow.kind === "run" ? "—" : "Source fix")],
      ["Ecosystem", workflow.request.resolved?.ecosystem ?? "—"],
      ["Target", workflow.request.resolved?.target ?? workflow.request.target],
      ["Provider", workflow.runtime.providerId],
      ["Model", workflow.runtime.model],
      ["Exit code", workflow.outcome?.exitCode === undefined ? "—" : String(workflow.outcome.exitCode)],
      ["Runs done", workflow.outcome?.completedRuns === undefined ? "—" : `${workflow.outcome.completedRuns} / ${workflow.outcome.plannedRuns ?? "?"}`],
    ]} />
    {workflow.outcome?.attempts?.length ? <section className="space-y-2"><h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Runs</h4>{workflow.outcome.attempts.map((attempt, index) => <div key={`${attempt.runIndex}:${index}`} className="rounded-md border border-border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>Run {attempt.runIndex}</span><Badge variant={attempt.status === "completed" ? "secondary" : "outline"}>{attempt.status}</Badge></div><p className="mt-2 text-xs text-muted-foreground">{(attempt.durationMs / 1000).toFixed(1)}s · {attempt.costUsd === undefined ? "Cost unknown" : `$${attempt.costUsd.toFixed(4)}`}</p>{attempt.error && <p className="mt-2 text-sm text-destructive">{attempt.error}</p>}</div>)}</section> : null}
    {workflow.outcome?.usage && <Facts entries={[["Input tokens", workflow.outcome.usage.inputTokens.toLocaleString()], ["Output tokens", workflow.outcome.usage.outputTokens.toLocaleString()]]} />}
    <DataDisclosure title="Scan plan" value={workflow.request} />
    </div></ControlDisclosure>
    {workflow.report !== undefined && <>
      <DataDisclosure title="Report" value={workflow.report} />
      <Button size="sm" variant="outline" onClick={() => { const blob = new Blob([JSON.stringify(workflow.report, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `0-report-${workflow.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download className="size-4" />Download report</Button>
    </>}
    {!workflow.reportRetained && workflow.kind === "run" && !activeStatuses[workflow.status] && <p className="text-xs text-muted-foreground">{workflow.reportRetentionReason ?? "No report was saved for this run. Check the result and findings above."}</p>}
    {workflow.events.length > 0 && <ControlDisclosure className="rounded-md border border-border" title={<>Activity ({workflow.events.length} events)</>}>{workflow.eventsTruncated && <p className="px-3 text-xs text-muted-foreground">Older events were dropped. Showing from #{workflow.oldestSequence}.</p>}<ol className="max-h-[32rem] space-y-3 overflow-auto border-t border-border p-3">{workflow.events.map(event => <li key={event.sequence} className="space-y-2 rounded-md border border-border p-3"><p className="text-xs text-muted-foreground">#{event.sequence} · {event.type} · {new Date(event.timestamp).toLocaleTimeString()}</p><pre className="text-xs">{JSON.stringify(event.data, null, 2)}</pre></li>)}</ol></ControlDisclosure>}
    {activeStatuses[workflow.status] && <div className="space-y-2"><SubmitButton pending={cancelling} variant="outline" disabled={workflow.status === "cancelling"} onClick={cancel}>{workflow.status === "cancelling" ? "Stopping…" : "Stop"}</SubmitButton><p className="text-xs text-muted-foreground">Stopping doesn't undo actions already taken.</p></div>}
    <div className="flex flex-wrap gap-4 text-xs"><Link to="/runs" className="underline">Run reports</Link><Link to="/findings" className="underline">Findings</Link></div>
  </article>;
}

export function LauncherControl({ sessionId }: { sessionId?: string }) {
  const state = useWorkflowOwner(sessionId);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("");
  const [plan, setPlan] = useState<ScanPlan>({ goal: "known-vulnerabilities", depth: "default", runCount: 1, executionMode: "sequential", timeCapMs: 600000, costCapUsd: 5 });
  const [approved, setApproved] = useState(false);
  const jobs = useQuery({ queryKey: ["console-workflows", state.owner], enabled: !!state.owner, queryFn: ({ signal }) => webFetchJson<{ workflows: Workflow[] }>(`/api/console/workflows?sessionId=${encodeURIComponent(state.owner)}`, { signal }), refetchInterval: 1500 });
  const launch = useMutation({ mutationFn: async () => {
    validateScanPlan(plan);
    if (!state.owner) throw new Error("Choose a session first.");
    if (!approved) throw new Error("Confirm the workflow run first.");
    if (!target.trim()) throw new Error("Enter a target.");
    if (!state.connected) throw new Error("Connect a provider first.");
    return webFetchJson<{ workflow: Workflow }>("/api/console/workflows", jsonBody({ sessionId: state.owner, target: target.trim(), plan, approval: "launch-authorized-run" }));
  }, onSuccess: async () => { setApproved(false); await queryClient.invalidateQueries({ queryKey: ["console-workflows", state.owner] }); } });
  const cancel = useMutation({ mutationFn: (id: string) => webFetchJson<{ workflow: Workflow }>(`/api/console/workflows/${encodeURIComponent(id)}/cancel`, jsonBody({ sessionId: state.owner })), onSuccess: async () => { await jobs.refetch(); } });
  const updatePlan = (patch: Partial<ScanPlan>) => { setPlan(current => ({ ...current, ...patch })); setApproved(false); launch.reset(); };
  return <div className="space-y-5"><WorkflowOwner state={state} />{!state.connected && !state.providers.isPending && <><Empty>Connect a provider below to start a workflow run.</Empty><ConnectionsControl /></>}<ControlCard title="One-step workflow"><form className="space-y-4" onSubmit={event => { event.preventDefault(); launch.mutate(); }}><TextField label="Target" value={target} onChange={event => { setTarget(event.target.value); setApproved(false); }} required maxLength={4096} placeholder="https://…, source:/project, npm:package, pypi:package, cargo:crate, oci:image" /><div className="grid gap-4 sm:grid-cols-2"><Field label="Goal"><Select aria-label="Goal" value={plan.goal} onValueChange={value => updatePlan({ goal: value as ScanPlan["goal"] })} options={[{ value: "known-vulnerabilities", label: "Known vulnerabilities" }, { value: "unknown-vulnerabilities", label: "Unknown vulnerabilities" }, { value: "misconfigurations", label: "Misconfigurations" }]} /></Field><Field label="Depth"><Select aria-label="Depth" value={plan.depth} onValueChange={value => updatePlan({ depth: value as ScanPlan["depth"] })} options={[{ value: "quick", label: "Quick" }, { value: "default", label: "Default" }, { value: "deep", label: "Deep" }]} /></Field><TextField label="Time limit (minutes)" type="number" min={0.01} max={1440} step="any" value={Number.isFinite(plan.timeCapMs) ? plan.timeCapMs / 60000 : ""} required onChange={event => updatePlan({ timeCapMs: event.target.valueAsNumber * 60000 })} /><TextField label="Cost limit (USD)" type="number" min={0.01} max={1000} step="any" value={Number.isFinite(plan.costCapUsd) ? plan.costCapUsd : ""} required onChange={event => updatePlan({ costCapUsd: event.target.valueAsNumber })} /></div><ControlDisclosure title={<>Advanced</>}><div className="mt-3 grid gap-4 sm:grid-cols-2"><TextField label="Assessment attempts" type="number" min={1} max={16} step={1} value={plan.runCount} required onChange={event => updatePlan({ runCount: event.target.valueAsNumber })} /><Field label="Attempt order"><Select aria-label="Attempt order" value={plan.executionMode} onValueChange={value => updatePlan({ executionMode: value as ScanPlan["executionMode"] })} options={[{ value: "sequential", label: "Sequential" }, { value: "parallel", label: "Parallel" }]} /></Field></div></ControlDisclosure><Check checked={approved} onChange={setApproved} disabled={launch.isPending}>I'm authorized to run this workflow against this target with these settings.</Check><Feedback error={launch.error} /><div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={launch.isPending} disabled={!approved || !state.owner || !state.connected || !target.trim()}>Run workflow</SubmitButton><Button type="button" variant="outline" disabled={launch.isPending} onClick={() => { setApproved(false); launch.reset(); }}>Cancel</Button></div></form></ControlCard><ControlCard title="Runs"><QueryState pending={!!state.owner && jobs.isPending} error={jobs.error ?? cancel.error} retry={jobs.refetch} />{!state.owner ? <Empty>Choose a session to see its runs.</Empty> : jobs.data?.workflows.filter(job => job.kind === "run").length === 0 ? <Empty>No runs yet.</Empty> : <div className="space-y-4">{jobs.data?.workflows.filter(job => job.kind === "run").map(workflow => <WorkflowView key={workflow.id} workflow={workflow} cancel={() => cancel.mutate(workflow.id)} cancelling={cancel.isPending && cancel.variables === workflow.id} />)}</div>}</ControlCard></div>;
}

function FixResultView({ result, title }: { result: FixResult; title: string }) {
  return <ControlCard title={title}><Facts entries={[["Result", result.status], ["File", result.sourceFile]]} />{result.error && <Feedback error={result.error} />}{result.rationale && <p className="text-sm leading-relaxed">{result.rationale}</p>}{result.diff ? <DataDisclosure title="Diff" value={result.diff} /> : <Empty>No diff.</Empty>}{result.precondition !== undefined && <DataDisclosure title="Before" value={result.precondition} />}{result.postcondition !== undefined && <DataDisclosure title="After" value={result.postcondition} />}{result.test && <section className="space-y-3"><h3 className="text-sm font-medium">Tests</h3><Facts entries={[["Exit code", result.test.exitCode === null ? "None" : String(result.test.exitCode)], ["Duration", `${(result.test.durationMs / 1000).toFixed(1)}s`]]} />{result.test.timedOut && <Feedback error="Tests timed out." />}<DataDisclosure title="Output" value={result.test.stdout} /><DataDisclosure title="Errors" value={result.test.stderr} /></section>}{result.attempts.length > 0 && <ol className="space-y-2 text-sm">{result.attempts.map(attempt => <li key={attempt.attempt}>Attempt {attempt.attempt}: {attempt.reason}</li>)}</ol>}</ControlCard>;
}

export function FixControl({ sessionId }: { sessionId?: string }) {
  const location = useLocation();
  const state = useWorkflowOwner(sessionId);
  const github = useGitHubPublicationAccount();
  const intent = new URLSearchParams(location.search).get("intent");
  const [findingId, setFindingId] = useState(new URLSearchParams(location.search).get("finding") ?? "");
  const [repoRoot, setRepoRoot] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [fix, setFix] = useState<WebFix | null>(null);
  const [jobId, setJobId] = useState("");
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});
  const jobs = useQuery({ queryKey: ["console-workflows", state.owner], enabled: !!state.owner, queryFn: ({ signal }) => webFetchJson<{ workflows: Workflow[] }>(`/api/console/workflows?sessionId=${encodeURIComponent(state.owner)}`, { signal }), refetchInterval: 2000 });
  const job = useQuery({ queryKey: ["console-workflow", state.owner, jobId], enabled: !!state.owner && !!jobId, queryFn: ({ signal }) => webFetchJson<{ workflow: Workflow }>(`/api/console/workflows/${encodeURIComponent(jobId)}?sessionId=${encodeURIComponent(state.owner)}`, { signal }), refetchInterval: query => query.state.data && !activeStatuses[query.state.data.workflow.status] ? false : 1000 });
  useEffect(() => { if (job.data?.workflow.result?.fix) setFix(job.data.workflow.result.fix); }, [job.data?.workflow.updatedAt]);
  useEffect(() => { setFix(null); setJobId(""); setApprovals({}); }, [state.owner]);
  const approvalIdentity = fix ? JSON.stringify([fix.id, fix.reviewToken, fix.candidateId, fix.publication?.publicationToken, github.data?.connected, github.data?.account, github.data?.scopes]) : "";
  useEffect(() => { setApprovals({}); }, [approvalIdentity]);
  const busy = Boolean(fix?.activeWorkflowId) || Boolean(jobs.data?.workflows.some(workflow => activeStatuses[workflow.status])) || Boolean(job.data && activeStatuses[job.data.workflow.status]);
  const prepare = useMutation({ mutationFn: async () => {
    if (!state.owner) throw new Error("Choose a session first.");
    if (!findingId.trim()) throw new Error("Enter a finding ID.");
    return webFetchJson<{ fix: WebFix }>("/api/console/fixes/prepare", jsonBody({ sessionId: state.owner, findingId: findingId.trim(), ...(repoRoot.trim() ? { repoRoot: repoRoot.trim() } : {}), ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}) }));
  }, onSuccess: data => { setFix(data.fix); setTestCommand(data.fix.testCommand ?? ""); setRepoRoot(data.fix.repoRoot); setJobId(""); setApprovals({}); } });
  const action = useMutation({ mutationFn: async (kind: "propose" | "verify" | "apply" | "inspect" | "publish") => {
    if (!fix || fix.sessionId !== state.owner) throw new Error("Load a finding first.");
    if (kind !== "inspect" && !approvals[kind]) throw new Error("Tick the approval box first.");
    if (kind === "publish" && (!github.data?.connected || !github.data?.available || github.isError)) throw new Error("Connect GitHub first.");
    const payload = { sessionId: state.owner, fixId: fix.id, ...(kind === "propose" ? { reviewToken: fix.reviewToken, approval: "generate-and-test" } : { candidateId: fix.candidateId }), ...(kind === "verify" ? { approval: "run-regression" } : {}), ...(kind === "apply" ? { approval: "apply-to-repository" } : {}), ...(kind === "publish" ? { publicationToken: fix.publication?.publicationToken, approval: "publish-draft-pr" } : {}) };
    return webFetchJson<{ fix: WebFix; workflow?: Workflow }>(`/api/console/fixes/${kind === "inspect" ? "publish" : kind}`, jsonBody(payload));
  }, onSuccess: async data => { setFix(data.fix); setApprovals({}); if (data.workflow) setJobId(data.workflow.id); await jobs.refetch(); } });
  const cancel = useMutation({ mutationFn: (id: string) => webFetchJson<{ workflow: Workflow }>(`/api/console/workflows/${encodeURIComponent(id)}/cancel`, jsonBody({ sessionId: state.owner })), onSuccess: async () => { await Promise.all([job.refetch(), jobs.refetch()]); } });
  const invalidate = () => { setFix(null); setApprovals({}); prepare.reset(); action.reset(); };
  const recent = jobs.data?.workflows.filter(workflow => workflow.kind.startsWith("fix-") && workflow.result?.fix) ?? [];
  let publicationUrl: string | null = null;
  if (fix?.published?.prUrl) { try { const url = new URL(fix.published.prUrl); if (url.protocol === "https:" && !url.username && !url.password) publicationUrl = url.href; } catch { /* Untrusted malformed URLs are not opened. */ } }
  return <div className="space-y-5"><WorkflowOwner state={state} /><ControlCard title="Finding"><form className="space-y-4" onSubmit={event => { event.preventDefault(); prepare.mutate(); }}><TextField label="Finding ID" value={findingId} onChange={event => { setFindingId(event.target.value); invalidate(); }} required disabled={busy || prepare.isPending} /><TextField label="Test command" value={testCommand} onChange={event => { setTestCommand(event.target.value); invalidate(); }} disabled={busy || prepare.isPending} placeholder="npm test" /><ControlDisclosure title={<>Advanced</>}><div className="mt-3"><TextField label="Project folder" value={repoRoot} onChange={event => { setRepoRoot(event.target.value); invalidate(); }} disabled={busy || prepare.isPending} placeholder="/path/to/project" hint="Defaults to the session's folder." /></div></ControlDisclosure><SubmitButton type="submit" pending={prepare.isPending} disabled={!state.owner || !findingId.trim() || busy}>Load finding</SubmitButton></form><Feedback error={prepare.error} />{recent.length > 0 && <ControlDisclosure title={<>Resume a previous fix</>}><div className="mt-3 space-y-2">{recent.map(workflow => <Button key={workflow.id} variant="outline" className="h-auto justify-start whitespace-normal text-left" disabled={busy} onClick={() => { setFix(workflow.result!.fix!); setJobId(workflow.id); setApprovals({}); }}>Finding {workflow.result!.fix!.finding.id} · {workflow.kind} · {workflow.status}</Button>)}</div></ControlDisclosure>}</ControlCard>
    {intent === "publish" && <div role="status" className="rounded-md border border-primary/20 bg-primary/5 p-4 text-sm">To open a pull request, load the finding, review the plan, then approve it below. Nothing has been published yet.</div>}
    {intent === "cancel" && <div role="status" className="rounded-md border border-primary/20 bg-primary/5 p-4 text-sm">Pick the running fix below and press Stop. Nothing has been stopped yet.</div>}
    {!fix?.publication && !github.data?.connected && <GitHubPublicationControl />}
    {fix && <>
      <ControlCard title={fix.finding.title}>
        <Facts entries={[["Severity & status", `${fix.finding.severity} · ${fix.finding.status}`], ["Test command", fix.testCommand || "Missing — add one and load again"]]} />
        <ControlDisclosure title={<>Details</>}><div className="mt-3"><Facts entries={[["Finding", fix.finding.id], ["Project", fix.repoRoot], ["Commit", fix.baseCommit], ["Review ID", fix.reviewToken]]} /></div></ControlDisclosure>
        <Link to={fix.finding.fingerprint ? `/findings/${encodeURIComponent(fix.finding.fingerprint)}` : "/findings"} className="text-sm underline">View finding</Link>
        {!fix.eligible && <Feedback error={fix.reason ?? "This finding can't be fixed automatically."} />}
        {!fix.result && fix.eligible && <div className="space-y-3"><Check checked={approvals.propose ?? false} onChange={value => setApprovals(current => ({ ...current, propose: value }))} disabled={busy || action.isPending}>Generate a fix and run the test command above in a separate copy. Your project isn't changed.</Check><SubmitButton pending={action.isPending && action.variables === "propose"} disabled={!approvals.propose || !fix.testCommand || busy || !state.connected} onClick={() => action.mutate("propose")}>Generate & test fix</SubmitButton></div>}
      </ControlCard>
      {fix.result && <FixResultView result={fix.result} title="Proposed fix" />}
      {fix.verification && <FixResultView result={fix.verification} title="Re-test" />}
      {fix.application && <FixResultView result={fix.application} title="Applied to project" />}
      {fix.applied && <p role="status" className="rounded-md border border-border p-4 text-sm">Fix applied and tested. Load the finding again before doing anything else.</p>}
      {fix.candidateId && !fix.applied && <ControlCard title="Next steps">
        <div className="space-y-3"><Check checked={approvals.verify ?? false} onChange={value => setApprovals(current => ({ ...current, verify: value }))} disabled={busy || action.isPending}>Run the test command again on this fix.</Check><SubmitButton pending={action.isPending && action.variables === "verify"} disabled={!approvals.verify || busy || action.isPending} onClick={() => action.mutate("verify")}>Re-test</SubmitButton></div>
        <div className="space-y-3 border-t border-border pt-4"><Check checked={approvals.apply ?? false} onChange={value => setApprovals(current => ({ ...current, apply: value }))} disabled={busy || action.isPending}>I reviewed the diff and test results. Apply this fix to my project.</Check><SubmitButton pending={action.isPending && action.variables === "apply"} disabled={!approvals.apply || busy || action.isPending} onClick={() => action.mutate("apply")}>Apply fix</SubmitButton></div>
        <div className="border-t border-border pt-4"><SubmitButton variant="outline" pending={action.isPending && action.variables === "inspect"} disabled={busy || action.isPending} onClick={() => action.mutate("inspect")}>Preview pull request</SubmitButton></div>
      </ControlCard>}
      {fix.publication && !fix.applied && <ControlCard title="Pull request preview">
        <Facts entries={[["Remote", fix.publication.remote], ["Branch", `${fix.publication.branch} → ${fix.publication.baseBranch}`], ["Title", fix.publication.title]]} />
        <DataDisclosure title="Diff" value={fix.publication.diff} />
        <GitHubPublicationControl />
        <Check checked={approvals.publish ?? false} onChange={value => setApprovals(current => ({ ...current, publish: value }))} disabled={busy || action.isPending || !github.data?.connected || !github.data?.available || github.isError}>Push this branch to the remote above and open a draft pull request.</Check>
        <SubmitButton pending={action.isPending && action.variables === "publish"} disabled={!approvals.publish || busy || action.isPending || !!fix.published || !github.data?.connected || !github.data?.available || github.isError} onClick={() => action.mutate("publish")}>Open draft pull request</SubmitButton>
      </ControlCard>}
      {fix.published && <ControlCard title="Pull request opened"><Facts entries={[["Branch", fix.published.branch]]} />{publicationUrl ? <Button asChild variant="outline"><a href={publicationUrl} target="_blank" rel="noopener noreferrer">Open pull request<ArrowUpRight className="size-4" /></a></Button> : <Feedback error="The pull request link looks unsafe, so it wasn't opened." />}</ControlCard>}
    </>}
    <Feedback error={action.error ?? cancel.error ?? job.error} />
    {job.data && <WorkflowView workflow={job.data.workflow} cancel={() => cancel.mutate(job.data!.workflow.id)} cancelling={cancel.isPending && cancel.variables === job.data.workflow.id} />}
    <ControlCard title="Fixes">
      <QueryState pending={!!state.owner && jobs.isPending} error={jobs.error} retry={jobs.refetch} />
      {!state.owner ? <Empty>Choose a session to see its fixes.</Empty> : jobs.data?.workflows.filter(workflow => workflow.kind.startsWith("fix-")).length === 0 ? <Empty>No fixes yet.</Empty> : <div className="space-y-4">{jobs.data?.workflows.filter(workflow => workflow.kind.startsWith("fix-") && workflow.id !== jobId).map(workflow => <div key={workflow.id} className="space-y-2"><Button variant="outline" size="sm" onClick={() => { setJobId(workflow.id); if (workflow.result?.fix) setFix(workflow.result.fix); setApprovals({}); }}>Select</Button><WorkflowView workflow={workflow} cancel={() => cancel.mutate(workflow.id)} cancelling={cancel.isPending && cancel.variables === workflow.id} /></div>)}</div>}
    </ControlCard>
    {!state.connected && !state.providers.isPending && <ConnectionsControl />}
  </div>;
}
