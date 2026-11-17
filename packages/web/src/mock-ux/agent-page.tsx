import { Link, useParams } from "react-router-dom";
import { CapyAutomationsIcon, CapyCheckIcon, CapyAlertIcon, CapyArrowLeftIcon } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-shell";
import { AGENTS, WORKFLOWS } from "./fixtures";
import { AGENT_NOUN, agentWord } from "./vocab";
import { AgentTile, NeedsYou, Section, StatusGlyph, cardClasses } from "./parts";
import { cn } from "@/lib/utils";

const STATUS_TEXT = { running: "Working now", "needs-you": "Needs you", idle: "Idle", paused: "Paused" } as const;

export function AgentPage() {
  const { id } = useParams();
  const agent = AGENTS.find(item => item.id === id);
  if (!agent) return <p className="p-6 text-sm text-muted-foreground">No {agentWord} here.</p>;
  const workflow = WORKFLOWS.find(item => item.id === agent.workflowId);
  const isOverview = agent.id === "overview";
  return <div className="mx-auto flex w-full max-w-(--page-width-list) flex-col gap-8 px-6 pt-8 pb-10 md:pt-12" data-testid="agent-page">
    <PageHeader title={<span className="flex items-center gap-3"><AgentTile agent={agent} size="lg" />{agent.name}</span>}
      summary={<span className="mt-2 flex flex-wrap items-center gap-2"><StatusGlyph status={agent.status} /><span>{STATUS_TEXT[agent.status]}</span><span>·</span><span>{agent.overview}</span><NeedsYou count={agent.needsYou} long /></span>}
      actions={workflow ? <Button variant="secondary" size="sm" render={<Link to={`/workflows/${workflow.id}`} />}><CapyAutomationsIcon aria-hidden="true" />{workflow.name} workflow</Button> : undefined} />
    <p className="-mt-4 max-w-2xl text-[13px] leading-5 text-muted-foreground-2">{isOverview
      ? `An optional dashboard ${agentWord}. It does not review anything itself. Ask it what is going on and it reads what the other ${agentWord}s did.`
      : `A standing thread that never has to end. It compacts as it grows and remembers through Memory. ${workflow ? `Each time ${workflow.name} fires, the run is a thread of its own that links back here.` : ""}`}</p>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="agent-stats">
      {agent.stats.map(stat => <div key={stat.label} className={cn(cardClasses, "p-3")}><div className="text-xs text-muted-foreground-1">{stat.label}</div><div className={cn("mt-1 text-lg font-medium tabular-nums", stat.label === "Needs you" && stat.value !== "0" && "text-amber-600 dark:text-amber-400")}>{stat.value}</div></div>)}
    </div>
    <Section title="What happened" description={`What this ${agentWord} did, newest first. Nothing is hidden behind a single orchestrator.`}>
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")}>
        {agent.events.map((event, index) => {
          const body = <><span className="mt-0.5 shrink-0">{event.kind === "finding" ? <CapyAlertIcon aria-hidden="true" className="size-4 text-amber-500" /> : event.kind === "run" ? <StatusGlyph status="running" /> : <CapyCheckIcon aria-hidden="true" className="size-4 text-emerald-500" />}</span>
            <span className="min-w-0 flex-1 text-sm">{event.text}</span><span className="shrink-0 text-xs text-muted-foreground-1">{event.at}</span></>;
          return <li key={index}>{event.threadId ? <Link to={`/chats/${event.threadId}`} className="flex items-start gap-3 px-4 py-3 ui-row-hover">{body}</Link> : <div className="flex items-start gap-3 px-4 py-3">{body}</div>}</li>;
        })}
      </ul>
    </Section>
    <Section title={`Talk to ${agent.name}`} description={isOverview ? "Ask what is going on." : "This is the standing thread. Ask a question or give it direction."}>
      <div className="rounded-xl border-[0.5px] border-border-2 bg-card p-2"><Textarea aria-label="Message" rows={2} placeholder={isOverview ? "What is going on today?" : `Ask ${agent.name} anything`} className="min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" /><div className="flex justify-end pt-1"><Button size="sm" disabled>Send</Button></div></div>
    </Section>
    <Link to="/chats" className="inline-flex items-center gap-1 text-xs text-muted-foreground-1 hover:text-foreground"><CapyArrowLeftIcon aria-hidden="true" className="size-3" />Back to threads</Link>
  </div>;
}
