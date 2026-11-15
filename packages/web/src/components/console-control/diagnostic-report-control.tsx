import { ControlDisclosure } from "./control-disclosure";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check, ControlCard, Facts, Feedback, Field, SubmitButton, jsonBody } from "./control-ui";

interface FeedbackResponse { saved?: boolean; path?: string; submitted: boolean; cancelled?: boolean; previewId?: string; preview?: { url: string; body: string; headers: Record<string, string>; warnings: string[] } }

interface PendingReport { id: string; createdAt: string; surface: "cli" | "web"; category: string }

/** Crash reports the engine stored locally. Nothing is sent until the operator previews and confirms. */
function PendingReports() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const [reviewed, setReviewed] = useState(false);
  const [active, setActive] = useState<{ id: string; staged: FeedbackResponse } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["diagnostics-pending"], queryFn: () => webFetchJson<{ reports: PendingReport[] }>("/api/console/diagnostics/pending") });
  const act = useMutation({ mutationFn: async (input: { id: string; action: "preview" | "send" | "discard" }) => {
    if (input.action === "send" && (!active?.staged.previewId || active.id !== input.id || !reviewed)) throw new Error("Preview the report and confirm sending first.");
    const data = await webFetchJson<FeedbackResponse & { discarded?: boolean }>(`/api/console/diagnostics/pending/${input.id}`, jsonBody({ action: input.action, ...(input.action === "send" ? { previewId: active?.staged.previewId } : {}) }));
    return { ...input, data };
  }, onSuccess: ({ id, action, data }) => {
    setReviewed(false);
    if (action === "preview") { setActive({ id, staged: data }); setNote(null); return; }
    setActive(null);
    setNote(action === "send" ? "Report sent." : "Report discarded. Nothing was sent.");
    void queryClient.invalidateQueries({ queryKey: ["diagnostics-pending"] });
  } });
  const reports = list.data?.reports ?? [];
  if (reports.length === 0 && !note) return null;
  return <section className="space-y-3 border-b border-border pb-4" aria-label="Crash reports waiting for review">
    <h3 className="text-sm font-medium">Crash reports waiting for review</h3>
    <p className="text-sm text-muted-foreground">0security stored these on this computer after an error. Nothing is sent unless you preview the report and confirm.</p>
    {reports.map(report => <div key={report.id} className="space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">{report.surface === "web" ? "Web app" : "Terminal"} error: {report.category} <span className="text-muted-foreground">({new Date(report.createdAt).toLocaleString()})</span></span>
        <div className="flex gap-2"><Button variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: report.id, action: "preview" })}>Preview</Button><Button variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: report.id, action: "discard" })}>Discard</Button></div>
      </div>
      {active?.id === report.id && active.staged.preview && <div className="space-y-3">
        <Facts entries={[["Sends to", active.staged.preview.url]]} />
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{active.staged.preview.body}</pre>
        <Check checked={reviewed} onChange={setReviewed} disabled={act.isPending}>I reviewed this report and want to send it now (just this once).</Check>
        <div className="flex gap-2"><SubmitButton pending={act.isPending && act.variables?.action === "send"} disabled={!reviewed || act.isPending} onClick={() => act.mutate({ id: report.id, action: "send" })}>Send</SubmitButton><Button variant="outline" disabled={act.isPending} onClick={() => { setActive(null); setReviewed(false); }}>Don't send</Button></div>
      </div>}
    </div>)}
    <Feedback error={act.error ?? (list.error as Error | null)} message={note} />
  </section>;
}

export function DiagnosticReportControl() {
  const { webFetchJson } = useBackendApi();
  const [message, setMessage] = useState("");
  const [requestPreview, setRequestPreview] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [staged, setStaged] = useState<FeedbackResponse | null>(null);
  const mutation = useMutation({ mutationFn: async (action: "save" | "send" | "cancel") => {
    if (action === "send" && (!staged?.previewId || !reviewed)) throw new Error("Review the report and confirm sending first.");
    if (action === "save" && !message.trim()) throw new Error("Enter some feedback first.");
    const input = action === "save" ? { message: message.trim(), submit: requestPreview } : action === "send" ? { action, previewId: staged?.previewId } : { action };
    return webFetchJson<FeedbackResponse>("/api/console/feedback", jsonBody(input));
  }, onSuccess: data => { setStaged(data); setReviewed(false); if (data.submitted || (data.saved && !data.preview)) setMessage(""); } });
  return <ControlCard title="Feedback">
    <PendingReports />
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate("save"); }}>
      <Field label="What happened?" hint="Don't paste passwords or keys."><Textarea value={message} maxLength={16000} required rows={4} disabled={mutation.isPending} onChange={event => { setMessage(event.target.value); setStaged(null); setReviewed(false); mutation.reset(); }} /></Field>
      <Check checked={requestPreview} onChange={value => { setRequestPreview(value); setStaged(null); setReviewed(false); }} disabled={mutation.isPending}>Also prepare a report to review before sending.</Check>
      <SubmitButton type="submit" pending={mutation.isPending && mutation.variables === "save"} disabled={!message.trim() || mutation.isPending}>{requestPreview ? "Save & preview" : "Save"}</SubmitButton>
    </form>
    {staged?.preview && <section className="space-y-4 border-t border-border pt-4">
      <Facts entries={[["Sends to", staged.preview.url]]} />
      {staged.preview.warnings.map((warning, index) => <p key={index} className="rounded-md border border-border bg-muted/20 p-3 text-sm">{warning}</p>)}
      <ControlDisclosure title={<>Headers</>}><pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(staged.preview.headers, null, 2)}</pre></ControlDisclosure>
      <div><h3 className="mb-2 text-sm font-medium">Report contents</h3><pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{staged.preview.body}</pre></div>
      <Check checked={reviewed} onChange={setReviewed} disabled={mutation.isPending}>I reviewed this report and want to send it now (just this once).</Check>
      <div className="flex flex-wrap gap-2"><SubmitButton pending={mutation.isPending && mutation.variables === "send"} disabled={!reviewed || mutation.isPending} onClick={() => mutation.mutate("send")}>Send</SubmitButton><Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate("cancel")}>Don't send</Button></div>
    </section>}
    <Feedback error={mutation.error} message={staged?.submitted ? "Report sent." : staged?.cancelled ? "Not sent. Your feedback is still saved." : staged?.saved && !staged.preview ? "Saved." : null} />
  </ControlCard>;
}
