/** Curated release notes for the What's new dialog, newest first. Plain words; the first entry must match the app version (releases.test.ts). */
export type LucideIconName = "Palette" | "Laptop" | "Puzzle" | "ShieldCheck" | "KeyRound" | "Gauge" | "RefreshCw" | "Accessibility" | "Wrench" | "Plug" | "Cloud" | "ListChecks" | "ShieldAlert" | "Bug";

export interface ReleaseHighlight { icon: LucideIconName; title: string; text: string }
export interface Release { version: string; date: string; title: string; summary: string; image?: string; highlights: ReleaseHighlight[] }

export const RELEASES_URL = "https://github.com/0sec-labs/0security/releases";

export const RELEASES: readonly Release[] = [
  {
    version: "0.29.0",
    date: "2026-11-14",
    title: "A new look",
    summary: "A calmer console in the Capy style, with Themes, Computers and a skills directory.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "Palette", title: "New look and Themes", text: "The console follows the Capy style with a neutral accent. Pick a Theme, or switch back to orange, in Settings." },
      { icon: "Laptop", title: "Computers and Sentinels", text: "Connect and manage the machines missions run on, and start from ten Sentinel presets such as Fix Engineer and Secrets Hunter." },
      { icon: "Puzzle", title: "Skills: Installed and Explore", text: "Browse a GitHub skills directory, preview a skill, and add it at a pinned version." },
      { icon: "Gauge", title: "Smoother everyday use", text: "Recommended models, key checks when you connect, visible retries on rate limits, and fixes for deleting and retrying missions." },
    ],
  },
  {
    version: "0.28.11",
    date: "2026-11-13",
    title: "Safer parallel work",
    summary: "Parallel workers no longer step on each other, and model costs are more accurate.",
    highlights: [
      { icon: "ShieldCheck", title: "Protected shared checkouts", text: "Workers that run side by side can read the same project without overwriting each other's changes." },
      { icon: "Gauge", title: "Accurate model prices", text: "Together models keep their own prices, and incomplete usage receipts are rejected instead of guessed." },
      { icon: "RefreshCw", title: "Reliable live reload", text: "Development servers reload on the ports you choose and shut down cleanly when you stop them." },
      { icon: "Wrench", title: "Security updates", text: "Hono and its Node server adapter are updated for current security advisories." },
    ],
  },
  {
    version: "0.28.10",
    date: "2026-11-10",
    title: "Together AI and custom models",
    summary: "Connect Together AI and pick custom models from a list.",
    highlights: [
      { icon: "Cloud", title: "Together AI", text: "Connect Together AI with its own credentials and discover its models, including free ones." },
      { icon: "ListChecks", title: "Pick custom models", text: "After connecting an OpenAI-compatible service, choose a model from a dropdown. You can still type an ID by hand." },
      { icon: "Plug", title: "Claude Code tools", text: "Claude Code can use 0's tools through a private local bridge, without duplicate calls." },
      { icon: "Bug", title: "Fewer glitches", text: "Model lists follow the current key and endpoint, and force-stopping a mission keeps your history." },
    ],
  },
];

/** Release notes for the running app, if the newest entry matches the version. */
export const LATEST_RELEASE: Release = RELEASES[0]!;
