import { useEffect, useMemo, useState, type Ref } from "react";
import { useBackendApi } from "@/api";
import { useModelCatalog } from "@/console/use-model-catalog";
import { arrangeCatalog, isModelEnabled, providerLabel } from "@/components/model-picker";
import { Save, Trash2 } from "lucide-react";
import { CapyCopyIcon as Copy, CapyMoreIcon as MoreHorizontal } from "@/ui/icons/capy";
import type { SecurityWorkflow, SecurityWorkflowInput } from "@0/engine/shared";
import { parseSecurityWorkflowInput } from "@0/engine/shared/security-workflows";
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
import { FormSection } from "./automation-ui";
import { AUTOMATION_REASONING_OPTIONS, automationModelChoice, automationModelOptions, decodeAutomationModel, encodeAutomationModel, validateAutomationDraft } from "./automation-model";
import { errorText } from "@/lib/api-error";
import { advanceWorkflowDraftBase, readAutomationDraft, workflowDraftHasConflict, workflowInput, writeAutomationDraft } from "./automation-draft";


/** One automation on one page: name, settings, triggers, then instructions. */
export function AutomationForm({ workflow, readOnly, busy, teamCollaboration, menuButtonRef, error, onSave, onDuplicate, onDelete }: {
  workflow: SecurityWorkflow; readOnly: boolean; busy: boolean; teamCollaboration?: React.ReactNode;
  menuButtonRef: Ref<HTMLButtonElement>; error?: string;
  onSave: (input: SecurityWorkflowInput) => Promise<void>; onDuplicate: () => void; onDelete: () => void;
}) {
  const [base, setBase] = useState(() => structuredClone(workflow));
  const [kept] = useState(() => readAutomationDraft(workflow.id));
  const [name, setName] = useState(kept?.name ?? workflow.name);
  const [target, setTarget] = useState(kept?.target ?? workflow.target);
  const [instructions, setInstructions] = useState(kept?.instructions ?? workflow.instructions);
  const [saveError, setSaveError] = useState("");
  const [runIn, setRunIn] = useState(workflow.runIn ?? "new-mission");
  const [modelValue, setModelValue] = useState(encodeAutomationModel(workflow.model));
  const [reasoning, setReasoning] = useState(workflow.model?.reasoning ?? "");
  const { webFetchJson, client } = useBackendApi();
  const catalog = useModelCatalog({ backendId: client.backendId, webFetchJson });
  const modelRows = useMemo(() => arrangeCatalog({ models: (catalog.data?.models ?? []).filter(isModelEnabled), diagnostics: catalog.data?.diagnostics ?? [] }).groups
    .flatMap(group => group.models.map(row => ({ value: encodeAutomationModel({ providerId: row.provider, model: row.id }), label: `${providerLabel(row.provider)} / ${row.id}` }))), [catalog.data]);
  const modelChoice = automationModelChoice(modelValue, reasoning, workflow.model);
  const sameModel = JSON.stringify(modelChoice) === JSON.stringify(base.model ?? null);
  const owner = useSentinel(workflow.ownerSentinelId ?? "");
  const ownerId = workflow.ownerSentinelId ?? null;
  const changed = name !== base.name || target !== base.target || instructions !== base.instructions || (ownerId !== null && runIn !== (base.runIn ?? "new-mission")) || !sameModel;
  const edited = name !== workflow.name || target !== workflow.target || instructions !== workflow.instructions;
  useEffect(() => { writeAutomationDraft(workflow.id, edited ? { name, target, instructions } : null); }, [workflow.id, edited, name, target, instructions]);
  const conflict = workflowDraftHasConflict(base, workflow);
  const locked = busy || readOnly;
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
  return <div className="w-full">
    <header className="sticky top-0 z-10 -mx-1 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 bg-panel px-1 py-1">
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {teamCollaboration}
        <Button type="button" variant="outline" size="sm" disabled={locked || !changed || Boolean(problems.name)} onClick={save}><Save aria-hidden="true" />{changed ? "Save" : "Saved"}</Button>
        <DropdownMenu>
          <DropdownMenu.Trigger render={<Button ref={menuButtonRef} type="button" variant="ghost" size="icon-sm" aria-label="More automation settings" disabled={busy} />}><MoreHorizontal aria-hidden="true" /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
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
        <Input aria-label="Automation name" value={name} maxLength={160} required disabled={locked} placeholder="Automation name" onChange={event => setName(event.target.value)} className="h-9 text-ellipsis border-transparent bg-transparent px-0 text-xl font-medium shadow-none focus-visible:border-border-2 md:text-xl" />
        {problems.name && <p role="alert" className="text-xs text-destructive">{problems.name}</p>}
      </div>

      <SettingsCard className="mx-0">
        {ownerId && <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Owner</p><p className="text-xs text-muted-foreground">{v("Shares this {sentinel}'s memory")}</p></div>
          <Link to={sentinelHref(ownerId, "overview")} className="min-w-0 truncate text-sm underline-offset-2 hover:underline">{owner.data?.name ?? "Agent"}</Link>
        </SettingsCardRow>}
        {ownerId && <SettingsCardRow>
          <div className="min-w-0"><p className="text-sm">Runs in</p><p className="text-xs text-muted-foreground">Where each run lives</p></div>
          <Select aria-label="Runs in" size="sm" className="w-44 shrink-0" value={runIn} disabled={locked} onValueChange={setRunIn} options={[{ value: "new-mission", label: v("A new {mission}") }, { value: "sentinel-home", label: "Its home thread" }]} />
        </SettingsCardRow>}
      </SettingsCard>

      <FormSection title="Instructions">
        <SettingsCard className="mx-0">
          <div className="p-4"><Textarea aria-label="Automation instructions" value={instructions} maxLength={16000} rows={6} disabled={locked} placeholder="e.g. Review this repo for exposed secrets and unsafe defaults, then summarize what you find" onChange={event => setInstructions(event.target.value)} className="min-h-32 resize-y text-[13px]" /></div>
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

    </div>
  </div>;
}
