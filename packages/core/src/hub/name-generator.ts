/**
 * Task-derived agent labels and case-insensitive fleet name uniqueness.
 * Opaque agent ids remain the mailbox addresses; labels describe the work.
 */

/** The reserved name for the primary session. Never generated. */
export const PRIMARY_AGENT_NAME = "Main";

/**
 * One bounded, readable label for both live workers and retained task cards.
 * Structured assignments prefer the goal/change over generic Markdown headings
 * or acceptance instructions. Older records can supply their name as a fallback.
 * Size-owning surfaces can request an unbounded label with maxLength=Infinity.
 */
export function agentTaskLabel(task: string, fallbackName?: string, maxLength = 64): string {
  let label = "";
  let priority = 5;
  let sectionPriority = 4;
  for (let start = 0; start < task.length;) {
    const end = task.indexOf("\n", start);
    let line = task.slice(start, end < 0 ? task.length : end).trim();
    start = end < 0 ? task.length : end + 1;
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const section = /^(Goal|Task|Change|Target|Constraints?|Contract|Acceptance|Non-goals?)(?:\s*[:—–-]\s*(.*))?$/i.exec(heading[1]!);
      if (section) {
        switch (section[1]!.toLowerCase()) {
          case "goal": sectionPriority = 0; break;
          case "task": sectionPriority = 1; break;
          case "change": sectionPriority = 2; break;
          case "target": sectionPriority = 3; break;
          default: sectionPriority = -1;
        }
        line = section[2]?.trim() ?? "";
      } else {
        sectionPriority = 4;
        line = heading[1]!;
      }
    }
    if (!line || sectionPriority < 0 || sectionPriority >= priority) continue;
    const candidate = line
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!candidate) continue;
    label = candidate;
    priority = sectionPriority;
    if (priority === 0) break;
  }
  if (!label) {
    label = (fallbackName ?? "Worker")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Worker";
  }
  const limit = maxLength > 0 ? Math.max(1, Math.floor(maxLength)) : 64;
  if (label.length <= limit) return label;
  // Never split a surrogate pair at the label boundary.
  let end = limit - 1;
  if (/[\ud800-\udbff]/.test(label[end - 1] ?? "")) end--;
  return `${label.slice(0, end).trimEnd()}…`;
}

/**
 * Make `name` unique against `taken` (case-insensitive, matching OMP's uniquify)
 * by appending `-2`, `-3`, … The suffix search is bounded only by how many
 * collisions exist, which in practice is a tiny fleet.
 */
export function uniquifyAgentName(name: string, taken: Iterable<string>): string {
  const lower = new Set<string>();
  for (const t of taken) lower.add(t.toLowerCase());
  if (!lower.has(name.toLowerCase())) return name;
  let n = 2;
  while (lower.has(`${name}-${n}`.toLowerCase())) n += 1;
  return `${name}-${n}`;
}

/**
 * A task-derived name for a freshly spawned agent, unique within its fleet.
 * A child of a child can be dot-qualified under its parent so lineage remains
 * readable without changing either worker's opaque address.
 */
export function assignAgentName(
  task: string,
  taken: Iterable<string>,
  parentName?: string,
): string {
  const base = agentTaskLabel(task);
  const qualified = parentName && parentName !== PRIMARY_AGENT_NAME ? `${parentName}.${base}` : base;
  return uniquifyAgentName(qualified, taken);
}
