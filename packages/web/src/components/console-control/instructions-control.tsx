import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Feedback, SubmitButton } from "./control-ui";
import type { ProjectResponse } from "./contracts";
import { SettingsRow, SettingsSection } from "./settings-section";
import { INSTRUCTIONS_MAX_CHARS, instructionCounter, instructionDraftState, instructionSaveBody, instructionSummary, instructionsUrl, type InstructionFile, type InstructionKind } from "./instructions-model";

const COPY: Record<InstructionKind, { title: string; description: string }> = {
  global: { title: "Global", description: "Applies to every mission on this machine." },
  workspace: { title: "Workspace", description: "Applies to missions in the current workspace folder." },
};

function InstructionSheet({ kind, workspacePath, file, onClose }: { kind: InstructionKind; workspacePath?: string; file: InstructionFile; onClose: () => void }) {
  const { webFetchJson } = useBackendApi();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(file.content);
  const state = instructionDraftState(file.content, draft, file.maxChars || INSTRUCTIONS_MAX_CHARS);
  const save = useMutation({
    mutationFn: () => webFetchJson<InstructionFile>(instructionsUrl(kind), { method: "PUT", body: instructionSaveBody(kind, draft, file.revision, workspacePath) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["console-instructions"] }); onClose(); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ["console-instructions"] }); },
  });
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
    <SheetContent className="w-full data-[side=right]:sm:max-w-[640px]">
      <SheetHeader>
        <SheetTitle>{COPY[kind].title} instructions</SheetTitle>
        <SheetDescription>Markdown. Added to the system prompt when a mission starts.</SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-2">
        <div className="flex items-center justify-between gap-4 text-xs"><code className="font-mono text-muted-foreground-1">{file.fileName}</code><span aria-live="polite" className={state.overLimit ? "text-destructive" : "text-muted-foreground-2"}>{instructionCounter(draft.length, file.maxChars)}</span></div>
        <Textarea aria-label={`${COPY[kind].title} instructions`} className="min-h-80 flex-1 font-mono text-xs" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Write guidance for the agent, for example preferred tools, conventions or reporting style." />
        <Feedback error={save.error} />
      </div>
      <SheetFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <SubmitButton variant="accent" pending={save.isPending} disabled={!state.canSave} onClick={() => save.mutate()}>Save</SubmitButton>
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}

function InstructionRow({ kind, workspacePath }: { kind: InstructionKind; workspacePath?: string }) {
  const { webFetchJson } = useBackendApi();
  const [open, setOpen] = useState(false);
  const enabled = kind === "global" || Boolean(workspacePath);
  const file = useQuery({
    queryKey: ["console-instructions", kind, workspacePath ?? null],
    enabled,
    queryFn: ({ signal }) => webFetchJson<InstructionFile>(instructionsUrl(kind, workspacePath), { signal }),
  });
  useEffect(() => { if (file.isError) setOpen(false); }, [file.isError]);
  const description = kind === "workspace" && workspacePath ? <>{COPY[kind].description} <span className="font-mono break-all">{workspacePath}</span></> : COPY[kind].description;
  return <SettingsRow id={`setting-instructions-${kind}`} label={`${COPY[kind].title} instructions`} description={description} badge={file.data ? <span className="font-mono">{file.data.fileName}</span> : undefined}>
    <span className="text-xs text-muted-foreground-2">{file.data ? instructionSummary(file.data.content) : ""}</span>
    <Button variant="outline" size="sm" disabled={!file.data} onClick={() => setOpen(true)}>Edit</Button>
    {open && file.data && <InstructionSheet kind={kind} workspacePath={workspacePath} file={file.data} onClose={() => setOpen(false)} />}
  </SettingsRow>;
}

/** Operator-owned instructions. Files inside a target repository are never loaded. */
export function InstructionsSettings() {
  const { webFetchJson } = useBackendApi();
  const project = useQuery({ queryKey: ["console-instructions-project"], queryFn: ({ signal }) => webFetchJson<ProjectResponse>("/api/console/project", { signal }), retry: false });
  return <div className="flex flex-col gap-10">
    <SettingsSection id="settings-instructions" title="Instructions" description="Guidance added to every mission's system prompt. Saved on this machine, not in your repository. AGENTS.md or CLAUDE.md files inside a project you scan are never loaded, because that text is untrusted.">
      <InstructionRow kind="global" />
      <InstructionRow kind="workspace" workspacePath={project.data?.path} />
      {project.isError && <Feedback error={project.error} />}
    </SettingsSection>
  </div>;
}
