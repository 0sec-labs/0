import { v } from "@/lib/vocabulary";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Copy, FileUp, MoreHorizontal, Play, Plus, Search, Trash2, Workflow } from "lucide-react";
import type { SecurityWorkflow, SecurityWorkflowExecution, SecurityWorkflowInput } from "@0/engine/shared";
import { SECURITY_WORKFLOW_TEMPLATES } from "@0/engine/dist/shared/security-workflow-templates.js";
import { parseSecurityWorkflowCode, isSecurityWorkflowOperation } from "@0/engine/dist/shared/security-workflows.js";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WorkflowScheduleSummary } from "@/components/workflow-automation-control";
import { NewAutomationDialog } from "@/components/automations/new-automation-dialog";
import { automationRows, filterAutomationRows, relativeAge, sortAutomationRows, type AutomationRow, type ScheduleSummary } from "@/components/automations/automation-model";
import { TeamPresenceAvatars } from "@/console/team-collaboration";
import { LoadingState } from "@/components/state-panel";
import type { TeamPresence } from "@/lib/team-client";

const SEARCH_THRESHOLD = 8;

export function WorkflowLibrary({ readOnly = false, shared = false, presenceById = {}, definitions, busy, onSelect, onBlank, onTemplate, onPrompt, onImport, onDescribe, onRun, onDuplicate, onDelete }: {
  readOnly?: boolean; shared?: boolean; presenceById?: Record<string, TeamPresence[]>; definitions: SecurityWorkflow[]; busy: boolean;
  onSelect: (id: string) => void; onBlank: () => Promise<void>; onTemplate: (id: string) => Promise<void>; onPrompt: (prompt: string) => Promise<void>;
  onImport: (definition: SecurityWorkflowInput) => Promise<void>; onDescribe: (text: string) => void;
  onRun: (workflow: SecurityWorkflow, trigger: HTMLButtonElement) => void; onDuplicate: (workflow: SecurityWorkflow) => void;
  onDelete: (workflow: SecurityWorkflow, trigger: HTMLButtonElement) => void;
}) {
  const { client, webFetchJson } = useBackendApi();
  const [routeSearch, setRouteSearch] = useSearchParams();
  const requestedTemplate = routeSearch.get("template");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [importError, setImportError] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const schedules = useQuery({ queryKey: ["workflow-triggers", "all"], queryFn: ({ signal }) => webFetchJson<{ triggers: WorkflowScheduleSummary[] }>("/api/console/workflow-triggers", { signal }), refetchInterval: 5000 });
  const executions = useQuery({ queryKey: ["workflow-executions", client.backendId, "all"], queryFn: ({ signal }) => webFetchJson<{ executions: SecurityWorkflowExecution[] }>("/api/console/workflow-executions", { signal }), refetchInterval: 10_000 });
  useEffect(() => {
    if (!routeSearch.get("owner") && SECURITY_WORKFLOW_TEMPLATES.some(item => item.id === requestedTemplate)) setCreateOpen(true);
  }, [requestedTemplate, routeSearch]);
  const now = Date.now();
  const rows = useMemo(() => sortAutomationRows(automationRows(definitions, (schedules.data?.triggers ?? []) as ScheduleSummary[], executions.data?.executions ?? [])), [definitions, schedules.data, executions.data]);
  const visible = filterAutomationRows(rows, search);
  const byId = new Map(definitions.map(item => [item.id, item]));
  const closeCreate = (open: boolean) => {
    setCreateOpen(open);
    if (!open && requestedTemplate) setRouteSearch(previous => { const next = new URLSearchParams(previous); next.delete("template"); return next; }, { replace: true });
  };
  const navigateRows = (event: KeyboardEvent<HTMLUListElement>) => {
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
        <span className="hidden w-20 shrink-0 text-xs text-muted-foreground tabular-nums sm:block" title={item.lastStatus ? `Last run ${item.lastStatus}` : undefined}>{relativeAge(item.lastRunAt, now)}</span>
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
  return <div className="flex min-h-0 flex-col">
    <header className="flex h-11 shrink-0 items-center gap-3">
      <h1 className="flex items-baseline gap-2 text-base font-medium"><span>Automations</span>{rows.length > 0 && <span className="text-xs font-normal text-muted-foreground tabular-nums" aria-label={`${rows.length} automations`}>{rows.length}</span>}</h1>
      <div className="ml-auto flex items-center gap-1.5">
        {rows.length >= SEARCH_THRESHOLD && <div className="relative w-48"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search automations" placeholder="Search…" className="h-7 pl-8 text-sm" value={search} onChange={event => setSearch(event.target.value)} /></div>}
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More automation options" disabled={busy} />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end"><DropdownMenu.Item icon={<FileUp aria-hidden="true" />} disabled={readOnly} onClick={() => { setImportError(""); setImportOpen(true); }}>Import definition</DropdownMenu.Item></DropdownMenu.Content>
        </DropdownMenu>
        {definitions.length > 0 && <Button variant="secondary" size="sm" disabled={busy || readOnly} onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />New automation</Button>}
      </div>
    </header>
    {shared && <p className="pb-2 text-xs text-muted-foreground">Shared with your workspace</p>}
    {schedules.isError && <p role="alert" className="pb-2 text-xs text-destructive">Triggers unavailable: {schedules.error.message}</p>}
    {!definitions.length ? <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-24 text-center">
      <p className="text-sm text-muted-foreground">{v("Automations start a new {mission} when a trigger fires.")}</p>
      <Button variant="secondary" disabled={busy || readOnly} onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />New automation</Button>
    </div> : <>
      {executions.isPending && schedules.isPending && <LoadingState label="Loading automations…" rows={2} />}
      <ul ref={list} aria-label="Automations" onKeyDown={navigateRows} className="scroll-fade-y flex flex-col overflow-y-auto">
        {visible.map(row)}
      </ul>
      {!visible.length && <p className="py-12 text-center text-sm text-muted-foreground">No matching automations.</p>}
    </>}
    <NewAutomationDialog open={createOpen} onOpenChange={closeCreate} busy={busy} readOnly={readOnly} initialStep={SECURITY_WORKFLOW_TEMPLATES.some(item => item.id === requestedTemplate) ? "template" : "choose"} onBlank={onBlank} onTemplate={onTemplate} onPrompt={onPrompt} onDescribe={onDescribe} />
    <Dialog open={importOpen} onOpenChange={open => { if (!busy) setImportOpen(open); }}><DialogContent showCloseButton={!busy} className="sm:max-w-2xl"><form className="space-y-4" onSubmit={event => { event.preventDefault(); setImportError(""); try { const parsed = parseSecurityWorkflowCode(source); void onImport(parsed).then(() => { setImportOpen(false); setSource(""); }).catch(cause => setImportError(cause instanceof Error ? cause.message : "Unable to import definition.")); } catch (cause) { setImportError(cause instanceof Error ? cause.message : "Invalid automation definition."); } }}><DialogHeader><DialogTitle>Import definition</DialogTitle><DialogDescription>Paste automation JSON. Importing creates a new automation without running it.</DialogDescription></DialogHeader><Textarea aria-label="Workflow JSON to import" placeholder={'{ "schemaVersion": 1, "workflow": { … } }'} spellCheck={false} autoComplete="off" rows={12} className="max-h-[45dvh] min-h-64 resize-y font-mono text-xs leading-6" disabled={busy || readOnly} value={source} onChange={event => { setSource(event.target.value); setImportError(""); }} />{importError && <p role="alert" className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-destructive">{importError}</p>}<DialogFooter><Button type="button" variant="ghost" disabled={busy || readOnly} onClick={() => setImportOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !source.trim()}>{busy ? "Importing…" : "Import automation"}</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
