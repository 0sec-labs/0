export function needsProviderSignIn(message: string): boolean {
  return /(?:HTTP|API error|status(?: code)?)\s*[:=]?\s*401\b|unauthorized|authentication[_ ](?:error|fail)|invalid[_ ]api[_ ]key|(?:Codex|ChatGPT).*(?:sign in|expired)/i.test(message);
}
export function consoleErrorMessage(message: string): string {
  if (!needsProviderSignIn(message)) return message;
  if (/Codex|ChatGPT/i.test(message)) return "Your ChatGPT connection needs attention. Sign in again in Connections, then retry your message.";
  const provider = /DeepSeek|Anthropic|OpenAI|OpenRouter|Gemini|Google/i.exec(message)?.[0];
  return `Your ${provider ? `${provider} ` : ""}connection needs attention. Update the connection in Settings, then retry your message.`;
}
