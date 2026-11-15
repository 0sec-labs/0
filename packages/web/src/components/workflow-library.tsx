import { queryKeys } from "@/queries";
import { v } from "@/lib/vocabulary";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Copy, Cpu, FileCode, FileUp, Globe, KeyRound, LockKeyhole, Microscope, MoreHorizontal, Package, Play, Plus, Search, ShieldCheck, Trash2, Workflow, type LucideIcon } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowExecution, SecurityWorkflowInput } from "@0/engine/shared";
import { SECURITY_WORKFLOW_TEMPLATES, securityWorkflowStarters, type SecurityWorkflowStarterIcon, type SecurityWorkflowTemplate } from "@0/engine/shared";
import { parseSecurityWorkflowCode, isSecurityWorkflowOperation } from "@0/engine/shared";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/components/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { FormDialog } from "@/ui/components/confirm-dialog";
import type { WorkflowScheduleSummary } from "@/components/workflow-automation-control";
import { automationRows, filterAutomationRows, filterTemplates, relativeAge, runStatusTone, sortAutomationRows, type AutomationRow, type ScheduleSummary } from "@/components/automations/automation-model";
import { TeamPresenceAvatars } from "@/console/team-collaboration";
import { PageHeader } from "@/components/page-header";
import { EmptyState, LoadingState } from "@/components/state-panel";
import { StatusBadge } from "@/ui/components/status-badge";
import type { TeamPresence } from "@/lib/team-client";
import { errorText } from "@/lib/api-error";

const SEARCH_THRESHOLD = 8;
const STARTER_ICONS: Record<SecurityWorkflowStarterIcon, LucideIcon> = { "shield-search": ShieldCheck, microscope: Microscope, package: Package, "key-round": KeyRound, "file-code": FileCode, cpu: Cpu, globe: Globe, "lock-keyhole": LockKeyhole };
const STARTER_GROUPS = [{ id: "code", label: "Code" }, { id: "web", label: "Web" }] as const;
const starterChip = (item: SecurityWorkflowTemplate) => item.starter?.scope === "url" ? "Needs a URL" : "";

