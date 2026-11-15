import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { Tooltip } from "@/components/ui/tooltip";
import { ControlDisclosure } from "./control-disclosure";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { useBackendApi } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Check, ControlCard, Empty, Facts, Feedback, Field, QueryState, SubmitButton, TextField, jsonBody } from "./control-ui";
import type { CheckItem, ChecksResponse, ProjectResponse, Provider, SessionSnapshot, SessionSummary } from "./contracts";
import { DiagnosticReportControl } from "./diagnostic-report-control";

import { healthHint, providerUnusable } from "@/console/provider-health";

/** Targets are shown as plain folders; an absolute folder is stored in the engine's source form. */
const plainTarget = (target: string): string => target.replace(/^source:/, "");
const engineTarget = (target: string): string => { const value = target.trim(); return value.startsWith("/") ? `source:${value}` : value; };

function ReviewCheckRow({ item, busy, mutate }: { item: CheckItem; busy: boolean; mutate: (mutation: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(item.prompt);
  const [approved, setApproved] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => { setPrompt(item.prompt); setApproved(false); setEditing(false); }, [item.revision, item.prompt]);
  return <article className="min-w-0 space-y-3 border-t border-border-1 pt-4 first:border-t-0 first:pt-0"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.name}</h3>{item.enabled && item.approvedRevision !== item.revision && <p className="mt-1 text-xs text-destructive">Changed since approval</p>}</div><Badge variant={item.enabled ? "secondary" : "outline"}>{item.enabled ? "On" : "Off"}</Badge></div>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); mutate({ action: "set", id: item.id, prompt: prompt.trim(), approved, expectedRevision: item.revision }); }}><Field label="Check prompt"><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={2000} disabled={busy} /></Field>{item.enabled && <Check checked={approved} onChange={setApproved}>I approve this new prompt.</Check>}<div className="flex gap-2"><SubmitButton pending={busy} type="submit" disabled={!prompt.trim() || (item.enabled && !approved)}>Save</SubmitButton><Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(false); setPrompt(item.prompt); setApproved(false); }}>Cancel</Button></div></form> : <><p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{item.prompt}</p>{!item.enabled && <Check checked={approved} onChange={setApproved} disabled={busy}>I approve this prompt.</Check>}<div className="flex flex-wrap gap-2">{item.enabled ? <Button size="sm" variant="outline" disabled={busy} onClick={() => mutate({ action: "disable", id: item.id })}>Disable</Button> : <Button size="sm" disabled={busy || !approved} onClick={() => mutate({ action: "enable", id: item.id, approved: true, expectedRevision: item.revision })}>Turn on</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(true); setApproved(false); }}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button></div></>}
    {removing && <div className="space-y-2 border-t border-border pt-3"><p className="text-sm">Delete this check? This can't be undone.</p><div className="flex gap-2"><Button variant="destructive" size="sm" disabled={busy} onClick={() => mutate({ action: "remove", id: item.id })}>Delete</Button><Button variant="outline" size="sm" onClick={() => setRemoving(false)}>Cancel</Button></div></div>}
  </article>;
}

