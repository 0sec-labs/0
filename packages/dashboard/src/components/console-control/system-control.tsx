import { ControlDisclosure } from "./control-disclosure";
import { DEFAULT_AUTONOMY_MODE } from "@0/shared/dist/desktop-console.js";
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

export const autonomyDescriptions: Record<string, string> = {
  standard: "Asks you before each action.",
  recon: "Read-only. Active and exploit tools are blocked.",
  copilot: "Doesn't ask per action. May add related targets; asks before new ones.",
  yolo: "Runs tools without per-action prompts. Can still ask for context or necessary decisions.",
};

function ReviewCheckRow({ item, busy, mutate }: { item: CheckItem; busy: boolean; mutate: (mutation: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(item.prompt);
  const [approved, setApproved] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => { setPrompt(item.prompt); setApproved(false); setEditing(false); }, [item.revision, item.prompt]);
  return <article className="space-y-3 rounded-md border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">{item.name}</h3>{item.enabled && item.approvedRevision !== item.revision && <p className="mt-1 text-xs text-destructive">Changed since approval</p>}</div><Badge variant={item.enabled ? "secondary" : "outline"}>{item.enabled ? "On" : "Off"}</Badge></div>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); mutate({ action: "set", id: item.id, prompt: prompt.trim(), approved, expectedRevision: item.revision }); }}><Field label="Check prompt"><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={2000} disabled={busy} /></Field>{item.enabled && <Check checked={approved} onChange={setApproved}>I approve this new prompt.</Check>}<div className="flex gap-2"><SubmitButton pending={busy} type="submit" disabled={!prompt.trim() || (item.enabled && !approved)}>Save</SubmitButton><Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(false); setPrompt(item.prompt); setApproved(false); }}>Cancel</Button></div></form> : <><p className="whitespace-pre-wrap text-sm leading-relaxed">{item.prompt}</p>{!item.enabled && <Check checked={approved} onChange={setApproved} disabled={busy}>I approve this prompt.</Check>}<div className="flex flex-wrap gap-2">{item.enabled ? <Button size="sm" variant="outline" disabled={busy} onClick={() => mutate({ action: "disable", id: item.id })}>Disable</Button> : <Button size="sm" disabled={busy || !approved} onClick={() => mutate({ action: "enable", id: item.id, approved: true, expectedRevision: item.revision })}>Turn on</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(true); setApproved(false); }}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button></div></>}
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
  const [mode, setMode] = useState<string>(DEFAULT_AUTONOMY_MODE);
  const [autonomyApproved, setAutonomyApproved] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [approveNew, setApproveNew] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inScope, setInScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [scopeApproved, setScopeApproved] = useState(false);
  const project = useQuery({ queryKey: ["console-project", inspected], queryFn: ({ signal }) => webFetchJson<ProjectResponse>(`/api/console/project?path=${encodeURIComponent(inspected)}`, { signal }) });
  const checks = useQuery({ queryKey: ["console-checks", project.data?.path], enabled: !!project.data, queryFn: ({ signal }) => webFetchJson<ChecksResponse>(`/api/console/checks?path=${encodeURIComponent(project.data!.path)}`, { signal }) });
  const snapshot = useQuery({ queryKey: ["console-control-session", sessionId], enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal })).snapshot });
  useEffect(() => { if (snapshot.data) { setTarget(snapshot.data.session.target); setMode(snapshot.data.session.autonomyMode); setInScope(snapshot.data.scope?.in_scope?.join("\n") ?? ""); setOutOfScope(snapshot.data.scope?.out_of_scope?.join("\n") ?? ""); } }, [snapshot.data?.session.id]);
  const configuration = useMutation({ mutationFn: async () => {
    if (["copilot", "yolo"].includes(mode) && !autonomyApproved) throw new Error("Confirm the autonomy mode first.");
    if (!scopeApproved) throw new Error("Review and approve the scope first.");
    const owner = sessionId ?? (await webFetchJson<{ session: SessionSummary }>("/api/console/sessions", jsonBody({ target: target.trim(), autonomyMode: mode }))).session.id;
    return (await webFetchJson<{ session: SessionSummary }>(`/api/console/sessions/${encodeURIComponent(owner)}/configuration`, { method: "PATCH", body: JSON.stringify({ target: target.trim(), autonomyMode: mode, scope: { in_scope: inScope.split("\n").map(rule => rule.trim()).filter(Boolean), out_of_scope: outOfScope.split("\n").map(rule => rule.trim()).filter(Boolean) } }) })).session;
  }, onSuccess: async session => { setMessage(session.pendingConfiguration ? "Saved. Takes effect after the current step." : "Saved."); await queryClient.invalidateQueries({ queryKey: ["console-control-session"] }); if (onApplied) onApplied(session); else if (!sessionId) { const params = new URLSearchParams(location.search); params.set("session", session.id); params.set("return", `/console/${session.id}`); navigate(`${location.pathname}?${params}`, { replace: true }); } } });
  const changeCheck = useMutation({ mutationFn: (mutation: Record<string, unknown>) => webFetchJson<ChecksResponse>("/api/console/checks", jsonBody({ path: project.data!.path, mutation })), onSuccess: result => { queryClient.setQueryData(["console-checks", project.data!.path], result); setName(""); setPrompt(""); setApproveNew(false); setMessage("Checks updated."); } });
  return <div className="space-y-5"><ControlCard title="Project"><form className="flex flex-col items-end gap-3 sm:flex-row" onSubmit={event => { event.preventDefault(); setInspected(path.trim()); }}><div className="w-full"><TextField label="Project folder" value={path} onChange={event => setPath(event.target.value)} placeholder="/path/to/project" /></div><SubmitButton type="submit" pending={project.isFetching}>Open</SubmitButton></form><QueryState pending={project.isPending} error={project.error} retry={project.refetch} />{project.data && <><Facts entries={[["Project", <span title={project.data.path}>{project.data.name}</span>], ["Branch", project.data.git.branch ?? "Not a Git repo"], ["Changes", project.data.git.dirty ? "Uncommitted changes" : "Clean"]]} />{project.data.git.error && <Feedback error={project.data.git.error} />}<Button variant="outline" onClick={() => setTarget(`source:${project.data!.path}`)}>Use as target</Button></>}</ControlCard>
    <ControlCard title="Scope & autonomy">
      <QueryState pending={!!sessionId && snapshot.isPending} error={snapshot.error} retry={snapshot.refetch} />
      {snapshot.data && !snapshot.data.scopeEnforcement.enabled && <Feedback error={snapshot.data.scopeEnforcement.message || "Scope checks are off."} />}
      {snapshot.data?.localScopePath && <p className="text-xs text-muted-foreground">Allowed folder: <span className="break-all">{snapshot.data.localScopePath}</span></p>}
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); configuration.mutate(); }}>
        <TextField label="Target (optional)" value={target} onChange={event => { setTarget(event.target.value); setScopeApproved(false); }} maxLength={4096} placeholder="https://example.com or source:/path/to/project" />
        <ControlDisclosure key={snapshot.data?.session.id ?? "new"} open={!!(snapshot.data?.scope?.in_scope?.length || snapshot.data?.scope?.out_of_scope?.length) || undefined} title={<>Scope rules</>}><div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="In scope" hint="One per line."><Textarea rows={4} value={inScope} onChange={event => { setInScope(event.target.value); setScopeApproved(false); }} /></Field>
          <Field label="Out of scope" hint="One per line."><Textarea rows={4} value={outOfScope} onChange={event => { setOutOfScope(event.target.value); setScopeApproved(false); }} /></Field>
        </div></ControlDisclosure>
        <Field label="Autonomy mode" hint={autonomyDescriptions[mode]}><Select aria-label="Autonomy mode" value={mode} onValueChange={value => { setMode(value); setAutonomyApproved(false); }} options={Object.keys(autonomyDescriptions).map(value => ({ value, label: value === "copilot" ? "Auto" : value === "yolo" ? "YOLO" : value === "recon" ? "Read-only" : "Ask each action" }))} /></Field>
        {["copilot", "yolo"].includes(mode) && <Check checked={autonomyApproved} onChange={setAutonomyApproved}>I understand this mode won't ask before each action.</Check>}
        <Check checked={scopeApproved} onChange={setScopeApproved}>I reviewed this target and scope.</Check>
        <div className="flex flex-wrap gap-2"><SubmitButton type="submit" pending={configuration.isPending} disabled={!scopeApproved || (["copilot", "yolo"].includes(mode) && !autonomyApproved)}>{sessionId ? "Save" : "Start"}</SubmitButton><Button type="button" variant="outline" onClick={() => { setTarget(snapshot.data?.session.target ?? ""); setMode(snapshot.data?.session.autonomyMode ?? DEFAULT_AUTONOMY_MODE); setInScope(snapshot.data?.scope?.in_scope?.join("\n") ?? ""); setOutOfScope(snapshot.data?.scope?.out_of_scope?.join("\n") ?? ""); setScopeApproved(false); setAutonomyApproved(false); configuration.reset(); }}>Reset</Button></div>
      </form><Feedback error={configuration.error} message={message} />
    </ControlCard>
    {project.data && <ControlCard title="Review checks"><QueryState pending={checks.isPending} error={checks.error} retry={checks.refetch} />{checks.data?.checks.length === 0 && <Empty>No checks yet.</Empty>}{checks.data?.checks.map(item => <ReviewCheckRow key={item.id} item={item} busy={changeCheck.isPending} mutate={mutation => changeCheck.mutate(mutation)} />)}<ControlDisclosure className="border-t border-border pt-4" open={checks.data?.checks.length === 0 || undefined} title={<>Add a check</>}><form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); changeCheck.mutate({ action: approveNew ? "add" : "propose", name: name.trim(), prompt: prompt.trim(), ...(approveNew ? { approved: true } : {}) }); }}><TextField label="New check name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} /><Field label="What to check"><Textarea value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={2000} rows={4} /></Field><Check checked={approveNew} onChange={setApproveNew}>Turn on now (otherwise saved as a draft).</Check><SubmitButton type="submit" pending={changeCheck.isPending} disabled={!name.trim() || !prompt.trim()}>{approveNew ? "Add check" : "Save draft"}</SubmitButton></form></ControlDisclosure><Feedback error={changeCheck.error} /></ControlCard>}
  </div>;
}

