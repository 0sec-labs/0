import type {
  ConsoleSessionSnapshot,
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

export interface ReducedTurn {
  id: string;
  user: { text: string; sequence: number };
  assistantText: string;
  reasoningText: string;
  toolCalls: ToolCallState[];
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
    decisions: [],
    notices: [],
    isComplete: false,
    isWorking: false,
  };
}

function completeTurn(turn: ReducedTurn) {
  turn.isComplete = true;
  turn.isWorking = false;
  for (const decision of turn.decisions) decision.resolved = true;
  for (const tool of turn.toolCalls) tool.isRunning = false;
}

function applyOutcome(turn: ReducedTurn, outcome: ConsoleTurnOutcome) {
  // Final text is authoritative, including an intentionally empty response.
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
        turns.push(current);
        break;
      }
      case "assistant-delta": {
        const turn = ensureTurn(event.sequence);
        if (!turn.isComplete) turn.assistantText += event.text;
        break;
      }
      case "reasoning-delta": {
        ensureTurn(event.sequence).reasoningText += event.text;
        break;
      }
      case "tool-start": {
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
    if (message.role === "user" && hasText) {
      if (current) completeTurn(current);
      current = createTurn(`message-${index}`, text, index);
      turns.push(current);
    } else if (message.role === "assistant" && hasText) {
      ensureTurn(index).assistantText += text;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
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
      }
      turn.reasoningText += entry.reasoningText;
      turn.notices.push(...entry.notices);
      if (entry.usage) turn.usage = entry.usage;
      if (entry.error !== undefined) turn.error = entry.error;
      for (const decision of entry.decisions) {
        const existing = turn.decisions.find((candidate) => candidate.id === decision.id);
        if (existing) Object.assign(existing, decision);
        else turn.decisions.push(decision);
      }
      for (const tool of entry.toolCalls) {
        const existing = turn.toolCalls.find((candidate) => candidate.id === tool.id);
        if (existing) {
          existing.name = tool.name;
          existing.arguments = tool.arguments;
          if (tool.result !== undefined) existing.result = tool.result;
          existing.isRunning = existing.result === undefined && tool.isRunning;
        } else {
          turn.toolCalls.push(tool);
        }
      }
      if (entry.stopReason !== undefined) {
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
