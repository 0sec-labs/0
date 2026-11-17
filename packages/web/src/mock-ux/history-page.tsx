import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CapySearchIcon } from "@/ui/icons/capy";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-shell";
import { THREADS, WORKFLOWS } from "./fixtures";
import { Chip, cardClasses } from "./parts";
import { cn } from "@/lib/utils";

export function HistoryPage() {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<string | null>(null);
  const rows = useMemo(() => THREADS.filter(thread => thread.title.toLowerCase().includes(query.toLowerCase()) && (!only || thread.workflowId === only)), [query, only]);
  const days = ["Today", "Yesterday", "This week", "Earlier"] as const;
  return <div className="mx-auto flex w-full max-w-(--page-width-list) flex-col gap-6 px-6 pt-6 pb-10 md:pt-12" data-testid="history-page">
    <PageHeader title="History" summary="Every thread, searchable. The sidebar only keeps the few you are likely to need." />
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-60 flex-1"><CapySearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground-1" /><Input aria-label="Search threads" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search threads" className="pl-8" /></div>
      <button type="button" onClick={() => setOnly(null)} className={cn("h-7 rounded-md px-2 text-xs", !only ? "bg-secondary text-foreground" : "text-muted-foreground-1 hover:text-foreground")}>All</button>
      {WORKFLOWS.filter(item => item.predefined).map(item => <button key={item.id} type="button" onClick={() => setOnly(item.id)} className={cn("h-7 rounded-md px-2 text-xs", only === item.id ? "bg-secondary text-foreground" : "text-muted-foreground-1 hover:text-foreground")}>{item.name}</button>)}
    </div>
    {days.map(day => { const list = rows.filter(thread => thread.day === day); return list.length === 0 ? null : <section key={day} aria-label={day} className="space-y-2"><h2 className="text-xs font-medium text-muted-foreground-1">{day}</h2>
      <ul className={cn(cardClasses, "divide-y-[0.5px] divide-border-2")}>{list.map(thread => <li key={thread.id}><Link to={`/chats/${thread.id}`} className="flex items-center gap-3 px-4 py-2.5 ui-row-hover"><span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
        {thread.workflowId && <Chip>{WORKFLOWS.find(item => item.id === thread.workflowId)?.name}</Chip>}<span className="hidden w-20 truncate text-xs text-muted-foreground-1 sm:block">{thread.folder}</span><span className="w-16 text-right text-xs tabular-nums text-muted-foreground-1">{thread.age}</span></Link></li>)}</ul></section>; })}
    {rows.length === 0 && <p className="text-sm text-muted-foreground-1">No threads match.</p>}
  </div>;
}
