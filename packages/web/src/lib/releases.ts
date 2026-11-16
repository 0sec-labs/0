/** Curated release notes for the What's new dialog, newest first. Plain words; the first entry must match the app version (releases.test.ts). */
export type LucideIconName = "Palette" | "Laptop" | "Puzzle" | "ShieldCheck" | "KeyRound" | "Gauge" | "RefreshCw" | "Accessibility" | "Wrench" | "Plug" | "Cloud" | "ListChecks" | "ShieldAlert" | "Bug";

export interface ReleaseHighlight { icon: LucideIconName; title: string; text: string }
export interface Release { version: string; date: string; title: string; summary: string; image?: string; highlights: ReleaseHighlight[] }

export const RELEASES_URL = "https://github.com/0sec-labs/0security/releases";

export const RELEASES: readonly Release[] = [
  {
    version: "0.37.0",
    date: "2026-11-16",
    title: "Verified means checked",
    summary: "A fix is only called Verified when 0 ran a check for it, the Findings board is back, and the sidebar, Skills page and docs are simpler.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ShieldCheck", title: "Verified means checked", text: "A skill can declare a check that 0 runs in a container before anything is called Verified. Fixes and threads end with Verified by or Not verified, and the second-Agent check is now called Corroborated." },
      { icon: "ListChecks", title: "Findings board", text: "Switch Findings between List and Board and drag a finding between columns. The Agents list is back in the sidebar, next to a Threads toggle." },
      { icon: "Wrench", title: "Simpler and steadier", text: "The Skills page is a flat list with search, the docs are 12 pages, and many small errors are fixed, from raw reconnect messages to threads that kept the title New thread." },
    ],
  },
  {
    version: "0.36.0",
    date: "2026-11-15",
    title: "Extensions",
    summary: "Extensions replace plugins. They connect 0 to your tools and services: GitHub, MCP servers and rules like scope. Each is pinned to a commit, with one decision point before every command.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "Puzzle", title: "Extensions", text: "Add an extension pinned to a commit with 0 skills add <repo>@<sha>. A prompt shows what it can do and the diff on update, and the new Extensions page replaces Explore." },
      { icon: "ShieldCheck", title: "Safer MCP servers and scope", text: "MCP servers live inside extensions and start on demand, every tool is pinned and blocked until you approve a change, and scope is on by default whenever a scope is set." },
      { icon: "Plug", title: "Plugins are gone", text: "The old plugin system, its registry and self_extend are removed. Installed plugins are kept disabled and imported once, and GitHub is now a built-in connector." },
    ],
  },
  {
    version: "0.35.0",
    date: "2026-11-15",
    title: "Nine commands, one mode",
    summary: "The CLI is down to nine commands, 0 opens the console, and Threads and Agents have shell access with a small core tool list.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ListChecks", title: "Nine commands", text: "Run 0 to open the console. scan, findings, threads, agents, skills, memory, models, computers and config cover the rest, and old commands still work for one release with a short moved note." },
      { icon: "ShieldCheck", title: "One mode with shell access", text: "Read-only and Can make changes are gone. Scope, budget, the sandbox and the Ask before running commands setting limit what Threads and Agents can do." },
      { icon: "Gauge", title: "Faster and steadier", text: "0 --version starts in about 0.15 seconds, Threads and Agents load a small core tool list, and a long-running console no longer fails every call after heavy use." },
    ],
  },
  {
    version: "0.34.0",
    date: "2026-11-15",
    title: "Updates that finish themselves",
    summary: "The console can update and restart itself, pull request Agents react to GitHub straight away in server mode, and plugin reviews show which tools changed.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "RefreshCw", title: "Update and restart in one click", text: "The Update available card downloads, checks and installs the new version, then restarts and reconnects by itself. With Updates set to Automatic it installs in the background once nothing is running." },
      { icon: "Cloud", title: "Faster pull request Agents", text: "In server mode, GitHub can tell 0 about a new pull request the moment it opens, so an Agent starts reviewing without waiting for the next check." },
      { icon: "ShieldCheck", title: "See what changed in a plugin", text: "Reviewing a plugin update marks each tool as Changed, New or Removed, and four unused enterprise hooks are gone." },
    ],
  },
  {
    version: "0.33.0",
    date: "2026-11-15",
    title: "Two kinds of access",
    summary: "Threads, Agents, automations and scans are now Read-only or Can make changes, and asking first is one global setting.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ShieldCheck", title: "Two kinds of access: Read-only or Can make changes", text: "Agents and threads that asked first now follow one setting, Ask before running commands, which is off by default. Turn it on in Settings to keep confirmations." },
      { icon: "Wrench", title: "The same choice in the CLI", text: "Use --access read-only or --access changes on 0 agents create, 0 threads start and 0 lab console. The old flags still work." },
      { icon: "ListChecks", title: "Nothing is lost on upgrade", text: "Saved Threads, Agents and automations still load, and the first start shows one note in Settings > Helpers that you can dismiss." },
    ],
  },
  {
    version: "0.32.0",
    date: "2026-11-15",
    title: "Simpler approvals, calmer Threads",
    summary: "Threads run commands without asking by default, slash commands match the CLI, and the sidebar has seven items.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ShieldCheck", title: "Simpler approvals", text: "Threads and Agents run commands automatically. One setting, Ask before running commands, turns the questions back on. Agents are Read-only, Can run commands or Can open pull requests." },
      { icon: "Wrench", title: "Slash commands match the CLI", text: "/threads list, /findings list and /config get work like their 0 commands, and the old names still work." },
      { icon: "ListChecks", title: "A calmer Thread", text: "One shimmer for the live work, one row per call, clear messages when a send fails or a reply comes back empty." },
      { icon: "Palette", title: "Seven sidebar items", text: "Skills has its own page with Installed and Browse, real brand logos appear on Explore, and the Findings board drops cards where you let go." },
    ],
  },
  {
    version: "0.31.0",
    date: "2026-11-14",
    title: "Threads, Agents and a leaner CLI",
    summary: "Missions are now Threads, Sentinels are now Agents, and the CLI has 14 commands.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ListChecks", title: "Threads and Agents", text: "Missions are now Threads and Sentinels are now Agents. The old CLI names still work, and Memory has its name back." },
      { icon: "Wrench", title: "A leaner CLI", text: "14 top-level commands now cover threads, agents, automation, models, skills, memory and plugins, with the old names kept as aliases." },
      { icon: "KeyRound", title: "Connections that tell the truth", text: "A model shows Key rejected when its key does not work, and a failed message offers a working model to switch to." },
      { icon: "Cloud", title: "Run it on a server", text: "An experimental single-node server mode, a Docker image that serves the console, and anonymous usage and crash reports you can turn off." },
    ],
  },
  {
    version: "0.30.0",
    date: "2026-11-14",
    title: "Simpler navigation, GitHub sign-in",
    summary: "A shorter sidebar, a Models page, a guided GitHub connection and ready-made Automations.",
    image: "/releases/0.29.0.jpg",
    highlights: [
      { icon: "ListChecks", title: "A shorter sidebar", text: "New mission, Findings, Automations and Explore, with Skills and Plugins inside Explore and Lessons under More." },
      { icon: "KeyRound", title: "Connect GitHub your way", text: "Reuse your GitHub CLI login, sign in with a code, or follow a guided token. You see what permissions are missing." },
      { icon: "Wrench", title: "Eight Automations to start from", text: "Pick a starting point such as a code review or a secrets check. Code reviews use your current folder." },
      { icon: "Cloud", title: "One Models page", text: "Providers and models live together at Models, and a switch hides cost and usage if you prefer." },
    ],
  },
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
      { icon: "ShieldCheck", title: "Protected shared checkouts", text: "Workers that run side by side can read the same folder without overwriting each other's changes." },
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
