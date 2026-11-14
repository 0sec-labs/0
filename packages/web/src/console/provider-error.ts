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
  return /(?:HTTP|API error|status(?: code)?)\s*[:=]?\s*401\b|unauthorized|authentication[_ ](?:error|fail)|invalid[_ ]api[_ ]key|(?:Codex|ChatGPT).*(?:sign in|(?:OAuth|token|credentials?|session) (?:has |have )?expired)/i.test(message);
}
export function consoleErrorMessage(message: string): string {
  if (needsModelSourceReconnect(message)) return v("This {mission} lost its connection to your local model source. Reconnect it, then retry your message.");
  if (!needsProviderSignIn(message)) {
    const mapped = mapErrorText(message);
    // Raw provider payloads (status codes, JSON bodies, request ids, key fragments) never reach the screen.
    if (mapped === message && /API error|\bstatus(?: code)?\s*[:=]?\s*\d{3}\b|\{["\s]|request_id|api[ _-]?key|bearer\s/i.test(message)) return "The model request failed. Try again, or pick another model.";
    return mapped;
  }
  if (/Codex|ChatGPT/i.test(message)) return "Your ChatGPT connection needs attention. Sign in again in Connections, then retry your message.";
  const provider = /DeepSeek|Anthropic|OpenAI(?!-compatible)|OpenRouter|Gemini|Google/i.exec(message)?.[0];
  return `Your ${provider ? `${provider} ` : ""}connection needs attention. Update the connection in Settings, then retry your message.`;
}
