import { useEffect, useState } from "react";
import { ArrowUp, FilePlus2, LayoutTemplate } from "lucide-react";
import { CapyArrowLeftIcon as ArrowLeft, CapySearchIcon as Search, CapySparkleIcon as Sparkles } from "@/ui/icons/capy";
import { SECURITY_WORKFLOW_TEMPLATES } from "@0/engine/dist/shared/security-workflow-templates.js";
import { v } from "@/lib/vocabulary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ActivityIndicator } from "@/console/loading-state";
import { filterTemplates } from "./automation-model";

type Step = "choose" | "template" | "describe";

const CARD = "flex flex-col items-start gap-2 rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card p-4 text-left outline-none transition-colors hover:bg-secondary focus-visible:outline-ring-inset disabled:pointer-events-none disabled:opacity-55";

/** Capy-style "Create automation" dialog: scratch, template, or describe it. */
export function NewAutomationDialog({ open, onOpenChange, busy, readOnly, initialStep = "choose", onBlank, onTemplate, onPrompt, onDescribe }: {
  open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; readOnly: boolean; initialStep?: Step;
  onBlank: () => Promise<void>; onTemplate: (id: string) => Promise<void>; onPrompt: (prompt: string) => Promise<void>; onDescribe: (text: string) => void;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setStep(initialStep); setQuery(""); setError(""); } }, [open, initialStep]);
  const templates = filterTemplates(SECURITY_WORKFLOW_TEMPLATES, query);
  const attempt = (action: () => Promise<void>) => { setError(""); void action().then(() => onOpenChange(false)).catch(cause => setError(cause instanceof Error ? cause.message : "Unable to create the automation.")); };
  const locked = busy || readOnly;
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{step === "choose" ? "Create automation" : step === "template" ? "Start from template" : "Create with 0"}</DialogTitle>
        <DialogDescription>{step === "choose" ? "Choose how to create your automation" : step === "template" ? "Pick a ready-made automation and fit it to your target" : "Describe what you want. 0 fills in the form and you review it before anything runs."}</DialogDescription>
      </DialogHeader>
      {step === "choose" && <div className="grid gap-3 sm:grid-cols-3">
        <button type="button" disabled={locked} className={CARD} onClick={() => attempt(onBlank)}><FilePlus2 aria-hidden="true" className="size-5 text-muted-foreground" /><span className="text-sm font-medium">Start from scratch</span><span className="text-xs text-muted-foreground">Configure triggers, instructions and limits yourself</span></button>
        <button type="button" disabled={locked} className={CARD} onClick={() => setStep("template")}><LayoutTemplate aria-hidden="true" className="size-5 text-muted-foreground" /><span className="text-sm font-medium">Start from template</span><span className="text-xs text-muted-foreground">Pick a ready-made automation and fit it to your target</span></button>
        <button type="button" disabled={locked} className={CARD} onClick={() => setStep("describe")}><Sparkles aria-hidden="true" className="size-5 text-muted-foreground" /><span className="text-sm font-medium">Create with 0</span><span className="text-xs text-muted-foreground">Describe what you want and 0 pre-fills the form</span></button>
      </div>}
      {step === "template" && <div className="space-y-3">
        <div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input autoFocus aria-label="Search templates" placeholder="Search templates…" className="h-7 pl-8 text-sm" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <ul aria-label="Templates" className="scroll-fade-y -mx-1 flex max-h-[min(22rem,50dvh)] flex-col overflow-y-auto px-1">
          {templates.map(item => <li key={item.id}><button type="button" disabled={locked} onClick={() => attempt(() => onTemplate(item.id))} className="flex h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-card,8px)] px-2 text-left outline-none hover:bg-secondary focus-visible:outline-ring-inset disabled:pointer-events-none disabled:opacity-55"><span className="w-56 shrink-0 truncate text-sm">{item.name}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.description}</span></button></li>)}
        </ul>
        {!templates.length && <p className="py-6 text-center text-sm text-muted-foreground">No matching templates.</p>}
      </div>}
      {step === "describe" && <form className="space-y-4" onSubmit={event => { event.preventDefault(); const text = prompt.trim(); if (text) attempt(() => onPrompt(text)); }}>
        <Textarea rows={5} autoFocus aria-label="Describe a custom automation" placeholder="Run a whitebox pentest of a repository every Monday, verify findings, then prepare a report…" disabled={locked} value={prompt} onChange={event => setPrompt(event.target.value)} />
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep("choose")}><ArrowLeft aria-hidden="true" />Back</Button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" disabled={locked || !prompt.trim()} onClick={() => { onDescribe(prompt.trim()); onOpenChange(false); }}>{v("Draft in {a mission}")}</Button>
            <Button type="submit" disabled={locked || !prompt.trim()}><ArrowUp aria-hidden="true" />Create draft</Button>
          </div>
        </DialogFooter>
      </form>}
      {step === "template" && <DialogFooter className="sm:justify-start"><Button type="button" variant="ghost" disabled={busy} onClick={() => setStep("choose")}><ArrowLeft aria-hidden="true" />Back</Button></DialogFooter>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {busy && <ActivityIndicator label="Creating automation…" />}
    </DialogContent>
  </Dialog>;
}
