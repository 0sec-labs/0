import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ScanResumeRequestSchema } from "@0/shared/dist/scan-resume.js";
import { useBackendApi } from "@/api";
import { useBackendSelection } from "@/backend-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** This control resumes assessment state; console session selection supplies current execution authority. */
export function ScanResumeControl({ scan }: { scan: { id: string; target: string; depth: string; mode: string } }) {
  const api = useBackendApi();
  const backend = useBackendSelection();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [branch, setBranch] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [cost, setCost] = useState("5");
  const [approved, setApproved] = useState(false);
  const sessions = useQuery({ queryKey: ["console-sessions"], queryFn: ({ signal }) => api.listConsoleSessions(signal), enabled: open, refetchInterval: open ? 3000 : false });
  const snapshot = useQuery({ queryKey: ["console-control-session", sessionId], queryFn: ({ signal }) => api.getConsoleSnapshot(sessionId, signal), enabled: open && !!sessionId, refetchInterval: open ? 3000 : false });
  const create = useMutation({ mutationFn: () => api.createConsoleSession({}), onSuccess: async session => { await sessions.refetch(); setSessionId(session.id); setApproved(false); } });
  const resume = useMutation({
    mutationFn: () => {
      const request = ScanResumeRequestSchema.parse({ sessionId, approval: "launch-authorized-run", ...(branch !== "" ? { branchFromEntry: Number(branch) } : {}), timeCapMs: Number(minutes) * 60_000, costCapUsd: Number(cost) });
      return api.webFetchJson<{ workflow: { id: string; status: string } }>(`/api/scans/${encodeURIComponent(scan.id)}/resume`, { method: "POST", body: JSON.stringify(request) });
    },
  });
  const job = useQuery({ queryKey: ["scan-resume", resume.data?.workflow.id, sessionId], enabled: open && !!resume.data,
    queryFn: () => api.webFetchJson<{ workflow: { id: string; status: string; error?: string; runs?: Array<{ scanId: string }> } }>(`/api/console/workflows/${encodeURIComponent(resume.data!.workflow.id)}?sessionId=${encodeURIComponent(sessionId)}`), refetchInterval: 2000 });
  const stop = useMutation({ mutationFn: () => api.webFetchJson(`/api/console/workflows/${encodeURIComponent(resume.data!.workflow.id)}/cancel`, { method: "POST", body: JSON.stringify({ sessionId }) }), onSuccess: () => job.refetch() });
  const change = (action: () => void) => { action(); setApproved(false); resume.reset(); };
  const error = resume.error ?? stop.error ?? job.error ?? create.error ?? sessions.error ?? snapshot.error;
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setApproved(false); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm">Resume scan</Button></DialogTrigger>
    <DialogContent className="max-w-lg"><DialogHeader><DialogTitle>Resume scan</DialogTitle></DialogHeader>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (approved) resume.mutate(); }}>
        <p className="break-all text-sm">{scan.target}</p>
        <p className="text-xs text-muted-foreground">{scan.mode} / {scan.depth} · {backend?.backendId ?? "Current engine"}</p>
        <p className="text-sm text-muted-foreground">Continue from the saved findings and journal using this engine's current session, model and target approvals.</p>
        <fieldset disabled={resume.isPending || Boolean(resume.data)} className="space-y-4">
        <Select label="Execution session" disabled={resume.isPending || Boolean(resume.data)} value={sessionId} onValueChange={value => change(() => setSessionId(value))} options={[{ value: "", label: "Choose a session" }, ...(sessions.data ?? []).filter(session => session.status !== "closed").map(session => ({ value: session.id, label: `${session.title ?? session.target ?? session.id} · ${session.status}` }))]} />
        <Button type="button" size="sm" variant="outline" disabled={create.isPending || resume.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "New execution session"}</Button>
        {snapshot.data && <p className="text-xs text-muted-foreground">{snapshot.data.runtime?.model ?? "Configured model"} · {snapshot.data.session.autonomyMode}</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm">Time limit (minutes)<Input type="number" min={0.01} max={1440} step="any" required value={minutes} onChange={event => change(() => setMinutes(event.target.value))} /></label>
          <label className="space-y-1 text-sm">Cost limit (USD)<Input type="number" min={0.01} max={1000} step="any" required value={cost} onChange={event => change(() => setCost(event.target.value))} /></label>
        </div>
        <label className="block space-y-1 text-sm">Branch from journal entry (optional)<Input type="number" min={0} step={1} value={branch} placeholder="Continue the existing scan" onChange={event => change(() => setBranch(event.target.value))} /></label>
        <p className="text-xs text-muted-foreground">A branch copies entries through the selected index into a new run. Prior tool calls are not replayed.</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={approved} disabled={resume.isPending} onChange={event => setApproved(event.target.checked)} />I'm authorized to resume this target with the selected session and limits.</label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p>}
        {resume.data ? <div role="status" className="space-y-2 text-sm"><p>Resume: {job.data?.workflow.status ?? resume.data.workflow.status}</p>{job.data?.workflow.error && <p className="text-destructive">{job.data.workflow.error}</p>}{job.data?.workflow.runs?.map(run => <Link key={run.scanId} className="block underline" to={`/runs/${encodeURIComponent(run.scanId)}`}>View resumed report</Link>)}{["queued", "running", "cancelling"].includes(job.data?.workflow.status ?? resume.data.workflow.status) && <Button type="button" variant="outline" size="sm" disabled={stop.isPending || job.data?.workflow.status === "cancelling"} onClick={() => stop.mutate()}>Stop resume</Button>}<Link className="block underline" to={`/console/${encodeURIComponent(sessionId)}`}>Open execution session</Link></div> : <Button type="submit" disabled={!approved || !sessionId || !snapshot.data || resume.isPending}>{resume.isPending ? "Starting…" : "Resume scan"}</Button>}
      </form>
    </DialogContent>
  </Dialog>;
}
