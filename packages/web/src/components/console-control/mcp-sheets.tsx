import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { SheetPanel } from "@/ui/components/sheet-panel";
import { SettingsCard, SettingsCardRow } from "@/ui/components/settings-card";
import { SettingsRow } from "./settings-section";
import { StatusBadge, type StatusTone } from "@/ui/components/status-badge";
import { Check, Feedback, SubmitButton, TextField } from "./control-ui";
import type { McpActions } from "./mcp-api";
import type { McpApproval, McpServerEntry } from "./mcp-contract";
import { commandPreview, countLabel, emptyMcpDraft, isFullSha, parseGithubRepo, validateMcpDraft, type McpServerDraft } from "./mcp-model";
import { displayToolDescription, displayToolName } from "@/lib/mcp-tool-name";
import { KeyValueRows } from "./mcp-ui";

export const STDIO_WARNING = "A command-line (stdio) MCP server is a program that runs on this machine with your user's permissions. It can read files, use the network and see the environment variables you give it. Add only servers you trust.";

/** Capy-style "MCP server" sheet: define, review the exact command the host will run, add (disabled unless asked), then test and see the discovered tools. */
export function AddMcpServerSheet({ open, onOpenChange, actions, hostName }: { open: boolean; onOpenChange: (open: boolean) => void; actions: McpActions; hostName: string }) {
  const { preview, create, test } = actions;
  const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [touched, setTouched] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [enable, setEnable] = useState(false);
  useEffect(() => { if (!open) { setDraft(emptyMcpDraft()); setStep("form"); setTouched(false); setAcknowledged(false); setEnable(false); preview.reset(); create.reset(); test.reset(); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const validation = validateMcpDraft(draft);
  const busy = create.isPending;
  const change = (patch: Partial<McpServerDraft>) => { setDraft(current => ({ ...current, ...patch })); preview.reset(); create.reset(); };
  const review = () => { setTouched(true); if (validation.ok && validation.payload) preview.mutate(validation.payload, { onSuccess: () => { setAcknowledged(false); setStep("review"); } }); };
  const stdio = draft.transport === "stdio";
  const error = (key: keyof typeof validation.errors) => touched ? validation.errors[key] : undefined;
  const approval = preview.data;
  const created = create.data;
  const title = step === "form" ? "Add MCP server" : step === "review" ? "Review and add" : "Server added";
  return <SheetPanel open={open} onOpenChange={onOpenChange} locked={busy} title={title} description={step === "form" ? `Connect a custom Model Context Protocol server to ${hostName}. Nothing runs until you review and add it.` : step === "review" ? "Check exactly what will be saved. Nothing has run yet." : "It is saved on this host. Test it to see the tools it offers."}
    footer={<>
        {step === "form" && <><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><SubmitButton type="submit" form="add-mcp-server" pending={preview.isPending}>Review</SubmitButton></>}
        {step === "review" && <><Button variant="ghost" disabled={busy} onClick={() => setStep("form")}>Back</Button>
          <SubmitButton pending={busy} disabled={!acknowledged || !approval || !validation.payload} onClick={() => approval && validation.payload && create.mutate({ config: validation.payload, fingerprint: approval.fingerprint, enable }, { onSuccess: () => setStep("done") })}>Add server</SubmitButton></>}
        {step === "done" && <Button onClick={() => onOpenChange(false)}>Done</Button>}
  </>}>
        {step === "form" && <form id="add-mcp-server" className="flex flex-col gap-5" noValidate onSubmit={event => { event.preventDefault(); review(); }}>
          <TextField label="Name" value={draft.name} onChange={event => change({ name: event.target.value })} placeholder="Docs" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error("name"))} hint={error("name")} data-1p-ignore data-lpignore="true" />
          <div className="grid gap-2 text-sm"><label className="font-medium" htmlFor="mcp-transport">Transport</label><Select id="mcp-transport" aria-label="Transport" value={draft.transport} onValueChange={value => change({ transport: value === "http" || value === "sse" ? value : "stdio" })} options={[{ value: "stdio", label: "Command (stdio)" }, { value: "http", label: "HTTP (streamable)" }, { value: "sse", label: "SSE" }]} /></div>
          {stdio ? <>
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm" role="note"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" /><span>{STDIO_WARNING}</span></div>
            <TextField label="Command" value={draft.command} onChange={event => change({ command: event.target.value })} placeholder="npx" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error("command"))} hint={error("command") ?? "Just the program. Arguments go below."} data-1p-ignore data-lpignore="true" />
            <TextField label="Arguments" value={draft.args} onChange={event => change({ args: event.target.value })} placeholder={'-y @scope/server "/path with spaces"'} autoComplete="off" spellCheck={false} aria-invalid={Boolean(error("args"))} hint={error("args") ?? "Separated by spaces; use quotes around one that contains spaces. No shell is involved."} data-1p-ignore data-lpignore="true" />
            <TextField label="Working folder (optional)" value={draft.cwd} onChange={event => change({ cwd: event.target.value })} placeholder="tools/server" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error("cwd"))} hint={error("cwd") ?? "Relative to the workspace root. It cannot leave the workspace."} data-1p-ignore data-lpignore="true" />
            <KeyValueRows label="Environment variables" rows={draft.env} onChange={env => change({ env })} keyLabel="Variable" keyPlaceholder="API_KEY" secret error={error("env")} />
          </> : <>
            <TextField label="URL" type="url" value={draft.url} onChange={event => change({ url: event.target.value })} placeholder="https://example.com/mcp" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error("url"))} hint={error("url") ?? "https only. Private and local addresses are refused by the host."} data-1p-ignore data-lpignore="true" />
            <KeyValueRows label="Headers" rows={draft.headers} onChange={headers => change({ headers })} keyLabel="Header" keyPlaceholder="Authorization" secret error={error("headers")} />
          </>}
          <p className="text-xs text-muted-foreground-2">Values are write-only. They are saved on {hostName} and never shown again.</p>
          {preview.isError && <Feedback error={preview.error} />}
        </form>}
        {step === "review" && approval && <ApprovalReview approval={approval} name={draft.name.trim()} hostName={hostName} />}
        {step === "review" && <>
          <Check checked={acknowledged} onChange={setAcknowledged} disabled={busy}>{approval?.transport === "stdio" ? `I trust this command and understand it will run on ${hostName} as my user.` : "I trust this server and understand 0 can call its tools."}</Check>
          <Check checked={enable} onChange={setEnable} disabled={busy}>Enable it for new missions right away. Leave this off to test first.</Check>
          <Feedback error={create.error} />
        </>}
        {step === "done" && created && <div className="flex flex-col gap-4">
          <SettingsCard className="mx-0"><SettingsRow label={created.name} description={created.enabled ? "Enabled for new missions." : "Saved and off. Test it, then turn it on from its page."}><StatusBadge appearance="outline" tone={created.enabled ? "success" : "neutral"}>{created.enabled ? "On" : "Off"}</StatusBadge></SettingsRow></SettingsCard>
          <div className="flex flex-col gap-3 rounded-(--radius-card) border-[0.5px] border-(--card-hairline) bg-card p-4">
            <div className="flex items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-medium">Test connection</h3><p className="text-sm text-muted-foreground-2">{stdio ? `Starts the command once on ${hostName} to list its tools.` : "Connects once to list its tools."}</p></div><SubmitButton type="button" variant="outline" size="sm" pending={test.isPending} onClick={() => test.mutate({ id: created.id })}>{test.data ? "Test again" : "Test connection"}</SubmitButton></div>
            {test.isError && <Feedback error={test.error} />}
            {test.data && <TestResult result={test.data} />}
          </div>
        </div>}
  </SheetPanel>;
}