export function WorkflowLibrary({ readOnly = false, shared = false, presenceById = {}, definitions, busy, onSelect, onBlank, onTemplate, onImport, onRun, onDuplicate, onDelete }: {
  readOnly?: boolean; shared?: boolean; presenceById?: Record<string, TeamPresence[]>; definitions: SecurityWorkflow[]; busy: boolean;
  onSelect: (id: string) => void; onBlank: () => Promise<void>; onTemplate: (id: string) => Promise<void>;
  onImport: (definition: SecurityWorkflowInput) => Promise<void>;
  onRun: (workflow: SecurityWorkflow, trigger: HTMLButtonElement) => void; onDuplicate: (workflow: SecurityWorkflow) => void;
  onDelete: (workflow: SecurityWorkflow, trigger: HTMLButtonElement) => void;
}) {
  const { client, webFetchJson } = useBackendApi();
  const [routeSearch, setRouteSearch] = useSearchParams();
  const requestedTemplate = routeSearch.get("template");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "scheduled">("all");
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [importError, setImportError] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const schedules = useQuery({ queryKey: queryKeys.workflowTriggers("all"), queryFn: ({ signal }) => webFetchJson<{ triggers: WorkflowScheduleSummary[] }>("/api/console/workflow-triggers", { signal }), refetchInterval: 30_000 });
  const executions = useQuery({ queryKey: queryKeys.workflowExecutions(client.backendId, "all"), queryFn: ({ signal }) => webFetchJson<{ executions: SecurityWorkflowExecution[] }>("/api/console/workflow-executions", { signal }), refetchInterval: 30_000 });
  const templateStarted = useRef(false);
  useEffect(() => {
    if (templateStarted.current || routeSearch.get("owner") || readOnly || !SECURITY_WORKFLOW_TEMPLATES.some(item => item.id === requestedTemplate)) return;
    templateStarted.current = true;
    void onTemplate(requestedTemplate!).catch(() => setRouteSearch(previous => { const next = new URLSearchParams(previous); next.delete("template"); return next; }, { replace: true }));
  });
  const now = Date.now();
  const rows = useMemo(() => sortAutomationRows(automationRows(definitions, (schedules.data?.triggers ?? []) as ScheduleSummary[], executions.data?.executions ?? [])), [definitions, schedules.data, executions.data]);
  const visible = filterAutomationRows(rows, search).filter(item => scope === "all" || item.scheduled);
  const groups = [{ label: "Active", items: visible.filter(item => item.enabled) }, { label: "Disabled", items: visible.filter(item => !item.enabled) }].filter(group => group.items.length > 0);
  const byId = new Map(definitions.map(item => [item.id, item]));
  const starters = useMemo(() => securityWorkflowStarters(), []);
  const templates = filterTemplates(starters, search);
  const create = () => { void onBlank().catch(() => {}); };
  const navigateRows = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "j" && event.key !== "k") || event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-automation-row]") ?? [])];
    if (!buttons.length) return;
    const index = buttons.findIndex(button => button === document.activeElement || button.parentElement?.contains(document.activeElement));
    buttons[Math.max(0, Math.min(buttons.length - 1, index < 0 ? 0 : index + (event.key === "j" ? 1 : -1)))]?.focus();
    event.preventDefault();
  };
  const row = (item: AutomationRow) => {
    const workflow = byId.get(item.id)!;
    const canRun = Boolean(workflow.target.trim() && workflow.nodes.some(node => isSecurityWorkflowOperation(node) && node.enabled));
    return <li key={item.id} className="group/row flex h-11 min-w-0 items-center gap-2 rounded-[var(--radius-card,8px)] px-2 hover:bg-secondary has-[:focus-visible]:bg-secondary">
      <button type="button" data-automation-row disabled={busy} onClick={() => onSelect(item.id)} className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-card,8px)] text-left outline-none focus-visible:outline-ring-inset">
        <Workflow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-2"><span className="truncate text-sm">{item.name}</span><TeamPresenceAvatars compact presence={presenceById[item.id] ?? []} /></span>
        <span className="hidden w-44 shrink-0 items-center gap-1.5 truncate text-xs text-muted-foreground md:flex">{item.scheduled && <CalendarClock aria-hidden="true" className="size-3.5 shrink-0" />}<span className="truncate">{item.trigger}</span></span>
        <span className="hidden w-24 shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:flex" title={item.lastStatus ? `Last run ${item.lastStatus}` : undefined}>{runStatusTone(item.lastStatus) && <StatusBadge dot tone={runStatusTone(item.lastStatus)} appearance="outline" className="size-3 border-0 bg-transparent p-0"><span className="sr-only">{item.lastStatus}</span></StatusBadge>}{relativeAge(item.lastRunAt, now)}</span>
      </button>
      <DropdownMenu>
        <DropdownMenu.Trigger render={<Button ref={element => { if (element) menuTriggers.current.set(item.id, element); else menuTriggers.current.delete(item.id); }} variant="ghost" size="icon-sm" aria-label={`Actions for ${item.name}`} disabled={busy} className="text-muted-foreground" />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item icon={<Play aria-hidden="true" />} disabled={readOnly || !canRun} onClick={() => { const trigger = menuTriggers.current.get(item.id); if (trigger) onRun(workflow, trigger); }}>Run now</DropdownMenu.Item>
          <DropdownMenu.Item icon={<Copy aria-hidden="true" />} disabled={readOnly} onClick={() => onDuplicate(workflow)}>Duplicate</DropdownMenu.Item>
          <DropdownMenu.Item variant="danger" icon={<Trash2 aria-hidden="true" />} disabled={readOnly} onClick={() => { const trigger = menuTriggers.current.get(item.id); if (trigger) onDelete(workflow, trigger); }}>Delete</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </li>;
  };
  const empty = definitions.length === 0;
  const actions = empty ? undefined : <>
    {(rows.length >= SEARCH_THRESHOLD || search) && <div className="relative w-48"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search automations" placeholder="Search…" className="h-7 pl-8 text-sm" value={search} onChange={event => setSearch(event.target.value)} /></div>}
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More automation options" disabled={busy} />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end"><DropdownMenu.Item icon={<FileUp aria-hidden="true" />} disabled={readOnly} onClick={() => { setImportError(""); setImportOpen(true); }}>Import definition</DropdownMenu.Item></DropdownMenu.Content>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button size="sm" disabled={busy || readOnly} />}><Plus aria-hidden="true" />New automation</DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {STARTER_GROUPS.map(group => <DropdownMenu.Group key={group.id}><DropdownMenu.Label>{group.label}</DropdownMenu.Label>{starters.filter(item => item.starter?.group === group.id).map(item => { const Icon = STARTER_ICONS[item.starter!.icon]; return <DropdownMenu.Item key={item.id} icon={<Icon aria-hidden="true" />} onClick={() => { void onTemplate(item.id).catch(() => {}); }}>{item.name}</DropdownMenu.Item>; })}</DropdownMenu.Group>)}
        <DropdownMenu.Item icon={<Plus aria-hidden="true" />} onClick={create}>Blank automation</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  </>;
  return <div className="flex min-h-0 flex-col gap-4">
    <PageHeader title="Automations" summary={rows.length > 0 ? `${rows.length} ${rows.length === 1 ? "automation" : "automations"}` : undefined} actions={actions} />
    {empty && <EmptyState title="Automate security work" body="Run a review on a schedule or when code changes." action={readOnly ? undefined : <Button variant="secondary" size="sm" disabled={busy} onClick={create}><Plus aria-hidden="true" />Blank automation</Button>} />}
    {shared && <p className="pb-2 text-xs text-muted-foreground">Shared with your team</p>}
    {schedules.isError && <p role="alert" className="pb-2 text-xs text-destructive">Triggers unavailable: {schedules.error.message}</p>}
    {definitions.length > 0 && <>
      {executions.isPending && schedules.isPending && <LoadingState label="Loading automations…" rows={2} />}
      <Tabs value={scope} onValueChange={value => setScope(value as "all" | "scheduled")}><TabsList><TabsTrigger value="all">All automations</TabsTrigger><TabsTrigger value="scheduled">Scheduled</TabsTrigger></TabsList></Tabs>
      <div ref={list} onKeyDown={navigateRows} className="flex flex-col gap-3">
        {groups.map(group => <section key={group.label} aria-label={group.label} className="space-y-1"><h2 className="px-2 text-sm text-muted-foreground">{group.label} <span className="tabular-nums">{group.items.length}</span></h2><ul aria-label={`${group.label} automations`} className="flex flex-col">{group.items.map(row)}</ul></section>)}
      </div>
      {!visible.length && (scope === "scheduled" || search) && <p className="py-12 text-center text-sm text-muted-foreground">No matching automations.</p>}
    </>}
    {empty && templates.length > 0 && <section aria-label="Templates" className="space-y-4">
      <h2 className="px-2 text-sm text-muted-foreground">Templates</h2>
        <ul className="grid gap-2 md:grid-cols-2">
          {STARTER_GROUPS.flatMap(group => templates.filter(item => item.starter?.group === group.id)).map(item => { const Icon = STARTER_ICONS[item.starter!.icon]; return <li key={item.id} className="min-w-0"><button type="button" disabled={busy || readOnly} onClick={() => { void onTemplate(item.id).catch(() => {}); }} className="flex h-full w-full min-w-0 flex-col items-start gap-1.5 rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card p-3 text-left outline-none transition-colors hover:bg-secondary focus-visible:outline-ring-inset disabled:pointer-events-none disabled:opacity-55"><span className="flex w-full items-center gap-2 text-sm"><Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{item.name}</span></span><span className="truncate text-xs text-muted-foreground">{item.description}</span>{starterChip(item) && <StatusBadge appearance="outline">{starterChip(item)}</StatusBadge>}</button></li>; })}
        </ul>
    </section>}
    <FormDialog open={importOpen} onOpenChange={setImportOpen} pending={busy} cancelDisabled={busy || readOnly} className="sm:max-w-2xl" onSubmit={event => { event.preventDefault(); setImportError(""); try { const parsed = parseSecurityWorkflowCode(source); void onImport(parsed).then(() => { setImportOpen(false); setSource(""); }).catch(cause => setImportError(errorText(cause, "Unable to import definition."))); } catch (cause) { setImportError(errorText(cause, "Invalid automation definition.")); } }}
      title="Import definition"
      error={importError && <p role="alert" className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-destructive">{importError}</p>}
      submitDisabled={!source.trim()} submitLabel={busy ? "Importing…" : "Import automation"}>
      <Textarea aria-label="Workflow JSON to import" placeholder={'{ "schemaVersion": 1, "workflow": { … } }'} spellCheck={false} autoComplete="off" rows={12} className="max-h-[45dvh] min-h-64 resize-y font-mono text-xs leading-6" disabled={busy || readOnly} value={source} onChange={event => { setSource(event.target.value); setImportError(""); }} />
    </FormDialog>
  </div>;
}
