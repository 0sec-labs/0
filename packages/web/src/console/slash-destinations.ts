/** Slash commands that simply navigate to another page. */
export const SLASH_DESTINATIONS: Record<string, string> = {
  onboard: "/onboarding",
  capabilities: "/tools",
  tools: "/tools",
  settings: "/settings",
  keybindings: "/settings",
  theme: "/settings",
  connect: "/connections",
  model: "/models",
  history: "/runs",
  findings: "/findings",
  launcher: "/audits",
  ops: "/dashboard",
  skills: "/plugins/skills",
  plugins: "/plugins",
  scope: "/project",
  doctor: "/doctor",
  fix: "/fix",
};

/** Prompt sent by `/explain`; topic is optional. */
export function explainPrompt(topic: string | undefined): string {
  const subject = topic ? `Explain "${topic}"` : "Explain your previous result";
  return `${subject} like I am five years old. Use 3–5 very short sentences, mostly under 12 words each. Use familiar everyday words and one simple comparison. No jargon, acronyms, code, headings, or baby talk. Say what happened, why it matters, and one thing to do next. Keep the facts accurate and say plainly what is not yet confirmed. Explain only; do not run new tests or tools.`;
}
