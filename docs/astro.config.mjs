import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import rehypeMermaid from "rehype-mermaid";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  site: "https://docs.0.security",
  redirects: {
    "/getting-started": "https://github.com/0sec-labs/0#quick-start",
    "/methodology": "/benchmark/",
  },
  // Allow previewing the dev server over Tailscale (dev-only; ignored by the static build).
  vite: {
    server: { allowedHosts: [".ts.net"] },
    plugins: [{
      name: "pagefind-main-thread",
      transform(code, id) {
        if (id !== "\0virtual:starlight/pagefind-config") return;
        // Pagefind 1.5.2 sends relative fetch URLs to a blob worker.
        // Keep Starlight's UI and use Pagefind's supported main-thread engine.
        return `${code};\npagefindUserConfig.noWorker = true;`;
      },
    }],
  },
  markdown: {
    // Render ```mermaid code blocks as SVG at build time.
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
    processor: unified({
      rehypePlugins: [
        [rehypeMermaid, { strategy: "img-svg", dark: true }],
      ],
    }),
  },
  integrations: [
    starlight({
      title: "0",
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://0.security", crossorigin: "anonymous" } },
      ],
      description:
        "Your multi-model, self-improving open-source cybersecurity team. Install 0, connect your models, hack & fix your systems. Research Preview.",
      logo: {
        dark: "./src/assets/0-wordmark-dark.svg",
        light: "./src/assets/0-wordmark-light.svg",
        alt: "0.security",
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/0sec-labs/0",
        },
        {
          icon: "external",
          label: "Website",
          href: "https://0.security/",
        },
      ],
      defaultLocale: "root",
      editLink: { baseUrl: "https://github.com/0sec-labs/0/edit/main/docs/" },
      components: {
        Header: "./src/components/DocsHeader.astro",
        Hero: "./src/components/DocsHero.astro",
        MobileMenuToggle: "./src/components/DocsMenuToggle.astro",
      },
      expressiveCode: {
        themes: ["github-dark", "github-light"],
      },
      sidebar: [
        {
          label: "Overview",
          slug: "index",
        },
        {
          label: "Get started",
          items: [
            { label: "Concepts", slug: "concepts" },
            { label: "Missions & settings", slug: "console" },
            { label: "Browser interface", slug: "web-interface" },
            { label: "Automations", slug: "automations" },
            { label: "Sentinels", slug: "sentinels" },
            { label: "Inline visualizations", slug: "visualizations" },
            { label: "Skills", slug: "skills" },
            { label: "Findings API", slug: "findings-api" },
            { label: "Engines & teams", slug: "engine-connections" },
            { label: "Scans", slug: "scans" },
            { label: "Scope & authorization", slug: "scope" },
            { label: "Recipes", slug: "recipes" },
            { label: "Code & binary analysis", slug: "code-and-binary-analysis" },
            { label: "Troubleshooting", slug: "troubleshooting" },
            { label: "Third-party notices", slug: "third-party-notices" },
          ],
        },
        {
          label: "Enterprise",
          items: [
            { label: "Platform direction", link: "/roadmap/#enterprise-platform" },
            { label: "CI integration", slug: "ci/github-action" },
          ],
        },
        {
          label: "Plugins",
          items: [
            { label: "Build a plugin", slug: "plugins" },
            { label: "Plugins: trust model", slug: "plugin-trust" },
            { label: "Plugin registry", link: "https://github.com/0sec-labs/hackstore" },
          ],
        },
        {
          label: "Self-evolving agents",
          items: [
            { label: "Overview", slug: "improvement-plane" },
            { label: "Executable plugin evolution", link: "/improvement-plane/#executable-plugin-evolution" },
            { label: "Live driver & UI contract", link: "/improvement-plane/#live-harness-component-contract" },
            { label: "Memory and learning", link: "/improvement-plane/#learning" },
            { label: "Autonomy & workspace trust", link: "/configuration/#self-extension-and-workspace-trust" },
            { label: "Long-horizon goals", link: "/improvement-plane/#long-horizon-self-evolution" },
            { label: "Integrations", slug: "integrations" },
            { label: "Docker image", slug: "docker" },
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { label: "CLI commands", slug: "commands" },
            { label: "Configuration", slug: "configuration" },
            { label: "API keys & BYOK", slug: "api-keys" },
            { label: "Budget management", slug: "budget-management" },
            { label: "White-box mode", slug: "white-box-mode" },
            { label: "GitHub CI", slug: "ci/github-action" },
          ],
        },
        {
          label: "Architecture & evidence",
          collapsed: true,
          items: [
            { label: "Architecture", slug: "architecture" },
            { label: "Agent loop", slug: "agent-loop" },
            { label: "Finding triage", slug: "triage" },
            { label: "Blind verification", slug: "blind-verification" },
            { label: "Verification results", slug: "verification-result" },
            { label: "Finding validators", slug: "validators" },
            { label: "Adversarial evals", slug: "adversarial-evals" },
          ],
        },
        {
          label: "Benchmarks",
          collapsed: true,
          items: [
            { label: "Results", slug: "benchmark" },
            { label: "XBOW analysis", slug: "research/xbow-analysis" },
            { label: "Project comparison", slug: "research/competitive-landscape" },
          ],
        },
        {
          label: "Research",
          collapsed: true,
          items: [
            { label: "Overview", slug: "research" },
            { label: "Research workflows", slug: "research-workflows" },
            { label: "Kernel VM verification", slug: "kernel-vm" },
            {
              label: "Essays & rationale",
              collapsed: true,
              items: [
                { label: "Shell-first rationale", slug: "research/shell-first" },
                { label: "Agent techniques", slug: "research/agent-techniques" },
                { label: "Model comparison", slug: "research/model-comparison" },
                { label: "False-positive reduction", slug: "research/fp-reduction-moat" },
                { label: "TypeScript/Rust Boundary", slug: "research/typescript-rust-boundary" },
              ],
            },
            {
              label: "Triage ML",
              collapsed: true,
              items: [
                { label: "Finding triage ML", slug: "research/finding-triage-ml" },
                { label: "Dynamic routing design", slug: "research/dynamic-routing-design" },
                { label: "Triage dataset", slug: "research/triage-dataset" },
                { label: "Feature extractor", slug: "research/feature-extractor" },
                { label: "Dynamic triage routing", slug: "research/dynamic-triage-routing" },
                { label: "Journal & orchestrator", slug: "research/journal-orchestrator-design" },
              ],
            },
            {
              label: "Experiment logs",
              collapsed: true,
              items: [
                { label: "2026-05-09 Control-flow audit", slug: "research/2026-05-09-control-flow-not-prompts" },
                { label: "2026-05-08 Cost per Flag", slug: "research/2026-05-08-cost-per-flag" },
                { label: "2026-05-06 H1 Program Audit", slug: "research/2026-05-06-h1-ai-readiness" },
                { label: "2026-04-11 Ablation", slug: "research/2026-04-11-ablation" },
                { label: "XBEN-099 investigation", slug: "research/xben-099-investigation" },
                { label: "Unsolved eight investigation", slug: "research/unsolved-eight-investigation" },
              ],
            },
          ],
        },
        {
          label: "Roadmap",
          slug: "roadmap",
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
