import { presentToolCall } from "./tool-presentation";
import { toolCallStatus } from "./tool-call-status";
import type { ToolCallState } from "./transcript";

export type ToolRowItem = { type: "call"; call: ToolCallState } | { type: "group"; id: string; calls: ToolCallState[] };

type Kind = "read" | "search" | "command" | "edit" | "tool";

function kindOf(call: ToolCallState): Kind {
  const view = presentToolCall(call);
  if (view.command) return "command";
  if (/^Read /.test(view.title)) return "read";
  if (/^(Search|List) /.test(view.title)) return "search";
  if (/^(Update|Save) |^(write|edit|patch|apply)/i.test(view.title) || /(?:^|[._:/])(write|edit|apply_patch|patch)/i.test(call.name)) return "edit";
  return "tool";
}

const PHRASES: Record<Kind, [one: string, many: string]> = {
  read: ["Read 1 file", "Read {n} files"],
  search: ["Searched once", "Searched {n} times"],
  command: ["Ran 1 command", "Ran {n} commands"],
  edit: ["Made 1 change", "Made {n} changes"],
  tool: ["Used 1 tool", "Used {n} tools"],
};

/** "Read 3 files, ran 2 commands, and searched twice": the top three kinds in the order they first happened. */
export function groupSummary(calls: ToolCallState[]): string {
  const counts = new Map<Kind, number>();
  for (const call of calls) {
    const kind = kindOf(call);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const phrases = [...counts].slice(0, 3).map(([kind, n]) => PHRASES[kind][n === 1 ? 0 : 1].replace("{n}", String(n)));
  const lowered = phrases.map((phrase, index) => (index ? phrase[0]!.toLowerCase() + phrase.slice(1) : phrase));
  if (lowered.length < 2) return lowered[0] ?? "";
  return `${lowered.slice(0, -1).join(", ")}${lowered.length > 2 ? "," : ""} and ${lowered.at(-1)}`;
}

/**
 * One row per call; two or more consecutive successful, finished calls fold into one summary row.
 * Running, queued, stopped and failed calls always stand alone so the live edge and errors stay visible.
 */
export function groupFinishedCalls(calls: ToolCallState[]): ToolRowItem[] {
  const items: ToolRowItem[] = [];
  let run: ToolCallState[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ type: "group", id: `group:${run[0]!.id}`, calls: run });
    else for (const call of run) items.push({ type: "call", call });
    run = [];
  };
  for (const call of calls) {
    if (!call.isRunning && !call.queued && toolCallStatus(call) === "Done") run.push(call);
    else {
      flush();
      items.push({ type: "call", call });
    }
  }
  flush();
  return items;
}
