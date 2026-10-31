import { Check, Circle, CircleSlash, ListChecks, X } from "lucide-react";
import { Popover } from "@cloudflare/kumo/components/popover";
import type { ConsoleTodos } from "@0/shared";
import { Button } from "@/components/ui/button";
import { ActivityMark } from "./loading-state";

export function TaskProgressList({ todos, active = false }: { todos: ConsoleTodos; active?: boolean }) {
  return <ol aria-label="Task checklist" className="max-h-[min(26rem,55dvh)] min-h-0 space-y-1 overflow-y-auto overscroll-contain">
    {todos.todos.map(task => {
      const completed = task.status === "completed";
      const running = active && task.status === "in_progress";
      const cancelled = task.status === "cancelled";
      const label = completed ? "Completed" : running ? "In progress" : task.status === "in_progress" ? "Not running" : cancelled ? "Cancelled" : "Pending";
      return <li key={task.id} data-task-status={task.status} className={`flex items-start gap-3 rounded-[var(--radius-control)] px-2 py-2.5 ${running ? "bg-muted/60" : ""}`}>
        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center ${completed ? "text-emerald-500" : "text-muted-foreground"}`}>
          {completed ? <Check aria-hidden="true" className="size-4" /> : running ? <ActivityMark compact /> : cancelled ? <CircleSlash aria-hidden="true" className="size-3.5" /> : <Circle aria-hidden="true" className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1"><p className={`break-words text-sm leading-5 ${completed || cancelled ? "text-muted-foreground line-through" : "text-foreground"}`}>{task.content}</p><p className="mt-1 text-[11px] text-muted-foreground">{label}{task.group ? ` · ${task.group}` : ""}</p></div>
      </li>;
    })}
  </ol>;
}

/** Live checklist anchored to the composer context bar, separate from usage/tools. */
export function TaskProgress({ todos, active = false }: { todos: ConsoleTodos; active?: boolean }) {
  const current = active ? todos.todos.find(task => task.status === "in_progress") : undefined;
  return <Popover>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />}
      aria-label={`Open tasks: ${todos.done} of ${todos.total} complete${current ? `. Current task: ${current.content}` : ""}`}
      className="ml-auto flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      <ListChecks aria-hidden="true" className="size-3.5 shrink-0" /><span className="shrink-0 tabular-nums">{todos.done}/{todos.total}</span><span className="shrink-0">tasks</span>
      {current && <span className="hidden min-w-0 max-w-40 truncate text-left md:block">· {current.content}</span>}
    </Popover.Trigger>
    <Popover.Content side="top" align="end" sideOffset={10} positionMethod="fixed"
      className="flex w-96 max-w-[calc(100vw-24px)] flex-col gap-3 rounded-[var(--radius-menu)] border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <div className="flex items-center justify-between gap-3"><Popover.Title className="text-sm font-medium">Tasks <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">{todos.done}/{todos.total} complete</span></Popover.Title><Popover.Close render={<Button variant="ghost" size="icon-xs" />} aria-label="Close tasks"><X className="size-3.5" /></Popover.Close></div>
      <Popover.Description className={active ? "sr-only" : "text-xs leading-5 text-muted-foreground"}>{active ? "Live task progress for this conversation." : todos.done < todos.total ? "This chat is not running. The saved checklist has items not marked complete." : "All checklist items are complete."}</Popover.Description>
      <TaskProgressList todos={todos} active={active} />
    </Popover.Content>
  </Popover>;
}
