import { useMemo, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { useModelCatalog } from "@/console/use-model-catalog";
import { arrangeCatalog, isModelEnabled, providerLabel } from "@/components/model-picker";
import { ListChecks, Save, Trash2 } from "lucide-react";
import { CapyChevronRightIcon as ChevronRight, CapyCopyIcon as Copy, CapyMoreIcon as MoreHorizontal, CapyPlayIcon as Play, CapyPlusIcon as Plus } from "@/ui/icons/capy";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
import { parseSecurityWorkflowInput } from "@0/engine/dist/shared/security-workflows.js";
import { Link } from "react-router-dom";
import { v } from "@/lib/vocabulary";
import { Select } from "@/components/ui/select";
import { useSentinel } from "@/sentinels/api";
import { sentinelHref } from "@/sentinels/model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { SettingsCard, SettingsCardRow } from "../../ui/components/settings-card";
import { AutomationActiveSwitch } from "@/components/workflow-automation-control";
import { WorkflowTriggers } from "@/components/workflow-triggers";
import { WorkflowRuns } from "@/components/workflow-runs";
import { WorkflowGraph } from "@/components/workflow-graph";
import { WorkflowChat } from "@/components/workflow-chat";
import { WorkflowDefinitionEditor, advanceWorkflowDraftBase, workflowDraftHasConflict } from "@/components/workflow-definition-editor";
import { workflowInput } from "@/components/workflow-editing";
import { LearningPanel, WorkflowVersions } from "@/components/learning-panel";
import { CollapsibleSection, FormSection } from "./automation-ui";
import { AUTOMATION_REASONING_OPTIONS, automationModelChoice, automationModelOptions, decodeAutomationModel, encodeAutomationModel, knownProjects, validateAutomationDraft } from "./automation-model";
import { errorText } from "@/lib/api-error";

const OTHER_PROJECT = "\u0000other";

/** Capy's single long form: header, settings, triggers, instructions, runs, then collapsible depth. */
export function AutomationForm({ workflow, readOnly, busy, computerName, teamCollaboration, runButtonRef, menuButtonRef, linear, nodeId, error, onBack, onSave, onRun, onDuplicate, onDelete, onSelectStep, onAddStep, onRestore, onAction }: {
  workflow: SecurityWorkflow; readOnly: boolean; busy: boolean; computerName: string; teamCollaboration?: React.ReactNode;
  runButtonRef: Ref<HTMLButtonElement>; menuButtonRef: Ref<HTMLButtonElement>; linear: boolean; nodeId: string | null; error?: string;
  onBack: () => void; onSave: (input: SecurityWorkflowInput) => Promise<void>; onRun: () => void; onDuplicate: () => void; onDelete: () => void;
  onSelectStep: (id: string) => void; onAddStep: () => void; onRestore: (revision: number) => Promise<void>; onAction: (action: () => Promise<void>) => Promise<void>;
}) {
  const [base, setBase] = useState(() => structuredClone(workflow));
  const [name, setName] = useState(workflow.name);
  const [target, setTarget] = useState(workflow.target);
  const [instructions, setInstructions] = useState(workflow.instructions);
  const [saveError, setSaveError] = useState("");
  const [activeHint, setActiveHint] = useState(false);
  const [runIn, setRunIn] = useState(workflow.runIn ?? "new-mission");
  const [modelValue, setModelValue] = useState(encodeAutomationModel(workflow.model));
  const [reasoning, setReasoning] = useState(workflow.model?.reasoning ?? "");
  const [otherProject, setOtherProject] = useState(false);
  const { webFetchJson, listConsoleSessions, client } = useBackendApi();
  const sessions = useQuery({ queryKey: queryKeys.consoleSessions(), queryFn: ({ signal }) => listConsoleSessions(signal), staleTime: 15_000 });
  const catalog = useModelCatalog({ backendId: client.backendId, webFetchJson });
  const modelRows = useMemo(() => arrangeCatalog({ models: (catalog.data?.models ?? []).filter(isModelEnabled), diagnostics: catalog.data?.diagnostics ?? [] }).groups
    .flatMap(group => group.models.map(row => ({ value: encodeAutomationModel({ providerId: row.provider, model: row.id }), label: `${providerLabel(row.provider)} / ${row.id}` }))), [catalog.data]);
  const projects = useMemo(() => knownProjects((sessions.data ?? []).map(item => item.target), workflow.target), [sessions.data, workflow.target]);
  const modelChoice = automationModelChoice(modelValue, reasoning, workflow.model);
  const sameModel = JSON.stringify(modelChoice) === JSON.stringify(base.model ?? null);
  const owner = useSentinel(workflow.ownerSentinelId ?? "");
  const ownerId = workflow.ownerSentinelId ?? null;
  const changed = name !== base.name || target !== base.target || instructions !== base.instructions || (ownerId !== null && runIn !== (base.runIn ?? "new-mission")) || !sameModel;
  const conflict = workflowDraftHasConflict(base, workflow);
  const locked = busy || readOnly;
  const enabledAudits = workflow.nodes.filter(node => node.type !== "trigger" && node.type !== "report" && node.enabled);
  const canRun = Boolean(workflow.target.trim() && enabledAudits.length);
  const problems = validateAutomationDraft({ name });
  const reload = () => { setBase(structuredClone(workflow)); setName(workflow.name); setTarget(workflow.target); setInstructions(workflow.instructions); setRunIn(workflow.runIn ?? "new-mission"); setModelValue(encodeAutomationModel(workflow.model)); setReasoning(workflow.model?.reasoning ?? ""); setSaveError(""); };
  const save = () => {
    setSaveError("");
    if (problems.name) return;
    try {
      const input = parseSecurityWorkflowInput({ ...workflowInput(base), name, target, instructions, ...(ownerId ? { runIn } : {}), model: modelChoice });
      void onSave(input).then(() => setBase(advanceWorkflowDraftBase(base, input))).catch(cause => setSaveError(errorText(cause, "Unable to save.")));
    } catch (cause) { setSaveError(errorText(cause, "Invalid automation.")); }
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return <div className="mx-auto w-full max-w-[940px]">
    <header className="sticky top-0 z-10 -mx-1 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 bg-panel px-1 py-1">
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {teamCollaboration}
        <Button type="button" variant="ghost" size="sm" className="max-sm:hidden" onClick={() => jump("workflow-runs")}><ListChecks aria-hidden="true" />View runs</Button>
        <Button type="button" variant="outline" size="sm" disabled={locked || !changed || Boolean(problems.name)} onClick={save}><Save aria-hidden="true" />{changed ? "Save" : "Saved"}</Button>
        <Tooltip content={canRun || locked ? "Run now" : workflow.target.trim() ? "Turn on at least one step to run" : "Set a project to run"}><span className="inline-flex"><Button ref={runButtonRef} type="button" size="sm" disabled={locked || !canRun} onClick={onRun}><Play aria-hidden="true" />Run</Button></span></Tooltip>
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button ref={menuButtonRef} type="button" variant="ghost" size="icon-sm" aria-label="More automation settings" disabled={busy} />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item icon={<Play aria-hidden="true" />} disabled={locked || !canRun} onClick={onRun}>Run now</DropdownMenu.Item>
            <DropdownMenu.Item icon={<Copy aria-hidden="true" />} disabled={locked} onClick={onDuplicate}>Duplicate</DropdownMenu.Item>
            <DropdownMenu.Item variant="danger" icon={<Trash2 aria-hidden="true" />} disabled={locked} onClick={onDelete}>Delete</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </header>
    <div className="space-y-8 pb-24 pt-4">
      {(error || saveError) && <p role="alert" className="text-sm text-destructive">{saveError || error}</p>}
      {conflict && <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Automation changed. Your draft is kept.</span><Button type="button" size="xs" variant="outline" disabled={busy} onClick={reload}>Reload latest</Button></div>}
      <div className="space-y-2">
        <Input aria-label="Automation name" value={name} maxLength={160} required disabled={locked} placeholder="Automation name" onChange={event => setName(event.target.value)} className="h-9 border-transparent bg-transparent px-0 text-xl font-medium shadow-none focus-visible:border-border-2 md:text-xl" />
        {problems.name && <p role="alert" className="text-xs text-destructive">{problems.name}</p>}
        <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">Active<AutomationActiveSwitch workflow={workflow} disabled={locked} onNeedsSetup={() => { setActiveHint(true); jump("workflow-triggers"); }} className="flex items-center" /></label>
        {activeHint && <p role="status" className="text-xs text-muted-foreground">{workflow.target.trim() ? "Add and review a schedule under Triggers to turn this on." : "Set a target and add a schedule under Triggers to turn this on."}</p>}
      </div>

      <SettingsCard className="mx-0">
        <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Project</p><p className="text-xs text-muted-foreground">{v("Each run starts a new {mission} against this target")}</p></div>
          <div className="flex w-72 max-w-[50%] shrink-0 flex-col gap-2">
            <Select aria-label="Project" size="sm" value={otherProject ? OTHER_PROJECT : target} disabled={locked} placeholder="Choose a project"
              onValueChange={value => { if (value === OTHER_PROJECT) setOtherProject(true); else { setOtherProject(false); setTarget(value); } }}
              options={[...projects.map(item => ({ value: item, label: item })), { value: OTHER_PROJECT, label: "Other" }]} />
            {(otherProject || (!projects.length && !target)) && <Input aria-label="Target" value={target} maxLength={4096} disabled={locked} placeholder="Repository path, package, or website" onChange={event => setTarget(event.target.value)} className="h-7 text-[13px]" />}
          </div>
        </SettingsCardRow>
        {ownerId && <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Owner</p><p className="text-xs text-muted-foreground">{v("Shares this {sentinel}'s budget and memory")}</p></div>
          <Link to={sentinelHref(ownerId)} className="min-w-0 truncate text-sm underline-offset-2 hover:underline">{owner.data?.name ?? "Sentinel"}</Link>
        </SettingsCardRow>}
        {ownerId && <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Runs in</p><p className="text-xs text-muted-foreground">Where each run lives</p></div>
          <Select aria-label="Runs in" size="sm" className="w-44 shrink-0" value={runIn} disabled={locked} onValueChange={setRunIn} options={[{ value: "new-mission", label: v("A new {mission}") }, { value: "sentinel-home", label: "Its home mission" }]} />
        </SettingsCardRow>}
        <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Runs on</p><p className="text-xs text-muted-foreground">The computer that runs each automation</p></div>
          <span className="shrink-0 text-sm text-muted-foreground">{computerName}</span>
        </SettingsCardRow>
      </SettingsCard>

      <section id="workflow-triggers" data-workflow-section="triggers" aria-label="Triggers" className="scroll-mt-16"><WorkflowTriggers workflow={workflow} disabled={locked} /></section>

      <FormSection title="Instructions">
        <SettingsCard className="mx-0">
          <div className="p-4"><Textarea aria-label="Automation instructions" value={instructions} maxLength={16000} rows={6} disabled={locked} placeholder="e.g. Review the target for exposed secrets and unsafe defaults, verify each finding, then collect a report" onChange={event => setInstructions(event.target.value)} className="min-h-32 resize-y text-[13px]" /></div>
          <SettingsCardRow>
            <p className="text-sm">Model</p>
            <Select aria-label="Model" size="sm" className="w-64 max-w-[60%] shrink-0" value={modelValue} disabled={locked} onValueChange={value => { setModelValue(value); if (!value) setReasoning(""); }} options={automationModelOptions(modelRows, workflow.model)} />
          </SettingsCardRow>
          <SettingsCardRow>
            <p className="text-sm">Reasoning</p>
            <Select aria-label="Reasoning" size="sm" className="w-44 shrink-0" value={reasoning} disabled={locked || !decodeAutomationModel(modelValue)} onValueChange={setReasoning} options={AUTOMATION_REASONING_OPTIONS} />
          </SettingsCardRow>
        </SettingsCard>
      </FormSection>

      <FormSection title="Runs" id="workflow-runs" data-workflow-section="runs"><WorkflowRuns workflowId={workflow.id} busy={locked} onAction={onAction} /></FormSection>

      <div className="space-y-2">
        <CollapsibleSection id="workflow-steps" title="Steps" description={`${workflow.nodes.length} steps`} defaultOpen>
          <div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Revision {workflow.revision}</span><Button type="button" variant="ghost" size="sm" disabled={locked || !linear || workflow.nodes.length >= 16} onClick={onAddStep}><Plus aria-hidden="true" />Add step</Button></div><WorkflowGraph definition={workflow} selectedId={nodeId} onSelect={onSelectStep} /></div>
        </CollapsibleSection>
        <CollapsibleSection id="workflow-editor" title="Edit with 0">
          <div className="flex h-[480px] min-h-0 flex-col overflow-hidden rounded-[var(--radius-card,8px)] bg-background"><WorkflowChat key={workflow.id} definition={workflow} readOnly={readOnly} /></div>
        </CollapsibleSection>
        <CollapsibleSection id="workflow-versions" data-workflow-section="versions" title="Versions">
          <WorkflowVersions disabled={locked} workflowId={workflow.id} revision={workflow.revision} onRestore={onRestore} />
        </CollapsibleSection>
        <CollapsibleSection id="workflow-learning" data-workflow-section="learning" title="Learning">
          <LearningPanel workflowId={workflow.id} />
        </CollapsibleSection>
        <CollapsibleSection id="workflow-definition" data-workflow-section="definition" title="Definition">
          <WorkflowDefinitionEditor key={workflow.id} definition={workflow} busy={locked} onSave={onSave} />
        </CollapsibleSection>
      </div>
    </div>
  </div>;
}
