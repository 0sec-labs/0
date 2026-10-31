import type {
  ConsoleSessionSnapshot,
  ConsoleMessageAuthor,
  ConsoleMessageInput,
  ConsoleTurnOutcome,
  DesktopConsoleDecision,
  DesktopConsoleEvent,
  DesktopConsoleSessionStatus,
  DesktopConsoleTurnBudget,
  DesktopConsoleUsage,
} from "@0/shared";

export interface ToolCallState {
  id: string;
  name: string;
  arguments: unknown;
  result?: unknown;
  isRunning: boolean;
}

export interface DecisionState extends DesktopConsoleDecision {
  resolved: boolean;
  approved?: boolean;
}

export type TurnSegment =
  | { type: "assistant"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tools"; toolIds: string[] };

export interface ReducedTurn {
  id: string;
  startedAt?: string;
  endedAt?: string;
  user: { text: string; sequence: number; author?: ConsoleMessageAuthor; attachments?: ConsoleMessageInput["attachments"] };
  assistantText: string;
  reasoningText: string;
  toolCalls: ToolCallState[];
  /** Chronological presentation; aggregate text/calls remain for other consumers. */
  segments?: TurnSegment[];
  decisions: DecisionState[];
  notices: string[];
  usage?: DesktopConsoleUsage;
  budget?: DesktopConsoleTurnBudget;
  stopReason?: string;
  error?: string;
  outputCap?: unknown;
  isComplete: boolean;
  isWorking: boolean;
}

function createTurn(id: string, text: string, sequence: number): ReducedTurn {
  return {
    id,
    user: { text, sequence },
    assistantText: "",
    reasoningText: "",
    toolCalls: [],
    segments: [],
    decisions: [],
    notices: [],
    isComplete: false,
    isWorking: false,
  };
}

function appendTextSegment(turn: ReducedTurn, type: "assistant" | "reasoning", text: string) {
  if (!text) return;
  const segments = turn.segments ??= [];
  const last = segments.at(-1);
  if (last?.type === type) last.text += text;
  else segments.push({ type, text });
}

function appendToolSegment(turn: ReducedTurn, id: string) {
  const segments = turn.segments ??= [];
  if (segments.some(segment => segment.type === "tools" && segment.toolIds.includes(id))) return;
  const last = segments.at(-1);
  if (last?.type === "tools") last.toolIds.push(id);
  else segments.push({ type: "tools", toolIds: [id] });
}

/** Match unchanged source blocks in order, allowing only separators between them. */
function alignAssistantSegments(segments: TurnSegment[], text: string): TurnSegment[] | undefined {
  if (!segments.some(segment => segment.type === "assistant")) return;
  let offset = 0;
  const aligned: TurnSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== "assistant") { aligned.push(segment); continue; }
    const index = text.indexOf(segment.text, offset);
    if (index < 0 || text.slice(offset, index).trim()) return;
    aligned.push({ ...segment, text: text.slice(offset, index) + segment.text });
    offset = index + segment.text.length;
  }
  if (text.slice(offset).trim()) return;
  const last = aligned.findLast(segment => segment.type === "assistant");
  if (last?.type === "assistant") last.text += text.slice(offset);
  return aligned;
}

/** Preserve text/tool boundaries when the terminal aggregate confirms streamed text. */
function reconcileAssistantSegments(turn: ReducedTurn, text: string) {
  const segments = turn.segments ??= [];
  const previous = segments.flatMap(segment => segment.type === "assistant" ? [segment.text] : []).join("");
  if (previous === text) return;
  const aligned = alignAssistantSegments(segments, text);
  if (aligned) { turn.segments = aligned; return; }
  if (text.startsWith(previous)) { appendTextSegment(turn, "assistant", text.slice(previous.length)); return; }
  if (previous.startsWith(text)) {
    let remaining = text.length;
    turn.segments = segments.flatMap<TurnSegment>(segment => {
      if (segment.type !== "assistant") return [segment];
      const kept = segment.text.slice(0, remaining); remaining -= kept.length;
      return kept ? [{ ...segment, text: kept }] : [];
    });
    return;
  }
  if (previous && text.endsWith(previous)) {
    const first = segments.find(segment => segment.type === "assistant");
    if (first?.type === "assistant") first.text = text.slice(0, text.length - previous.length) + first.text;
    return;
  }
  // A corrected final response is authoritative; do not render both versions.
  const lastTextIndex = segments.findLastIndex(segment => segment.type === "assistant");
  turn.segments = segments.flatMap<TurnSegment>((segment, index) => segment.type !== "assistant" ? [segment] : index === lastTextIndex && text ? [{ type: "assistant" as const, text }] : []);
  if (lastTextIndex < 0 && text) appendTextSegment(turn, "assistant", text);
}