interface DoctorResponse { version: string; runtime: { node: string; nodeSupported: boolean; platform: string; arch: string; engine: string; engineVersion: string; releaseChannel: string }; availability: { hasApiKey: boolean; availableRuntimes: string[]; apiRuntime: { configured: boolean; valid: boolean; providerLabel: string; error?: string } }; providers: Provider[]; prerequisites: { id: string; available: boolean; required: boolean }[]; settings: { onboardingCompleted: boolean; analyticsLevel: string; diagnosticReporting: string; executionProfile: string } }

export function DoctorControl() {
  const { webFetchJson } = useBackendApi();
  const doctor = useQuery({ queryKey: ["console-doctor"], queryFn: ({ signal }) => webFetchJson<DoctorResponse>("/api/console/doctor", { signal }) });
  return <div className="space-y-5">
    <ControlCard title="Health">
      <QueryState pending={doctor.isPending} error={doctor.error} retry={doctor.refetch} />
      {doctor.data && (() => {
        const data = doctor.data;
        const providerProblems = data.providers.filter(provider => provider.configured && !provider.diagnostics.valid);
        const missing = data.prerequisites.filter(item => item.required && !item.available);
        const healthy = data.availability.apiRuntime.valid && data.runtime.nodeSupported && providerProblems.length === 0 && missing.length === 0;
        return <>
          {healthy ? <Feedback message={`All good · ${data.availability.apiRuntime.providerLabel} · v${data.version}`} /> : <>
            {!data.availability.apiRuntime.valid && <div className="space-y-2"><Feedback error={data.availability.apiRuntime.error ?? "No provider connected."} /><Link to="/connections" className="block text-sm underline">Connect a provider</Link></div>}
            {!data.runtime.nodeSupported && <Feedback error={`Node ${data.runtime.node} is not supported. Install Node 24+.`} />}
            {providerProblems.map(provider => <Feedback key={provider.id} error={`${provider.label}: ${provider.diagnostics.message ?? "needs attention"}`} />)}
            {missing.length > 0 && <Feedback error={`Missing: ${missing.map(item => item.id).join(", ")}`} />}
          </>}
          <Button variant="outline" onClick={() => void doctor.refetch()} disabled={doctor.isFetching}><RefreshCcw className="size-4" />Check again</Button>
          <ControlDisclosure title={<>Details</>}><div className="mt-4 space-y-5">
            <Facts entries={[["Version", data.version], ["Engine", `${data.runtime.engine} ${data.runtime.engineVersion}`], ["Node", data.runtime.node], ["Platform", `${data.runtime.platform} · ${data.runtime.arch}`], ["Other providers", data.availability.availableRuntimes.join(", ") || "None"], ["Execution profile", data.settings.executionProfile], ["Release channel", data.runtime.releaseChannel], ["Usage sharing", data.settings.analyticsLevel], ["Problem reporting", data.settings.diagnosticReporting]]} />
            <Link to="/settings" className="block text-sm underline">Change sharing in Settings</Link>
            <ul className="divide-y divide-border">{data.providers.map(provider => <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 py-2"><p className="text-sm">{provider.label}</p><Badge variant="outline">{provider.diagnostics.valid ? "OK" : provider.configured ? "Needs attention" : "Not connected"}</Badge></li>)}</ul>
            <ul className="divide-y divide-border">{data.prerequisites.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-2"><p className="text-sm">{item.id}{item.required ? "" : " (optional)"}</p><Badge variant={item.available ? "secondary" : "outline"}>{item.available ? "Installed" : item.required ? "Missing" : "Not installed"}</Badge></li>)}</ul>
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
  const tools = useQuery({ queryKey: ["console-tools"], queryFn: ({ signal }) => webFetchJson<{ roles: string[]; tools: { name: string; description: string; roles: string[] }[]; plugins: { name: string; description: string }[] }>("/api/console/tools", { signal }) });
  const snapshot = useQuery({ queryKey: ["console-control-session", sessionId], enabled: !!sessionId, queryFn: async ({ signal }) => (await webFetchJson<{ snapshot: SessionSnapshot }>(`/api/console/sessions/${encodeURIComponent(sessionId!)}`, { signal })).snapshot, refetchInterval: 3000 });
  const rows = tools.data?.tools.filter(tool => (!role || tool.roles.includes(role)) && `${tool.name} ${tool.description}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const harness = snapshot.data?.harness;
  return <div className="space-y-5">
    <ControlCard title="Session tools">
      {sessionId ? <><QueryState pending={snapshot.isPending} error={snapshot.error} retry={snapshot.refetch} />{snapshot.data && (snapshot.data.tools.length ? <ControlDisclosure title={<>{snapshot.data.tools.length} tools loaded</>}><ul className="mt-2 divide-y divide-border">{snapshot.data.tools.map(tool => <li key={tool.name} className="space-y-2 py-3"><h3 className="font-medium text-sm">{tool.name}</h3><p className="text-xs leading-relaxed text-muted-foreground">{tool.description}</p><ControlDisclosure title={<>Input schema</>}><pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></ControlDisclosure></li>)}</ul></ControlDisclosure> : <Empty>No tools loaded yet.</Empty>)}</> : <Empty>Open a session to see its tools. <Link to="/console" className="underline">Go to chat</Link>.</Empty>}
    </ControlCard>
    <ControlCard title="Tool setup">
      {harness ? <><p className="text-sm">{harness.label} · {harness.status}{harness.pendingGenerationId ? " · update pending" : ""}</p>{!harness.trusted && <Feedback error="This tool setup isn't trusted." />}{harness.error && <Feedback error={harness.error} />}<ControlDisclosure title={<>Details</>}><Facts entries={[["Version", harness.generationId ?? "Built-in"], ["Pending update", harness.pendingGenerationId ?? "None"]]} /><ul className="mt-3 space-y-2">{harness.providers.map(provider => <li key={provider.id} className="rounded-md border border-border p-3 text-sm"><p className="font-medium">{provider.id}</p><p className="mt-1 text-xs text-muted-foreground">{provider.kind} · {provider.services.join(" · ")}</p></li>)}</ul><ControlDisclosure className="mt-3" title={<>Raw</>}><pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/20 p-3 text-xs">{JSON.stringify(harness, null, 2)}</pre></ControlDisclosure></ControlDisclosure>{sessionId && <Link to={`/console/${encodeURIComponent(sessionId)}`} className="block text-sm underline">Manage in chat</Link>}</> : <Empty>{sessionId ? "Nothing reported yet." : "Open a session to see its tool setup."}</Empty>}
    </ControlCard>
    <ControlCard title="All tools">
      <QueryState pending={tools.isPending} error={tools.error} retry={tools.refetch} />
      <div className="grid gap-4 sm:grid-cols-2"><TextField label="Find a tool" type="search" value={filter} onChange={event => setFilter(event.target.value)} /><Field label="Role"><Select aria-label="Role" value={role} onValueChange={setRole} options={[{ value: "", label: "All roles" }, ...(tools.data?.roles.map(value => ({ value, label: value === "copilot" ? "Auto" : value === "yolo" ? "YOLO" : value === "recon" ? "Read-only" : "Ask each action" })) ?? [])]} /></Field></div>
      {tools.data && rows.length === 0 && <Empty>No tools match these filters.</Empty>}
      <ul className="divide-y divide-border">{rows.map(tool => <li key={tool.name} className="space-y-1 py-3"><h3 className="font-medium text-sm">{tool.name}</h3><p className="text-xs leading-relaxed text-muted-foreground">{tool.description}</p></li>)}</ul>
    </ControlCard>
    {tools.data?.plugins.length ? <ControlCard title="Plugin tools"><ul className="space-y-3">{tools.data.plugins.map(tool => <li key={tool.name}><p className="font-medium text-sm">{tool.name}</p><p className="text-xs text-muted-foreground">{tool.description}</p></li>)}</ul></ControlCard> : null}
  </div>;
}
