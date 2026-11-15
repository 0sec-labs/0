import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { queryKeys } from "@/queries";
import { formatRelativeAge } from "@/lib/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ControlCard, Feedback, SubmitButton } from "./control-ui";
import { deliveryLine, statusLine, webhookVisible, type GitHubWebhookStatus } from "./github-webhook-model";

interface SecretReply { secret: string; graceSeconds?: number; webhook: GitHubWebhookStatus }

function Copy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant="outline" size="sm" aria-label={label} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy"}</Button>;
}

/**
 * GitHub webhook card. Renders nothing unless the engine runs in server mode. The secret lives only in this component's state
 * after create or rotate; it is never put in the query cache and no endpoint returns it again.
 */
export function GitHubWebhookControl() {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.consoleGithubWebhook(),
    queryFn: async ({ signal }) => (await webFetchJson<{ webhook: GitHubWebhookStatus }>("/api/console/github/webhook", { signal })).webhook,
    retry: false, refetchInterval: 30_000,
  });
  const [shown, setShown] = useState<{ secret: string; graceSeconds?: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [testedAt, setTestedAt] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: async (path: "secret" | "secret/rotate") => webFetchJson<SecretReply>(`/api/console/github/webhook/${path}`, { method: "POST", body: "{}" }),
    onSuccess: reply => {
      setShown({ secret: reply.secret, ...(reply.graceSeconds ? { graceSeconds: reply.graceSeconds } : {}) }); setConfirming(false);
      queryClient.setQueryData(queryKeys.consoleGithubWebhook(), reply.webhook);
    },
  });
  const test = useMutation({
    mutationFn: async () => (await webFetchJson<{ webhook: GitHubWebhookStatus }>("/api/console/github/webhook")).webhook,
    onSuccess: webhook => { queryClient.setQueryData(queryKeys.consoleGithubWebhook(), webhook); setTestedAt(new Date().toISOString()); },
  });
  const data = status.data;
  if (!webhookVisible(data)) return null;
  const age = (iso: string) => formatRelativeAge(Date.parse(iso));
  const deliveries = data.deliveries ?? [];
  return <ControlCard title="GitHub webhook" description="Optional. Pull request Agents check GitHub on a timer; a webhook makes them react within seconds. If it stops working, the timer still runs.">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="min-w-0 text-sm">{data.configured ? statusLine(data, age) : "Not set up."}</p>
      <Badge variant="outline">{data.configured ? "On" : "Off"}</Badge>
    </div>
    {shown && <div role="alert" className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
      <p className="font-medium">Copy this secret now. It is shown only once.</p>
      <div className="flex flex-wrap items-center gap-2"><code aria-label="Webhook secret" className="break-all rounded-md border-[0.5px] border-border-2 px-2 py-1 text-xs">{shown.secret}</code><Copy text={shown.secret} label="Copy secret" /></div>
      {shown.graceSeconds && <p className="text-xs text-muted-foreground">The previous secret keeps working for {Math.round(shown.graceSeconds / 60)} minutes. Update it on GitHub before then.</p>}
      <Button type="button" variant="outline" size="sm" onClick={() => setShown(null)}>I saved it</Button>
    </div>}
    {data.configured && <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <div className="min-w-0 sm:col-span-2"><dt className="text-xs text-muted-foreground">Payload URL</dt><dd className="mt-1 flex flex-wrap items-center gap-2">{data.payloadUrl ? <><code className="break-all text-xs">{data.payloadUrl}</code><Copy text={data.payloadUrl} label="Copy payload URL" /></> : <span className="text-muted-foreground">Start the server with --public-url to see it.</span>}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Content type</dt><dd className="mt-1"><code className="text-xs">{data.contentType ?? "application/json"}</code></dd></div>
      <div><dt className="text-xs text-muted-foreground">Events</dt><dd className="mt-1">{(data.events ?? ["Pull requests"]).join(", ")}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Secret</dt><dd className="mt-1 text-muted-foreground">Hidden. Rotate it to get a new one.</dd></div>
    </dl>}
    <div className="flex flex-wrap gap-2">
      {!data.configured && <SubmitButton variant="outline" pending={change.isPending} onClick={() => { change.reset(); change.mutate("secret"); }}>Set up webhook</SubmitButton>}
      {data.configured && !confirming && <Button type="button" variant="outline" onClick={() => setConfirming(true)}>Rotate secret</Button>}
      {data.configured && confirming && <>
        <SubmitButton variant="outline" pending={change.isPending} onClick={() => { change.reset(); change.mutate("secret/rotate"); }}>Confirm rotate</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button></>}
      {data.configured && <SubmitButton variant="outline" pending={test.isPending} onClick={() => { test.reset(); test.mutate(); }}>Test</SubmitButton>}
    </div>
    {data.configured && testedAt && <section aria-label="Recent deliveries" className="space-y-1">
      <p className="text-xs text-muted-foreground">{deliveries.length ? "Last 5 deliveries (outcome only, no content)." : "Nothing has arrived yet. On GitHub, open the webhook and send a ping, or push to a pull request."}</p>
      <ul className="space-y-1 text-sm">{deliveries.map((delivery, index) => <li key={`${delivery.at}-${index}`} className="flex flex-wrap gap-x-2"><span className="text-xs text-muted-foreground">{age(delivery.at)}</span><span>{deliveryLine(delivery)}</span></li>)}</ul>
    </section>}
    <Feedback error={change.error ?? test.error} />
  </ControlCard>;
}
