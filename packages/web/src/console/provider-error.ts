import { v } from "@/lib/vocabulary";
import { isModelDisabledText, mapErrorText } from "@/lib/api-error";
/** The selected model is turned off in Connections. */
export const needsModelEnabled = isModelDisabledText;
/** Relay transport/lease failures are separate from the provider account login. */
export function needsModelSourceReconnect(message: string): boolean {
  return /provider relay (?:grant )?(?:expired|closed|unavailable)|provider relay grant expired|reconnect (?:the |your )?local model source|local model (?:source|connection).*(?:lost|expired|closed|unavailable)|relay.*\bremote_timeout\b/i.test(message);
}
export function needsProviderSignIn(message: string): boolean {
  if (needsModelSourceReconnect(message)) return false;
  return /(?:HTTP|API error|status(?: code)?)\s*[:=]?\s*40[13]\b|unauthorized|authentication[_ ](?:error|fail)|invalid[_ ]api[_ ]key|(?:Codex|ChatGPT).*(?:sign in|(?:OAuth|token|credentials?|session) (?:has |have )?expired)/i.test(message);
}
export type RunErrorKind =
  | "model-source" | "sign-in" | "model-disabled" | "model-unavailable" | "folder" | "context"
  | "rate-limit" | "provider-busy" | "timeout" | "network" | "send" | "rejected" | "other";

export interface RunError {
  kind: RunErrorKind;
  /** Plain sentence for the screen: what happened, what is kept, what to do next. Never a raw provider payload. */
  message: string;
  /** Another attempt with the same message and model can succeed. */
  retryable: boolean;
}

const KEPT = "Your progress is kept.";

/**
 * The one classifier for a failed run or send. The first matching class wins, ordered from "you must change something"
 * (connection, model, folder, size) to "just try again" (limits, outages, drops). Unrecognised first-party text passes
 * through mapErrorText unchanged; anything that looks like a raw provider payload gets the generic rejected message.
 */
export function classifyRunError(message: string): RunError {
  const result = (kind: RunErrorKind, text: string, retryable: boolean): RunError => ({ kind, message: text, retryable });
  if (needsModelSourceReconnect(message)) return result("model-source", v("This {mission} lost its connection to your local model source. Reconnect it, then retry your message."), false);
  if (needsProviderSignIn(message)) {
    if (/Codex|ChatGPT/i.test(message)) return result("sign-in", "Your ChatGPT connection needs attention. Sign in again in Connections, then retry your message.", false);
    const provider = /DeepSeek|Anthropic|OpenAI(?!-compatible)|OpenRouter|Gemini|Google/i.exec(message)?.[0];
    return result("sign-in", `Your ${provider ? `${provider} ` : ""}connection needs attention. Update the connection in Settings, then retry your message.`, false);
  }
  if (isModelDisabledText(message)) return result("model-disabled", mapErrorText(message), false);
  if (/model[_ ]not[_ ]found|unknown model|no such model|model\b[^.]{0,60}\b(?:does not exist|not (?:found|available|supported))|\b404\b[^.]{0,60}\bmodel/i.test(message)) return result("model-unavailable", "This model isn't available on your connection. Pick another model from the model menu, then send again.", false);
  if (/out of scope|local scope|folder access|outside (?:the )?(?:allowed|approved) (?:folder|scope)|scope (?:violation|check|policy)/i.test(message)) return result("folder", v("0 can't use that folder yet. Allow it for this {mission}, then send again."), false);
  if (/context[ _-]?(?:length|window)|maximum context|prompt is too long|too many tokens|payload too large|request entity too large|\b413\b/i.test(message)) return result("context", `This ${v("{mission}")} is longer than the model can read. ${KEPT} Start a new ${v("{mission}")} or pick a model with a larger window.`, false);
  if (/\b429\b|rate[ _-]?limit|too many requests|quota|usage limit/i.test(message)) return result("rate-limit", "The model provider is rate limiting requests. Try again in a moment, or pick another model.", true);
  if (/\bstatus(?: code)?\s*[:=]?\s*5\d{2}\b|\bHTTP\s*5\d{2}\b|overloaded|server[ _]error|bad gateway|service unavailable/i.test(message)) return result("provider-busy", "The model provider is busy. Try again in a moment, or pick another model.", true);
  if (/timed? ?out|timeout|took too long/i.test(message)) return result("timeout", `The model took too long to answer. ${KEPT} Retry, or pick a faster model.`, true);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|fetch failed|network (?:error|request failed)|connection (?:was |has )?(?:lost|closed|reset|terminated|dropped)|stream (?:ended|closed|terminated|interrupted)|premature close|(?:request|stream|connection) terminated|terminated unexpectedly/i.test(message)) return result("network", `The connection to the model dropped. ${KEPT} Retry to continue.`, true);
  if (/failed to (?:send|submit|deliver)|(?:could not|couldn't|unable to|cannot|can't) (?:send|submit|deliver)/i.test(message)) return result("send", `Couldn't send your message to the model. ${KEPT} Retry, or pick another model if it keeps failing.`, true);
  if (/invalid[_ ]request|malformed|invalid (?:tool|function)|tool[_ ]call.*(?:invalid|malformed)|unprocessable|\b(?:400|422)\b|API error|\bstatus(?: code)?\s*[:=]?\s*\d{3}\b|\{["\s]|request_id|api[ _-]?key|bearer\s/i.test(message)) return result("rejected", `The model rejected this request. ${KEPT} Retry, or pick another model.`, true);
  return result("other", mapErrorText(message), true);
}

export function consoleErrorMessage(message: string): string {
  return classifyRunError(message).message;
}