function completeTurn(turn: ReducedTurn) {
  turn.isComplete = true;
  turn.isWorking = false;
  for (const decision of turn.decisions) decision.resolved = true;
  for (const tool of turn.toolCalls) tool.isRunning = false;
}

function applyOutcome(turn: ReducedTurn, outcome: ConsoleTurnOutcome) {
  // Final text is authoritative, including an intentionally empty response.
  reconcileAssistantSegments(turn, outcome.assistantText);
  turn.assistantText = outcome.assistantText;
  turn.budget = outcome.budget;
  turn.stopReason = outcome.stopReason;
  turn.outputCap = outcome.outputCap;
  if (outcome.error !== undefined) turn.error = outcome.error;
  if (outcome.usage) {
    turn.usage = {
      ...outcome.usage,
      turnTokensUsed: outcome.budget.tokensUsed,
      turnTokenBudget: outcome.budget.tokenBudget,
      iterations: outcome.budget.iterations,
      maxToolIterations: outcome.budget.maxToolIterations,
    };
  }
  completeTurn(turn);
}

function reconcileStatus(turns: ReducedTurn[], status?: DesktopConsoleSessionStatus) {
  const active = status === "working" || status === "waiting";
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (index !== turns.length - 1 || !active || turn.isComplete) {
      if (status !== undefined || index !== turns.length - 1 || turn.isComplete)
        completeTurn(turn);
      else {
        turn.isWorking = false;
        for (const tool of turn.toolCalls) tool.isRunning = false;
      }
    } else {
      turn.isWorking = true;
    }
  }
}

function findTool(turns: ReducedTurn[], id: string): ToolCallState | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const tool = turns[index].toolCalls.find((candidate) => candidate.id === id);
    if (tool) return tool;
  }
  return undefined;
}

export function reduceTurns(
  events: DesktopConsoleEvent[],
  status?: DesktopConsoleSessionStatus,
): ReducedTurn[] {
  let turns: ReducedTurn[] = [];
  let current: ReducedTurn | undefined;
  let eventStatus: DesktopConsoleSessionStatus | undefined;
  let separateReasoning = false;
  const ensureTurn = (sequence: number) => {
    if (!current) {
      current = createTurn(`leading-${sequence}`, "", sequence);
      turns.push(current);
    }
    return current;
  };

  for (const event of events) {
    switch (event.type) {
      case "session": {
        eventStatus = event.session.status;
        break;
      }
      case "snapshot": {
        turns = reduceConversation(event.snapshot);
        current = turns[turns.length - 1];
        eventStatus = event.snapshot.session.status;
        break;
      }
      case "clear": {
        turns = [];
        current = undefined;
        break;
      }
      case "user": {
        if (current && !current.isComplete) completeTurn(current);
        current = createTurn(`turn-${event.sequence}`, event.text, event.sequence);
        current.startedAt = event.occurredAt;
        current.user.attachments = event.attachments;
        if (event.author) current.user.author = event.author;
        turns.push(current);
        break;
      }
      case "assistant-delta": {
        const turn = ensureTurn(event.sequence);
        if (!turn.isComplete) { turn.assistantText += event.text; appendTextSegment(turn, "assistant", event.text); }
        break;
      }
      case "reasoning-delta": {
        const turn = ensureTurn(event.sequence);
        if (event.text) {
          if (separateReasoning && turn.reasoningText && !turn.reasoningText.endsWith("\n\n")) turn.reasoningText += "\n\n";
          turn.reasoningText += event.text;
          appendTextSegment(turn, "reasoning", event.text);
          separateReasoning = false;
        }
        break;
      }
      case "tool-start": {
        separateReasoning = true;
        const turn = ensureTurn(event.sequence);
        const id = event.call.id ?? `tool-${event.sequence}`;
        const existing = turn.toolCalls.find((tool) => tool.id === id);
        if (existing) {
          existing.name = event.call.name;
          existing.arguments = event.call.arguments;
        } else {
          turn.toolCalls.push({
            id,
            name: event.call.name,
            arguments: event.call.arguments,
            isRunning: true,
          });
        }
        appendToolSegment(turn, id);
        break;
      }
      case "tool-result": {
        const turn = ensureTurn(event.sequence);
        const tool = event.call.id
          ? findTool(turns, event.call.id)
          : turn.toolCalls.find(
              (candidate) => candidate.name === event.call.name && candidate.isRunning,
            );
        if (tool) {
          tool.result = event.result;
          tool.isRunning = false;
        } else {
          // A retained journal may start after tool-start; retain its full output.
          turn.toolCalls.push({
            id: event.call.id ?? `tool-${event.sequence}`,
            name: event.call.name,
            arguments: event.call.arguments,
            result: event.result,
            isRunning: false,
          });
          appendToolSegment(turn, event.call.id ?? `tool-${event.sequence}`);
        }
        break;
      }
      case "usage": {
        ensureTurn(event.sequence).usage = event.usage;
        break;
      }
      case "notice": {
        ensureTurn(event.sequence).notices.push(event.text);
        break;
      }
      case "decision": {
        const turn = ensureTurn(event.sequence);
        const decision = turn.decisions.find((candidate) => candidate.id === event.decision.id);
        if (decision) Object.assign(decision, event.decision);
        else turn.decisions.push({ ...event.decision, resolved: false });
        break;
      }
      case "decision-resolved": {
        for (let index = turns.length - 1; index >= 0; index--) {
          const decision = turns[index].decisions.find(
            (candidate) => candidate.id === event.decisionId,
          );
          if (decision) {
            decision.resolved = true;
            decision.approved = event.approved;
            break;
          }
        }
        break;
      }
      case "turn-complete": {
        ensureTurn(event.sequence).endedAt = event.occurredAt;
        applyOutcome(ensureTurn(event.sequence), event);
        break;
      }
      case "error": {
        const turn = ensureTurn(event.sequence);
        if (turn.error === undefined) turn.error = event.message;
        break;
      }
      // Worker, queue, state, harness and compaction events have separate views.
    }
  }

  reconcileStatus(turns, status ?? eventStatus);
  return turns;
}

