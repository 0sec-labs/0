import { useState, type Ref } from "react";
import { ListChecks, Save, Trash2 } from "lucide-react";
import { CapyCheckIcon as Check, CapyChevronRightIcon as ChevronRight, CapyCopyIcon as Copy, CapyMoreIcon as MoreHorizontal, CapyPlayIcon as Play, CapyPlusIcon as Plus } from "@/ui/icons/capy";
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
import { validateAutomationDraft } from "./automation-model";

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
  const [runIn, setRunIn] = useState(workflow.runIn ?? "new-mission");
  const owner = useSentinel(workflow.ownerSentinelId ?? "");
  const ownerId = workflow.ownerSentinelId ?? null;
  const changed = name !== base.name || target !== base.target || instructions !== base.instructions || (ownerId !== null && runIn !== (base.runIn ?? "new-mission"));
  const conflict = workflowDraftHasConflict(base, workflow);
  const locked = busy || readOnly;
  const enabledAudits = workflow.nodes.filter(node => node.type !== "trigger" && node.type !== "report" && node.enabled);
  const canRun = Boolean(workflow.target.trim() && enabledAudits.length);
  const problems = validateAutomationDraft({ name });
  const reload = () => { setBase(structuredClone(workflow)); setName(workflow.name); setTarget(workflow.target); setInstructions(workflow.instructions); setRunIn(workflow.runIn ?? "new-mission"); setSaveError(""); };
  const save = () => {
    setSaveError("");
    if (problems.name) return;
    try {
      const input = parseSecurityWorkflowInput({ ...workflowInput(base), name, target, instructions, ...(ownerId ? { runIn } : {}) });
      void onSave(input).then(() => setBase(advanceWorkflowDraftBase(base, input))).catch(cause => setSaveError(cause instanceof Error ? cause.message : "Unable to save."));
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Invalid automation."); }
  };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return <div className="mx-auto w-full max-w-[940px]">
    <header className="sticky top-0 z-10 -mx-1 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 bg-background px-1 py-1">
      <nav aria-label="Breadcrumb" className="flex min-w-0 max-w-full items-center gap-1 text-sm"><Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onBack}>Automations</Button><ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-3" /><span className="truncate" aria-current="page">{base.name}</span></nav>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {teamCollaboration}
        <Button type="button" variant="ghost" size="sm" className="max-sm:hidden" onClick={() => jump("workflow-runs")}><ListChecks aria-hidden="true" />View runs</Button>
        {!changed && <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden="true" />Saved</span>}
        <Button type="button" variant="outline" size="sm" disabled={locked || !changed || Boolean(problems.name)} onClick={save}><Save aria-hidden="true" />Save</Button>
        <Button ref={runButtonRef} type="button" size="sm" disabled={locked || !canRun} onClick={onRun}><Play aria-hidden="true" />Run</Button>
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
        <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">Active<AutomationActiveSwitch workflow={workflow} disabled={locked} onNeedsSetup={() => jump("workflow-triggers")} className="flex items-center" /></label>
      </div>

      <SettingsCard className="mx-0">
        <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Project</p><p className="text-xs text-muted-foreground">{v("Each run starts a new {mission} against this target")}</p></div>
          <Input aria-label="Target" value={target} maxLength={4096} disabled={locked} placeholder="Repository path, package, or website" onChange={event => setTarget(event.target.value)} className="h-7 w-72 max-w-[50%] shrink-0 text-[13px]" />
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

      <FormSection title="Instructions" description="What 0 does when the automation triggers">
        <Textarea aria-label="Instructions" value={instructions} maxLength={16000} rows={6} disabled={locked} placeholder="e.g. Review the target for exposed secrets and unsafe defaults, verify each finding, then collect a report" onChange={event => setInstructions(event.target.value)} className="min-h-32 resize-y text-[13px]" />
      </FormSection>

      <FormSection title="Runs" id="workflow-runs" data-workflow-section="runs"><WorkflowRuns workflowId={workflow.id} busy={locked} onAction={onAction} /></FormSection>

      <div className="space-y-2">
        <CollapsibleSection id="workflow-steps" title="Steps" description={`${workflow.nodes.length} steps`} defaultOpen>
          <div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{workflow.nodes.length} steps · Revision {workflow.revision}</span><Button type="button" variant="ghost" size="sm" disabled={locked || !linear || workflow.nodes.length >= 16} onClick={onAddStep}><Plus aria-hidden="true" />Add step</Button></div><WorkflowGraph definition={workflow} selectedId={nodeId} onSelect={onSelectStep} /></div>
        </CollapsibleSection>
        <CollapsibleSection id="workflow-editor" title="Edit with 0" description="Discuss changes in a conversation about this automation">
          <div className="flex h-[480px] min-h-0 flex-col overflow-hidden rounded-[var(--radius-card,8px)] bg-background"><WorkflowChat key={workflow.id} definition={workflow} readOnly={readOnly} /></div>
        </CollapsibleSection>
        <CollapsibleSection id="workflow-versions" data-workflow-section="versions" title="Versions" description="Restore an earlier revision">
          <WorkflowVersions disabled={locked} workflowId={workflow.id} revision={workflow.revision} onRestore={onRestore} />
        </CollapsibleSection>
        <CollapsibleSection id="workflow-learning" data-workflow-section="learning" title="Learning" description="What past runs taught this automation">
          <LearningPanel workflowId={workflow.id} />
        </CollapsibleSection>
        <CollapsibleSection id="workflow-definition" data-workflow-section="definition" title="Definition" description="Portable JSON for steps, links and review settings">
          <WorkflowDefinitionEditor key={workflow.id} definition={workflow} busy={locked} onSave={onSave} />
        </CollapsibleSection>
      </div>
    </div>
  </div>;
}
