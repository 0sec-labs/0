import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CapyArrowLeftIcon, CapyPlayIcon, CapyPlusIcon, CapyMoreIcon, CapyCloseIcon, CapyAutomationsIcon, CapyChevronRightIcon, CapyPullRequestIcon, CapyGlobeIcon, CapyBellIcon, CapyTerminalSparkleIcon, CapySparkleIcon } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-shell";
import { KIND_LABEL, MODELS, REASONING, SKILLS, THREADS, WORKFLOWS, type MockTrigger, type MockWorkflow } from "./fixtures";
import { Chip, Section, cardClasses } from "./parts";
import { cn } from "@/lib/utils";

const KIND_ICON = { schedule: CapyBellIcon, "github-pr": CapyPullRequestIcon, manual: CapyTerminalSparkleIcon, webhook: CapyGlobeIcon } as const;
const triggerSummary = (workflow: MockWorkflow) => workflow.triggers.filter(trigger => trigger.kind !== "manual").map(trigger => `${KIND_LABEL[trigger.kind]}: ${trigger.detail.split(" · ")[0]}`).join("  ·  ") || "Manual only";

export function WorkflowsPage() {
  const navigate = useNavigate();
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(WORKFLOWS.map(item => [item.id, item.on])));
  const row = (workflow: MockWorkflow) => <li key={workflow.id} className="flex items-center gap-3 px-4 py-3">
    <Link to={`/workflows/${workflow.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:outline-ring-inset">
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{workflow.name}</span><span className="block truncate text-xs text-muted-foreground-1">{workflow.description}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground-2">{triggerSummary(workflow)}</span></span>
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground-1 sm:block">{workflow.threadsThisWeek} {workflow.threadsThisWeek === 1 ? "thread" : "threads"} this week</span>
      <CapyChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground-3" />
    </Link>
    <Switch aria-label={`${workflow.name} on or off`} checked={on[workflow.id]} onCheckedChange={next => setOn(state => ({ ...state, [workflow.id]: next }))} />
  </li>;
  return <div className="mx-auto flex w-full max-w-(--page-width-list) flex-col gap-10 px-6 pt-6 pb-10 md:pt-12" data-testid="workflows-page">
    <PageHeader title="Workflows" summary="A workflow is a system prompt, skills and the triggers that start it. Every time one fires, it starts a thread."
      actions={<><Button variant="secondary" size="sm" onClick={() => navigate("/workflows/new")}><CapySparkleIcon aria-hidden="true" />Describe what you want</Button><Button variant="ghost" size="sm" onClick={() => navigate("/workflows/docs-drift")}><CapyPlusIcon aria-hidden="true" />New workflow</Button></>} />
    <Section title="Security" description="Predefined. Turn on, then customise to fit your repository.">
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")}>{WORKFLOWS.filter(item => item.predefined).map(row)}</ul>
    </Section>
    <Section title="Yours">
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")}>{WORKFLOWS.filter(item => !item.predefined).map(row)}</ul>
    </Section>
  </div>;
}

export function WorkflowDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const source = WORKFLOWS.find(item => item.id === id) ?? WORKFLOWS[3];
  const [enabled, setEnabled] = useState(source.on);
  const [prompt, setPrompt] = useState(source.prompt);
  const [skills, setSkills] = useState(source.skills);
  const [triggers, setTriggers] = useState<MockTrigger[]>(source.triggers);
  const [model, setModel] = useState(source.model);
  const [reasoning, setReasoning] = useState(source.reasoning);
  const threads = THREADS.filter(thread => source.threads.includes(thread.id));
  const addTrigger = (kind: MockTrigger["kind"]) => setTriggers(list => [...list, { id: `${kind}-${list.length}`, kind, on: true, detail: { schedule: "Every day 09:00", "github-pr": "0security/0 · base main", manual: "From any thread", webhook: "POST /hooks/new (secret URL)" }[kind] }]);
  return <div className="mx-auto flex w-full max-w-(--page-width-form) flex-col gap-8 px-6 pt-6 pb-10 md:pt-12" data-testid="workflow-detail">
    <div><Link to="/workflows" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground-1 hover:text-foreground"><CapyArrowLeftIcon aria-hidden="true" className="size-3" />Workflows</Link>
      <PageHeader title={source.name} summary={source.description} actions={<>
        <Button variant="secondary" size="sm"><CapyPlayIcon aria-hidden="true" />Run now</Button>
        <Button size="sm">Save</Button>
        <DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="icon-sm" aria-label="More workflow settings" />}><CapyMoreIcon aria-hidden="true" /></DropdownMenu.Trigger>
          <DropdownMenu.Content align="end"><DropdownMenu.Item>Duplicate</DropdownMenu.Item>{source.predefined && <DropdownMenu.Item>Reset to default</DropdownMenu.Item>}<DropdownMenu.Item variant="danger">Delete</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu></>} /></div>
    <div className={cn(cardClasses, "flex items-center gap-3 px-4 py-3")}><div className="min-w-0 flex-1"><div className="text-sm font-medium">Active</div><div className="text-xs text-muted-foreground-1">{enabled ? "Triggers are armed. New threads start on their own." : "Triggers are off. You can still run it by hand."}</div></div><Switch aria-label="Active" checked={enabled} onCheckedChange={setEnabled} /></div>
    <Section title="System prompt" description="What it should do every time it starts. Trigger details (the PR, the schedule) are added for you.">
      <Textarea aria-label="System prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={7} className="text-[13px] leading-5" />
    </Section>
    <Section title="Skills" description="One or many. The thread can use these.">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="skills">
        {skills.map(skill => <Chip key={skill}>{skill}<button type="button" aria-label={`Remove ${skill}`} onClick={() => setSkills(list => list.filter(item => item !== skill))} className="-mr-0.5 rounded-sm text-muted-foreground-1 hover:text-foreground"><CapyCloseIcon className="size-3" /></button></Chip>)}
        <DropdownMenu><DropdownMenu.Trigger render={<Button variant="ghost" size="xs" className="text-muted-foreground-1" />}><CapyPlusIcon aria-hidden="true" />Add skill</DropdownMenu.Trigger>
          <DropdownMenu.Content align="start">{SKILLS.filter(skill => !skills.includes(skill)).map(skill => <DropdownMenu.Item key={skill} onClick={() => setSkills(list => [...list, skill])}>{skill}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu>
      </div>
    </Section>
    <Section title="Triggers" description="Add as many as you like, or none to run it only by hand."
      actions={<DropdownMenu><DropdownMenu.Trigger render={<Button variant="secondary" size="sm" />}><CapyPlusIcon aria-hidden="true" />Add trigger</DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">{(Object.keys(KIND_LABEL) as MockTrigger["kind"][]).map(kind => { const Icon = KIND_ICON[kind]; return <DropdownMenu.Item key={kind} icon={<Icon aria-hidden="true" />} onClick={() => addTrigger(kind)}>{KIND_LABEL[kind]}</DropdownMenu.Item>; })}</DropdownMenu.Content></DropdownMenu>}>
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")} data-testid="triggers">
        {triggers.map(trigger => { const Icon = KIND_ICON[trigger.kind]; return <li key={trigger.id} className="flex items-center gap-3 px-4 py-2.5"><Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground-1" /><span className="min-w-0 flex-1"><span className="block text-sm">{KIND_LABEL[trigger.kind]}</span><span className="block truncate text-xs text-muted-foreground-1">{trigger.detail}</span></span>
          <Switch aria-label={`${KIND_LABEL[trigger.kind]} trigger`} checked={trigger.on} onCheckedChange={next => setTriggers(list => list.map(item => item.id === trigger.id ? { ...item, on: next } : item))} />
          <Button variant="ghost" size="icon-xs" aria-label="Remove trigger" onClick={() => setTriggers(list => list.filter(item => item.id !== trigger.id))}><CapyCloseIcon /></Button></li>; })}
        {triggers.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground-1">No triggers. Manual only.</li>}
      </ul>
    </Section>
    <Section title="Model and reasoning">
      <div className="grid grid-cols-2 gap-3"><Select aria-label="Model" label="Model" value={model} onValueChange={setModel} options={MODELS.map(item => ({ value: item, label: item }))} /><Select aria-label="Reasoning" label="Reasoning" value={reasoning} onValueChange={setReasoning} options={REASONING.map(item => ({ value: item, label: item }))} /></div>
    </Section>
    <Section title="Threads" description="Each time this workflow fires it starts a thread that links back here.">
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")} data-testid="workflow-threads">
        {threads.map(thread => <li key={thread.id}><Link to={`/chats/${thread.id}`} className="flex items-center gap-3 px-4 py-2.5 ui-row-hover"><span className="min-w-0 flex-1"><span className="block truncate text-sm">{thread.title}</span><span className="block truncate text-xs text-muted-foreground-1">{thread.trigger}</span></span><span className="text-xs text-muted-foreground-1">{thread.age}</span></Link></li>)}
        {threads.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground-1">No threads yet.</li>}
      </ul>
    </Section>
    <Button variant="ghost" size="sm" className="w-fit text-muted-foreground-1" onClick={() => navigate("/workflows/new")}><CapySparkleIcon aria-hidden="true" />Describe a change instead</Button>
  </div>;
}
