const SCREENS: Readonly<Record<string, readonly [string, string]>> = {
  launcher: ["＋", "New engagement"],
  home: ["＋", "New engagement"],
  ops: ["▦", "Operations"],
  doctor: ["✚", "Diagnostics"],
  history: ["◷", "Audit history"],
  findings: ["◇", "Findings"],
  finding: ["◇", "Finding details"],
  replay: ["▷", "Replay"],
  settings: ["⚙", "Settings"],
  harness: ["⌘", "Tools and permissions"],
  herd: ["♙", "Agents"],
  agents: ["♙", "Agents"],
  audits: ["▣", "Active audits"],
  market: ["⊞", "Marketplace"],
  connect: ["↗", "Connections"],
  onboard: ["✦", "Getting started"],
  onboarding: ["✦", "Getting started"],
  models: ["◈", "Models"],
  model: ["◈", "Models"],
  resume: ["◷", "Saved audits"],
  usage: ["▥", "Usage"],
  session: ["▣", "Engagement"],
  commands: ["⌘", "Commands"],
  shortcuts: ["⌨", "Keyboard shortcuts"],
};

/** Text glyphs, with labels always retained: no icon-font dependency. */
export function operatorIcon(screen: string): string {
  return SCREENS[screen.toLowerCase()]?.[0] ?? "◇";
}

export function operatorTitle(screen: string): string {
  return SCREENS[screen.toLowerCase()]?.[1] ?? screen;
}