export function ProjectControl({ sessionId, onApplied }: { sessionId?: string; onApplied?: (session: SessionSummary) => void }) {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [path, setPath] = useState("");
  const [inspected, setInspected] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [approveNew, setApproveNew] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inScope, setInScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const project = useQuery({ queryKey: queryKeys.consoleProject(inspected), retry: false, queryFn: ({ signal }) => webFetchJson<ProjectResponse>(`/api/console/project?path=${encodeURIComponent(inspected)}`, { signal }) });
  // A failed lookup must not replace the project already shown: keep the last good one beside an inline error.
  const [shown, setShown] = useState<ProjectResponse | undefined>();
  useEffect(() => { if (project.data) { setShown(project.data); if (!inspected) setPath(current => current || project.data!.path); } }, [project.data]);
  const checks = useQuery({ queryKey: queryKeys.consoleChecks(shown?.path), enabled: !!shown, queryFn: ({ signal }) => webFetchJson<ChecksResponse>(`/api/console/checks?path=${encodeURIComponent(shown!.path)}`, { signal }) });
  const snapshot = useQuery({ queryKey: queryKeys.consoleControlSession(sessionId), enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal })).snapshot });
  useEffect(() => { if (snapshot.data) { setTarget(plainTarget(snapshot.data.session.target)); setInScope(snapshot.data.scope?.in_scope?.join("\n") ?? ""); setOutOfScope(snapshot.data.scope?.out_of_scope?.join("\n") ?? ""); } }, [snapshot.data?.session.id]);
  const configuration = useMutation({ mutationFn: async () => {
    const owner = sessionId ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({ target: engineTarget(target) }))).session.id;
    return (await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(owner)}/configuration`, { method: "PATCH", body: JSON.stringify({ target: engineTarget(target), scope: { in_scope: inScope.split("\n").map(rule => rule.trim()).filter(Boolean), out_of_scope: outOfScope.split("\n").map(rule => rule.trim()).filter(Boolean) } }) })).session;
  }, onSuccess: async session => { setMessage(session.pendingConfiguration ? "Saved. Takes effect after the current step." : "Saved."); await queryClient.invalidateQueries({ queryKey: queryKeys.consoleControlSession() }); if (onApplied) onApplied(session); else if (!sessionId) { const params = new URLSearchParams(location.search); params.set("session", session.id); params.set("return", `/chats/${session.id}`); navigate(`${location.pathname}?${params}`, { replace: true }); } } });
  const changeCheck = useMutation({ mutationFn: (mutation: Record<string, unknown>) => webFetchJson<ChecksResponse>("/api/console/checks", jsonBody({ path: shown!.path, mutation })), onSuccess: result => { queryClient.setQueryData(queryKeys.consoleChecks(shown!.path), result); setName(""); setPrompt(""); setApproveNew(false); setMessage("Checks updated."); } });
  return <div className="flex flex-col gap-10"><ControlCard title="Folder"><form className="flex flex-col items-end gap-3 sm:flex-row" onSubmit={event => { event.preventDefault(); setInspected(path.trim()); }}><div className="w-full"><TextField label="Folder" value={path} onChange={event => setPath(event.target.value)} placeholder="Folder to inspect" /></div><SubmitButton type="submit" variant="outline" pending={project.isFetching && !project.isPending} disabled={!path.trim()}>Open</SubmitButton></form>{project.error ? <Feedback error={inspected ? "Folder not found." : project.error} /> : <QueryState pending={project.isPending && !shown} error={null} retry={project.refetch} />}{shown && <><Facts entries={[["Project", <Tooltip content={shown.path}><span tabIndex={0}>{shown.name}</span></Tooltip>], ["Branch", shown.git.branch ?? "Not a Git repo"], ["Changes", shown.git.dirty ? "Uncommitted changes" : "Clean"]]} />{shown.git.error && <Feedback error={shown.git.error} />}<Button variant="outline" onClick={() => setTarget(shown.path)}>Use as target</Button></>}</ControlCard>
    <ControlCard title="Scope">
      <QueryState pending={!!sessionId && snapshot.isPending} error={snapshot.error} retry={snapshot.refetch} />
      {snapshot.data && !snapshot.data.scopeEnforcement.enabled && <p className="text-xs text-muted-foreground">Scope rules apply once the scope plugin is on. Your own folder is always allowed.</p>}
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); configuration.mutate(); }}>
        <TextField label="Focus (optional)" value={target} onChange={event => setTarget(event.target.value)} maxLength={4096} placeholder="Website or folder to focus on" />
        <ControlDisclosure key={snapshot.data?.session.id ?? "new"} defaultOpen={!!(snapshot.data?.scope?.in_scope?.length || snapshot.data?.scope?.out_of_scope?.length)} title={<>Scope rules for outside targets</>}><div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Allowed targets"><Textarea rows={4} placeholder="One per line" value={inScope} onChange={event => setInScope(event.target.value)} /></Field>
          <Field label="Off limits"><Textarea rows={4} placeholder="One per line" value={outOfScope} onChange={event => setOutOfScope(event.target.value)} /></Field>
        </div></ControlDisclosure>
        <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={configuration.isPending}>{sessionId ? "Save settings" : "Create settings"}</SubmitButton><Button type="button" variant="outline" onClick={() => { setTarget(plainTarget(snapshot.data?.session.target ?? "")); setInScope(snapshot.data?.scope?.in_scope?.join("\n") ?? ""); setOutOfScope(snapshot.data?.scope?.out_of_scope?.join("\n") ?? ""); configuration.reset(); }}>Reset form</Button></div>
      </form><Feedback error={configuration.error} message={message} />
    </ControlCard>
    {shown && <ControlCard title="Review checks"><QueryState pending={checks.isPending} error={checks.error} retry={checks.refetch} />{checks.data?.checks.length === 0 && <Empty>No checks yet.</Empty>}{checks.data?.checks.map(item => <ReviewCheckRow key={item.id} item={item} busy={changeCheck.isPending} mutate={mutation => changeCheck.mutate(mutation)} />)}<ControlDisclosure className="border-t border-border pt-4" key={checks.data ? "loaded-checks" : "loading-checks"} defaultOpen={checks.data?.checks.length === 0} title={<>Add a check</>}><form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); changeCheck.mutate({ action: approveNew ? "add" : "propose", name: name.trim(), prompt: prompt.trim(), ...(approveNew ? { approved: true } : {}) }); }}><TextField label="New check name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} /><Field label="What to check"><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={2000} rows={4} /></Field><Check checked={approveNew} onChange={setApproveNew}>Turn on now (otherwise saved as a draft).</Check><SubmitButton type="submit" variant="outline" pending={changeCheck.isPending} disabled={!name.trim() || !prompt.trim()}>{approveNew ? "Add check" : "Save draft"}</SubmitButton></form></ControlDisclosure><Feedback error={changeCheck.error} /></ControlCard>}
  </div>;
}

const sentence = (value: string): string => value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
/** Provider probe failures name internal wiring; show the action instead. */
export const plainHealthError = (message?: string): string | undefined => message && /wire mapping|\bprobe\b/i.test(message) ? "This connection needs attention. Reconnect it in Models." : message;

export interface DoctorResponse { version: string; runtime: { node: string; nodeSupported: boolean; platform: string; arch: string; engine: string; engineVersion: string; releaseChannel: string }; availability: { hasApiKey: boolean; availableRuntimes: string[]; apiRuntime: { configured: boolean; valid: boolean; providerLabel: string; error?: string } }; providers: Provider[]; prerequisites: { id: string; available: boolean; required: boolean }[]; settings: { onboardingCompleted: boolean; analyticsLevel: string; diagnosticReporting: string; executionProfile: string } }

export function DoctorControl() {
  const { webFetchJson } = useBackendApi();
  const doctor = useQuery({ queryKey: queryKeys.consoleDoctor(), queryFn: ({ signal }) => webFetchJson<DoctorResponse>("/api/console/doctor", { signal }) });
  return <div className="flex flex-col gap-10">
    <ControlCard title="Health">
      <QueryState pending={doctor.isPending} error={doctor.error} retry={doctor.refetch} />
      {doctor.data && (() => {
        const data = doctor.data;
        const providerProblems = data.providers.filter(provider => provider.configured && (!provider.diagnostics.valid || providerUnusable(provider)));
        const missing = data.prerequisites.filter(item => item.required && !item.available);
        const healthy = data.availability.apiRuntime.valid && data.runtime.nodeSupported && providerProblems.length === 0 && missing.length === 0;
        return <>
          {healthy ? <Feedback message={`All good · ${data.availability.apiRuntime.providerLabel} · v${data.version}`} /> : <>
            {!data.availability.apiRuntime.valid && <div className="space-y-2"><Feedback error={plainHealthError(data.availability.apiRuntime.error) ?? "No provider connected."} /><Link to="/connections" className="block text-sm underline">Connect a provider</Link></div>}
            {!data.runtime.nodeSupported && <Feedback error={`Node ${data.runtime.node} is not supported. Install Node 24+.`} />}
            {providerProblems.map(provider => <Feedback key={provider.id} error={`${provider.label}: ${providerUnusable(provider) ? (provider.health?.state === "rejected" ? `Key rejected. ${healthHint(provider)}.` : "Can't reach the provider.") : plainHealthError(provider.diagnostics.message ?? undefined) ?? "needs attention"}`} />)}
            {missing.length > 0 && <Feedback error={`Missing: ${missing.map(item => item.id).join(", ")}`} />}
          </>}
          <SubmitButton variant="outline" onClick={() => void doctor.refetch()} pending={doctor.isFetching}>{!doctor.isFetching && <RefreshCcw className="size-4" />}Check again</SubmitButton>
          <ControlDisclosure title={<>Details</>}><div className="mt-4 space-y-5">
            <Facts entries={[["Version", data.version], ["Runtime", `Node ${data.runtime.node.replace(/^v/, "")}`], ["Platform", `${data.runtime.platform} · ${data.runtime.arch}`], ["Other providers", [...data.availability.availableRuntimes].sort().map(sentence).join(", ") || "None"], ["Where helpers run", data.settings.executionProfile === "smolvm" ? "In a sandbox" : "On this computer"], ["Usage metrics", data.settings.analyticsLevel === "off" ? "Off" : "Shared"], ["Problem reports", ({ off: "Keep local", ask: "Ask before sending", automatic: "Send automatically" } as Record<string, string>)[data.settings.diagnosticReporting] ?? sentence(data.settings.diagnosticReporting)]]} />
            <Link to="/settings" className="block text-sm underline">Change sharing in Settings</Link>
            <ul className="divide-y divide-border-1">{data.providers.map(provider => <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 py-2"><p className="text-sm">{provider.label}</p><Badge variant="outline">{provider.configured && providerUnusable(provider) ? (provider.health?.state === "rejected" ? "Key rejected" : "Can't reach") : provider.diagnostics.valid ? "OK" : provider.configured ? "Needs attention" : "Not connected"}</Badge></li>)}</ul>
            <ul className="divide-y divide-border-1">{data.prerequisites.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-2"><p className="text-sm">{item.id}{item.required ? "" : " (optional)"}</p><Badge variant={item.available ? "secondary" : "outline"}>{item.available ? "Installed" : item.required ? "Missing" : "Not installed"}</Badge></li>)}</ul>
          </div></ControlDisclosure>
        </>;
      })()}
    </ControlCard>
    <DiagnosticReportControl />
  </div>;
}

export function ToolsControl({ sessionId }: { sessionId?: string }) {
  const { webFetchJson } = useBackendApi();
  const [filter, setFilter] = useState("");
  const [role, setRole] = useState("");
  const tools = useQuery({ queryKey: queryKeys.consoleTools(), queryFn: ({ signal }) => webFetchJson<{ roles: string[]; tools: { name: string; description: string; roles: string[] }[]; plugins: { name: string; description: string }[] }>("/api/console/tools", { signal }) });
  const snapshot = useQuery({ queryKey: queryKeys.consoleControlSession(sessionId), enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}?window=1&workers=summary`, { signal })).snapshot, refetchInterval: 3000 });
  // Windowed snapshots omit the catalog; it is fixed for the session, so fetch it once. Older servers still send it inline.
  const catalog = useQuery({ queryKey: queryKeys.consoleSessionTools(sessionId), enabled: !!sessionId && snapshot.data?.tools.length === 0, staleTime: Infinity, queryFn: async ({ signal }) => (await webFetchJson<{ tools: SessionSnapshot["tools"] }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}/tools`, { signal })).tools });
  const rows = tools.data?.tools.filter(tool => (!role || tool.roles.includes(role)) && `${tool.name} ${tool.description}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const sessionTools = snapshot.data?.tools.length ? snapshot.data.tools : catalog.data ?? [];
  const harness = snapshot.data?.harness;
  return <div className="flex flex-col gap-10">
    <ControlCard title={v("{Mission} tools")}>
      {sessionId ? <><QueryState pending={snapshot.isPending} error={snapshot.error} retry={snapshot.refetch} />{snapshot.data && (sessionTools.length ? <ControlDisclosure title={<>{sessionTools.length} tools loaded</>}><ul className="mt-2 divide-y divide-border-1">{sessionTools.map(tool => <li key={tool.name} className="space-y-2 py-3"><h3 className="font-medium text-sm">{tool.name}</h3><p className="text-xs leading-relaxed text-muted-foreground">{tool.description}</p><ControlDisclosure title={<>Input schema</>}><pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></ControlDisclosure></li>)}</ul></ControlDisclosure> : <Empty>No tools loaded yet.</Empty>)}</> : <Empty>{v("Open {a mission} to see its tools. ")}<Link to="/chats" className="underline">{v("Go to {missions}")}</Link>.</Empty>}
    </ControlCard>
    <ControlCard title="Tool setup">
      {harness ? <><p className="text-sm">{harness.label} · {harness.status}{harness.pendingGenerationId ? " · update pending" : ""}</p>{!harness.trusted && <Feedback error="This tool setup isn't trusted." />}{harness.error && <Feedback error={harness.error} />}<ControlDisclosure title={<>Details</>}><Facts entries={[["Version", harness.generationId ?? "Built-in"], ["Pending update", harness.pendingGenerationId ?? "None"]]} /><ul className="mt-3 space-y-2">{harness.providers.map(provider => <li key={provider.id} className="border-t border-border-1 pt-2 text-sm first:border-t-0 first:pt-0"><p className="font-medium">{provider.id}</p><p className="mt-1 text-xs text-muted-foreground">{provider.kind} · {provider.services.join(" · ")}</p></li>)}</ul><ControlDisclosure className="mt-3" title={<>Raw</>}><pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(harness, null, 2)}</pre></ControlDisclosure></ControlDisclosure>{sessionId && <Link to={`/chats/${encodeURIComponent(sessionId)}`} className="block text-sm underline">{v("Manage in this {mission}")}</Link>}</> : <Empty>{sessionId ? "Nothing reported yet." : v("Open {a mission} to see its tool setup.")}</Empty>}
    </ControlCard>
    <ControlCard title="All tools">
      <QueryState pending={tools.isPending} error={tools.error} retry={tools.refetch} />
      <div className="grid gap-4 sm:grid-cols-2"><TextField label="Find a tool" type="search" value={filter} onChange={event => setFilter(event.target.value)} /><Field label="Role"><Select aria-label="Role" value={role} onValueChange={setRole} options={[{ value: "", label: "All roles" }, ...(tools.data?.roles.map(value => ({ value, label: value })) ?? [])]} /></Field></div>
      {tools.data && rows.length === 0 && <Empty>No tools match these filters.</Empty>}
      <ul className="divide-y divide-border-1">{rows.map(tool => <li key={tool.name} className="space-y-1 py-3"><h3 className="font-medium text-sm">{tool.name}</h3><p className="text-xs leading-relaxed text-muted-foreground">{tool.description}</p></li>)}</ul>
    </ControlCard>
    {tools.data?.plugins.length ? <ControlCard title="Plugin tools"><ul className="space-y-3">{tools.data.plugins.map(tool => <li key={tool.name}><p className="font-medium text-sm">{tool.name}</p><p className="text-xs text-muted-foreground">{tool.description}</p></li>)}</ul></ControlCard> : null}
  </div>;
}