/** What the host will save and start, taken from the host's own review rather than from the form, so the user sees what the server will actually use. */
function ApprovalReview({ approval, name, hostName }: { approval: McpApproval; name: string; hostName: string }) {
  const { summary } = approval; const stdio = approval.transport === "stdio";
  const names = stdio ? summary.envKeys : summary.headerNames;
  return <div className="flex flex-col gap-5">
    <SettingsCard className="mx-0">
      <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">Name</h3><p className="text-sm break-words text-muted-foreground-2">{name}</p></div></SettingsCardRow>
      <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">{stdio ? `Command that will run on ${hostName}` : "URL"}</h3>{stdio && summary.command
        ? <pre aria-label="Exact command" className="mt-1 overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs break-all whitespace-pre-wrap">{commandPreview(summary.command, summary.args)}</pre>
        : <p className="text-sm break-all text-muted-foreground-2">{summary.url}</p>}{stdio && summary.cwd && <p className="mt-1 text-xs break-all text-muted-foreground-2">In {summary.cwd}</p>}</div></SettingsCardRow>
      {names.length > 0 && <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">{stdio ? "Environment variables" : "Headers"}</h3><p className="text-sm break-words text-muted-foreground-2">{names.join(", ")} (values hidden)</p></div></SettingsCardRow>}
    </SettingsCard>
    {stdio && <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm" role="note"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" /><span>{STDIO_WARNING}</span></div>}
    {approval.warnings.length > 0 && <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground-1">{approval.warnings.map(warning => <li key={warning} className="break-words">{warning}</li>)}</ul>}
  </div>;
}

function TestResult({ result }: { result: { toolCount: number; resourceCount: number; serverVersion?: string; tools: { name: string; description: string }[] } }) {
  return <div className="flex flex-col gap-2"><p role="status" className="text-sm text-success">Connected{result.serverVersion ? ` to version ${result.serverVersion}` : ""}. Found {countLabel(result.toolCount, "tool")}{result.resourceCount ? ` and ${countLabel(result.resourceCount, "resource")}` : ""}.</p>
    {result.tools.length > 0 && <ul aria-label="Discovered tools" className="max-h-56 divide-y-[0.5px] divide-border-1 overflow-y-auto rounded-md border-[0.5px] border-border-2">{result.tools.map(tool => <li key={tool.name} className="px-3 py-2"><p title={tool.name} className="text-sm font-medium break-words">{displayToolName(tool.name)}</p>{displayToolDescription(tool.description) && <p className="line-clamp-2 text-xs break-words text-muted-foreground-2">{displayToolDescription(tool.description)}</p>}</li>)}</ul>}</div>;
}

/** Install a plugin straight from a GitHub repository. The user reviews the resolved commit and declared permissions, then approves that exact commit. Nothing updates on its own. */
export function AddGithubPluginSheet({ open, onOpenChange, actions }: { open: boolean; onOpenChange: (open: boolean) => void; actions: McpActions }) {
  const { githubReview, githubApprove } = actions;
  const [repo, setRepo] = useState(""); const [ref, setRef] = useState("");
  const [touched, setTouched] = useState(false); const [reviewed, setReviewed] = useState(false); const [replace, setReplace] = useState(false); const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (!open) { setRepo(""); setRef(""); setTouched(false); setReviewed(false); setReplace(false); setDone(null); githubReview.reset(); githubApprove.reset(); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const parsed = parseGithubRepo(repo, ref);
  const review = githubReview.data; const busy = githubApprove.isPending;
  const resolve = () => { setTouched(true); setReviewed(false); setReplace(false); githubApprove.reset(); if (parsed.value) githubReview.mutate({ repo: parsed.value.repo, ref: parsed.value.ref === "HEAD" ? undefined : parsed.value.ref }); };
  const edit = (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => { set(event.target.value); if (review) githubReview.reset(); githubApprove.reset(); setReviewed(false); };
  const approvable = review && isFullSha(review.sha) && (!review.alreadyInstalled || replace);
  return <SheetPanel open={open} onOpenChange={onOpenChange} locked={busy} showClose={!busy && !done} title="Add plugin from GitHub" description="0 fetches the repository without running anything, pins one commit, and shows you what the plugin asks for. You approve that commit before it is installed."
    footer={<>
        <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{done ? "Close" : "Cancel"}</Button>
        {review && !done && <SubmitButton pending={busy} disabled={!reviewed || !approvable} onClick={() => githubApprove.mutate({ reviewId: review.reviewId, sha: review.sha, permissionHash: review.permissionHash, ...(replace ? { replaceExisting: true } : {}) }, { onSuccess: result => setDone(result?.message || "Installed, and not enabled. Open it in the list to review its permissions and enable it.") })}>Install commit {review.sha.slice(0, 7)}</SubmitButton>}
  </>}>
        <form id="add-github-plugin" noValidate hidden={Boolean(done)} className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); resolve(); }}>
          <TextField label="Repository" value={repo} onChange={edit(setRepo)} placeholder="owner/name" autoComplete="off" spellCheck={false} aria-invalid={touched && Boolean(parsed.error)} hint={touched && parsed.error ? parsed.error : "For example acme/0-plugin, or a github.com link."} data-1p-ignore data-lpignore="true" disabled={githubReview.isPending || busy} />
          <TextField label="Branch, tag or commit" value={ref} onChange={edit(setRef)} placeholder="main" autoComplete="off" spellCheck={false} hint="Optional. Defaults to the repository's default branch." data-1p-ignore data-lpignore="true" disabled={githubReview.isPending || busy} />
          <div><SubmitButton type="submit" variant="outline" size="sm" pending={githubReview.isPending} disabled={busy}>{review ? "Resolve again" : "Resolve and review"}</SubmitButton></div>
          {githubReview.isError && <Feedback error={githubReview.error} />}
        </form>
        {review && !done && <section className="flex flex-col gap-4" aria-label="Review">
          <SettingsCard className="mx-0">
            <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">{review.name}{review.version ? ` ${review.version}` : ""}</h3><p className="text-sm break-words text-muted-foreground-2">{review.repo} @ {review.ref}</p></div></SettingsCardRow>
            <SettingsCardRow><div className="min-w-0"><h3 className="text-sm font-medium">Resolved commit</h3><p aria-label="Resolved commit" className="font-mono text-xs break-all text-foreground">{review.sha}</p>{!isFullSha(review.sha) && <p className="text-sm text-warning">This is not a full commit hash. Do not approve it.</p>}{review.entryBytes ? <p className="mt-1 text-xs text-muted-foreground-2">Plugin code: {Math.max(1, Math.round(review.entryBytes / 1024))} KB</p> : null}</div></SettingsCardRow>
          </SettingsCard>
          <div className="flex flex-col gap-2"><h3 className="text-base font-medium">Permissions it asks for</h3>
            <SettingsCard className="mx-0">{review.capabilities.length ? review.capabilities.map(permission => <div key={permission} className="p-4 text-sm break-words">{permission}</div>) : <div className="p-4 text-sm text-muted-foreground-2">No extra permissions declared.</div>}</SettingsCard></div>
          {review.tools.length > 0 && <div className="flex flex-col gap-2"><h3 className="text-base font-medium">Tools</h3><SettingsCard className="mx-0">{review.tools.map(tool => <div key={tool.name} className="p-4"><h4 className="text-sm font-medium break-words">{tool.name}</h4>{tool.description && <p className="text-sm break-words text-muted-foreground-2">{tool.description}</p>}{tool.capabilities.length > 0 && <p className="text-xs text-muted-foreground-2">Needs: {tool.capabilities.join(", ")}</p>}</div>)}</SettingsCard></div>}
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm" role="note"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" /><span>Plugin code is third-party code that runs with the permissions above once you enable it. Installing does not enable it.</span></div>
          <p className="text-sm text-muted-foreground-2">This installs commit {review.sha.slice(0, 12)} only. It never updates by itself. To take a newer version, add the repository again and review the new commit.</p>
          {review.alreadyInstalled && <Check checked={replace} onChange={setReplace} disabled={busy}>A plugin with this id is already installed. Replace it with this commit.</Check>}
          <Check checked={reviewed} onChange={setReviewed} disabled={busy}>I reviewed commit {review.sha.slice(0, 12)} and its permissions.</Check>
          <Feedback error={githubApprove.error} />
        </section>}
        {done && <Feedback message={done} />}
  </SheetPanel>;
}

const statusView = (item: McpServerEntry): { tone: StatusTone; label: string } => !item.enabled ? { tone: "neutral", label: "Off" } : item.status === "ok" ? { tone: "success", label: "Connected" } : item.status === "error" ? { tone: "warning", label: "Needs attention" } : { tone: "neutral", label: "Not tested" };
export const mcpStatus = statusView;