// Join a retained partial stream to already committed text without replaying the
// overlapping suffix. The prefix table keeps this linear for large responses.
function appendStreamedText(committed: string, streamed: string): string {
  if (!streamed || committed.startsWith(streamed) || committed.endsWith(streamed)) return committed;
  if (!committed || streamed.startsWith(committed)) return streamed;
  const prefixes = new Uint32Array(streamed.length);
  for (let index = 1, matched = 0; index < streamed.length; index++) {
    while (matched > 0 && streamed[index] !== streamed[matched])
      matched = prefixes[matched - 1];
    if (streamed[index] === streamed[matched]) matched++;
    prefixes[index] = matched;
  }
  let overlap = 0;
  for (let index = 0; index < committed.length; index++) {
    while (overlap > 0 && (overlap === streamed.length || committed[index] !== streamed[overlap]))
      overlap = prefixes[overlap - 1];
    if (committed[index] === streamed[overlap]) overlap++;
  }
  return committed + streamed.slice(overlap);
}

function mergeTurnSegments(turn: ReducedTurn, entry: ReducedTurn, matchedTools: Map<ToolCallState, ToolCallState>) {
  const canonicalIds = new Map(entry.toolCalls.map(tool => [tool.id, matchedTools.get(tool)?.id ?? tool.id]));
  const incoming: TurnSegment[] = (entry.segments ?? []).map(segment => segment.type === "tools"
    ? { type: "tools", toolIds: segment.toolIds.map(id => canonicalIds.get(id) ?? id) }
    : { ...segment });
  const segments = turn.segments ??= [];
  const incomingIds = new Set(incoming.flatMap(segment => segment.type === "tools" ? segment.toolIds : []));
  const savedIds = segments.flatMap(segment => segment.type === "tools" ? segment.toolIds : []);
  // Some providers emit tool events but no assistant deltas. Their turn-complete
  // aggregate has no chronological boundaries; committed native messages do.
  const nativeTextAgrees = alignAssistantSegments(segments, entry.assistantText);
  // A journal retaining the operator's turn start is the complete chronology.
  // A partial journal instead updates its anchored suffix in committed history.
  if (!nativeTextAgrees && !entry.id.startsWith("leading-") && savedIds.every(id => incomingIds.has(id)) && entry.assistantText.startsWith(turn.assistantText)) {
    turn.segments = incoming;
    return;
  }
  const firstAnchor = incoming.findIndex(segment => segment.type === "tools" && segments.some(saved => saved.type === "tools" && saved.toolIds.some(id => segment.toolIds.includes(id))));
  let cursor = entry.id.startsWith("leading-") && firstAnchor < 0 ? segments.length : 0;
  for (let index = 0; index < incoming.length; index++) {
    const segment = incoming[index];
    if (segment.type === "tools") {
      const anchor = segments.findLastIndex(saved => saved.type === "tools" && saved.toolIds.some(id => segment.toolIds.includes(id)));
      if (anchor >= 0) {
        const saved = segments[anchor];
        const existingIds = new Set(segments.flatMap(item => item.type === "tools" ? item.toolIds : []));
        if (saved.type === "tools") for (const id of segment.toolIds) if (!existingIds.has(id)) saved.toolIds.push(id);
        cursor = anchor + 1;
      } else {
        segments.splice(cursor++, 0, segment);
      }
      continue;
    }
    if (nativeTextAgrees && segment.type === "assistant") {
      const anchor = segments.findIndex((saved, index) => index >= cursor && saved.type === "assistant" && saved.text.includes(segment.text));
      if (anchor >= 0) cursor = anchor + 1;
      continue;
    }
    const nextTools = incoming.slice(index + 1).find(item => item.type === "tools");
    const nextAnchor = nextTools?.type === "tools" ? segments.findIndex(saved => saved.type === "tools" && saved.toolIds.some(id => nextTools.toolIds.includes(id))) : -1;
    const end = nextAnchor >= cursor ? nextAnchor : segments.length;
    let match = -1;
    for (let candidate = cursor; candidate < end; candidate++) {
      const saved = segments[candidate];
      if (saved.type !== segment.type) continue;
      const merged = appendStreamedText(saved.text, segment.text);
      if (merged.length < saved.text.length + segment.text.length) { match = candidate; break; }
    }
    if (match >= 0) {
      const saved = segments[match];
      if (saved.type !== "tools") saved.text = appendStreamedText(saved.text, segment.text);
      cursor = match + 1;
    } else {
      segments.splice(cursor++, 0, segment);
    }
  }
}

