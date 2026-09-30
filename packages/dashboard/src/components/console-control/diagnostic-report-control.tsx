import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { webFetchJson } from "@/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check, ControlCard, Facts, Feedback, Field, SubmitButton, jsonBody } from "./control-ui";

interface FeedbackResponse { saved?: boolean; path?: string; submitted: boolean; cancelled?: boolean; previewId?: string; preview?: { url: string; body: string; headers: Record<string, string>; warnings: string[] } }

export function DiagnosticReportControl() {
  const [message, setMessage] = useState("");
  const [requestPreview, setRequestPreview] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [staged, setStaged] = useState<FeedbackResponse | null>(null);
  const mutation = useMutation({ mutationFn: async (action: "save" | "send" | "cancel") => {
    if (action === "send" && (!staged?.previewId || !reviewed)) throw new Error("Review the report and confirm sending first.");
    if (action === "save" && !message.trim()) throw new Error("Enter some feedback first.");
    const input = action === "save" ? { message: message.trim(), submit: requestPreview } : action === "send" ? { action, previewId: staged?.previewId } : { action };
    return webFetchJson<FeedbackResponse>("/api/console/feedback", jsonBody(input));
  }, onSuccess: data => { setStaged(data); setReviewed(false); if (data.submitted) setMessage(""); } });
  return <ControlCard title="Feedback">
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate("save"); }}>
      <Field label="What happened?" hint="Don't paste passwords or keys."><Textarea value={message} maxLength={16000} required rows={4} disabled={mutation.isPending} onChange={event => { setMessage(event.target.value); setStaged(null); setReviewed(false); mutation.reset(); }} /></Field>
      <Check checked={requestPreview} onChange={value => { setRequestPreview(value); setStaged(null); setReviewed(false); }} disabled={mutation.isPending}>Also prepare a report to send (nothing is sent yet).</Check>
      <SubmitButton type="submit" pending={mutation.isPending && mutation.variables === "save"} disabled={!message.trim() || mutation.isPending}>{requestPreview ? "Save & preview" : "Save"}</SubmitButton>
    </form>
    {staged?.path && <p className="break-all text-xs text-muted-foreground">Saved to {staged.path}</p>}
    {staged?.preview && <section className="space-y-4 border-t border-border pt-4">
      <Facts entries={[["Sends to", staged.preview.url]]} />
      {staged.preview.warnings.map((warning, index) => <p key={index} className="rounded-md border border-border bg-muted/20 p-3 text-sm">{warning}</p>)}
      <details><summary className="cursor-pointer text-sm">Headers</summary><pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(staged.preview.headers, null, 2)}</pre></details>
      <div><h3 className="mb-2 text-sm font-medium">Report contents</h3><pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{staged.preview.body}</pre></div>
      <Check checked={reviewed} onChange={setReviewed} disabled={mutation.isPending}>I reviewed this report and want to send it now (just this once).</Check>
      <div className="flex flex-wrap gap-2"><SubmitButton pending={mutation.isPending && mutation.variables === "send"} disabled={!reviewed || mutation.isPending} onClick={() => mutation.mutate("send")}>Send</SubmitButton><Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate("cancel")}>Don't send</Button></div>
    </section>}
    <Feedback error={mutation.error} message={staged?.submitted ? "Report sent." : staged?.cancelled ? "Not sent. Your feedback is still saved." : staged?.saved && !staged.preview ? "Saved. Nothing was sent." : null} />
  </ControlCard>;
}
