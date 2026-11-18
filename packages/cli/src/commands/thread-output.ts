/** How a thread is shown in a terminal: one line for a list, the last reply for a read, the reply alone after --wait. */
export type Json = Record<string, unknown>;
export const asJson = (value: unknown): Json => (value && typeof value === "object" ? value as Json : {});

export function lastAssistantText(snapshot: Json): string | undefined {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Json[] : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = (message.content as Json[]).filter(block => block.type === "text").map(block => String(block.text)).join("\n").trim();
    if (text) return text;
  }
  return undefined;
}

export function sessionLine(session: Json): string {
  return [session.id, session.status, session.title ? `"${String(session.title)}"` : undefined, session.workspacePath].filter(Boolean).join("  ");
}

const costText = (usage: Json): string => typeof usage.costUsd === "number" ? `$${usage.costUsd.toFixed(4)}${usage.costUnavailable ? "+ (some pricing unknown)" : ""}` : "unknown";
export const usageLine = (usage: Json): string => `Usage: ${String(usage.inputTokens ?? 0)} input tokens, ${String(usage.outputTokens ?? 0)} output tokens, cost ${costText(usage)}`;

export interface FinishedThread { session: Json; usage: Json; reply?: string; verification?: Json; error?: string; failed: boolean; claimBlocked: boolean }

/** What a settled snapshot says: the reply, whether the turn failed and why. */
export function finishedThread(snapshot: Json): FinishedThread {
  const session = asJson(snapshot.session);
  const usage = asJson(snapshot.usage);
  const outcome = asJson(snapshot.lastOutcome);
  const reply = lastAssistantText(snapshot);
  const verification = outcome.verification === undefined ? undefined : asJson(outcome.verification);
  const error = session.costCeilingExceeded ? `Stopped at the $${String(session.costCeilingUsd)} cost ceiling.` : typeof outcome.error === "string" ? outcome.error : undefined;
  const failed = session.status === "failed" || session.lastTurnFailed === true || session.costCeilingExceeded === true || Boolean(outcome.error);
  return { session, usage, ...(reply ? { reply } : {}), ...(verification ? { verification } : {}), ...(error ? { error } : {}), failed, claimBlocked: verification?.claimBlocked === true };
}

/** `0 threads show`: the header line, the last reply, then usage. */
export function threadText(snapshot: Json): string {
  const done = finishedThread(snapshot);
  const verified = typeof done.verification?.line === "string" ? done.verification.line : undefined;
  return [sessionLine(done.session), done.reply ? `\n${done.reply}` : "", verified ? `\n${verified}` : "", done.error ? `\nError: ${done.error}` : "", `\n${usageLine(done.usage)}`].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * After --wait: stdout carries only the answer (and the verification line), so a calling model or script reads it directly.
 * The thread id, any error and the usage go to stderr; --format json prints everything on stdout.
 */
export function printWaited(io: { out(text: string): void; err(text: string): void }, json: boolean | undefined, done: FinishedThread): void {
  if (json) {
    io.out(JSON.stringify({ session: done.session, usage: done.usage, ...(done.reply ? { reply: done.reply } : {}), ...(done.verification ? { verification: done.verification } : {}), ...(done.error ? { error: done.error } : {}) }, null, 2));
    return;
  }
  const verified = typeof done.verification?.line === "string" ? done.verification.line : undefined;
  const answer = [done.reply, verified].filter(Boolean).join("\n\n");
  if (answer) io.out(answer);
  io.err(`thread ${String(done.session.id)} ${String(done.session.status)}${done.error ? `\nError: ${done.error}` : ""}\n${usageLine(done.usage)}`);
}

/** Has the thread stopped working on a turn? */
export const isSettled = (session: Json): boolean => !["working", "cancelling"].includes(String(session.status));

export async function waitUntilSettled(read: () => Promise<Json>, sleep: () => Promise<void>, timeoutSeconds: number, id: string): Promise<Json> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const snapshot = await read();
    if (isSettled(asJson(snapshot.session))) return snapshot;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutSeconds}s; thread ${id} is still ${String(asJson(snapshot.session).status)}. Read it later with \`0 threads show ${id}\`.`);
    await sleep();
  }
}