export function reduceConversation(snapshot: ConsoleSessionSnapshot): ReducedTurn[] {
  const turns: ReducedTurn[] = [];
  let current: ReducedTurn | undefined;
  const ensureTurn = (index: number) => {
    if (!current) {
      current = createTurn(`leading-message-${index}`, "", index);
      turns.push(current);
    }
    return current;
  };

  for (let index = 0; index < snapshot.messages.length; index++) {
    const message = snapshot.messages[index];
    let text = "";
    let hasText = false;
    for (const block of message.content) {
      if (block.type === "text") {
        hasText = true;
        text += block.text;
      }
    }
    // Tool results are carried in user-role messages, but are not user input.
    if (message.role === "user" && (hasText || message.content.some(block => block.type === "image"))) {
      if (current) completeTurn(current);
      current = createTurn(`message-${index}`, text, index);
      if (message.author) current.user.author = message.author;
      current.user.attachments = message.content.flatMap(block => block.type === "image" ? [{ kind: "image" as const, value: `data:${block.mediaType};base64,${block.data}`, name: block.name }] : []);
      turns.push(current);
    } else if (message.role === "assistant" && hasText) {
      ensureTurn(index).assistantText += text;
    }
    for (const block of message.content) {
      if (message.role === "assistant" && block.type === "text") {
        appendTextSegment(ensureTurn(index), "assistant", block.text);
      } else if (block.type === "tool_use") {
        const turn = ensureTurn(index);
        const tool = turn.toolCalls.find((candidate) => candidate.id === block.id);
        if (tool) {
          tool.name = block.name;
          tool.arguments = block.input;
        } else {
          turn.toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input,
            isRunning: true,
          });
        }
        appendToolSegment(turn, block.id);
      } else if (block.type === "tool_result") {
        const result = block.is_error ? { content: block.content, is_error: true } : block.content;
        const tool = findTool(turns, block.tool_use_id);
        if (tool) {
          tool.result = result;
          tool.isRunning = false;
        } else {
          ensureTurn(index).toolCalls.push({
            id: block.tool_use_id,
            name: block.tool_use_id,
            arguments: null,
            result,
            isRunning: false,
          });
          appendToolSegment(ensureTurn(index), block.tool_use_id);
        }
      }
    }
  }

  const journal = reduceTurns(snapshot.events, snapshot.session.status);
  if (turns.length === 0) {
    turns.push(...journal);
  } else {
    const matches = new Map<ReducedTurn, ReducedTurn>();
    const toolTurns = new Map<string, ReducedTurn>();
    for (const turn of turns)
      for (const tool of turn.toolCalls) toolTurns.set(tool.id, turn);
    let before = turns.length;
    // Match newest first so repeated user prompts still align with their turn.
    for (let index = journal.length - 1; index >= 0; index--) {
      const entry = journal[index];
      if (!entry.id.startsWith("leading-")) {
        for (let candidate = before - 1; candidate >= 0; candidate--) {
          const turn = turns[candidate];
          if (!turn.id.startsWith("leading-") && turn.user.text === entry.user.text) {
            matches.set(entry, turn);
            before = candidate;
            break;
          }
        }
      }
      if (!matches.has(entry)) {
        for (const tool of entry.toolCalls) {
          const turn = toolTurns.get(tool.id);
          if (turn) {
            matches.set(entry, turn);
            break;
          }
        }
      }
    }
    for (let index = 0; index < journal.length; index++) {
      const entry = journal[index];
      if (matches.has(entry) || !entry.id.startsWith("leading-")) continue;
      let nextTurn: ReducedTurn | undefined;
      for (let next = index + 1; next < journal.length && !nextTurn; next++)
        nextTurn = matches.get(journal[next]);
      const nextIndex = nextTurn ? turns.indexOf(nextTurn) : turns.length;
      if (nextIndex === 0) {
        turns.unshift(entry);
        matches.set(entry, entry);
      } else {
        matches.set(entry, turns[nextIndex - 1]);
      }
    }
    for (const entry of journal) {
      const turn = matches.get(entry);
      if (!turn || turn === entry) continue;
      if (!entry.id.startsWith("leading-")) {
        turn.id = entry.id;
        turn.user.sequence = entry.user.sequence;
        if (entry.user.author) turn.user.author = entry.user.author;
        if (entry.user.attachments) turn.user.attachments = entry.user.attachments;
      }
      turn.startedAt = entry.startedAt ?? turn.startedAt;
      turn.endedAt = entry.endedAt ?? turn.endedAt;
      turn.reasoningText += entry.reasoningText;
      turn.notices.push(...entry.notices);
      if (entry.usage) turn.usage = entry.usage;
      if (entry.error !== undefined) turn.error = entry.error;
      for (const decision of entry.decisions) {
        const existing = turn.decisions.find((candidate) => candidate.id === decision.id);
        if (existing) Object.assign(existing, decision);
        else turn.decisions.push(decision);
      }
      // Native history uses provider call IDs; live events may use gateway IDs.
      // Match occurrences one-to-one, newest first for a truncated event journal.
      // Never collapse repeated calls within either source.
      const matchedTools = new Map<ToolCallState, ToolCallState>();
      const available = new Set(turn.toolCalls);
      const journalIds = new Set(entry.toolCalls.map(tool => tool.id));
      for (const tool of [...entry.toolCalls].reverse()) {
        const exact = turn.toolCalls.find(candidate => candidate.id === tool.id);
        const existing = exact ?? [...available].reverse().find(candidate =>
          !journalIds.has(candidate.id) && candidate.name === tool.name &&
          JSON.stringify(candidate.arguments) === JSON.stringify(tool.arguments));
        if (existing) {
          matchedTools.set(tool, existing);
          available.delete(existing);
        }
      }
      for (const tool of entry.toolCalls) {
        const existing = matchedTools.get(tool);
        if (existing) {
          existing.name = tool.name;
          existing.arguments = tool.arguments;
          if (tool.result !== undefined) existing.result = tool.result;
          existing.isRunning = existing.result === undefined && tool.isRunning;
        } else {
          turn.toolCalls.push(tool);
        }
      }
      mergeTurnSegments(turn, entry, matchedTools);
      if (entry.stopReason !== undefined) {
        reconcileAssistantSegments(turn, entry.assistantText);
        turn.assistantText = entry.assistantText;
        turn.budget = entry.budget;
        turn.stopReason = entry.stopReason;
        turn.outputCap = entry.outputCap;
        completeTurn(turn);
      } else if (!turn.isComplete) {
        turn.assistantText = appendStreamedText(turn.assistantText, entry.assistantText);
      }
    }
  }

  current = turns[turns.length - 1];
  if (snapshot.lastOutcome) {
    if (!current) {
      current = createTurn(`leading-outcome-${snapshot.cursor}`, "", snapshot.cursor);
      turns.push(current);
    }
    applyOutcome(current, snapshot.lastOutcome);
  }
  for (const pending of snapshot.pendingDecisions) {
    let decision: DecisionState | undefined;
    for (let index = turns.length - 1; index >= 0 && !decision; index--)
      decision = turns[index].decisions.find((candidate) => candidate.id === pending.id);
    if (decision) Object.assign(decision, pending, { resolved: false, approved: undefined });
    else {
      if (!current) {
        current = createTurn(`leading-decision-${snapshot.cursor}`, "", snapshot.cursor);
        turns.push(current);
      }
      current.decisions.push({ ...pending, resolved: false });
    }
  }
  reconcileStatus(turns, snapshot.session.status);
  return turns;
}
