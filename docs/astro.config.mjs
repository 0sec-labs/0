import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import rehypeMermaid from "rehype-mermaid";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  site: "https://docs.0.security",
  redirects: {
    "/getting-started": "/",
    "/quickstart": "/",
    "/console": "/app/",
    "/web-interface": "/app/",
    "/visualizations": "/app/",
    "/api-keys": "/models/",
    "/scans": "/scan-web/",
    "/assessment-reports": "/reports/",
    "/white-box-mode": "/scan-web/",
    "/code-and-binary-analysis": "/scan-code/",
    "/recipes": "/",
    "/integrations": "/mcp/",
    "/engine-connections": "/engines/",
    "/team-workspaces": "/engines/",
    "/budget-management": "/budgets/",
    "/improvement-plane": "/self-improvement/",
    "/learning": "/self-improvement/",
    "/validators": "/triage/",
    "/blind-verification": "/triage/",
    "/adversarial-evals": "/research-workflows/",
    "/roadmap": "/",
    "/desktop": "/",
    "/features": "/concepts/",
    "/engagements": "/scope/",
    "/methodology": "/benchmark/",
    "/research/fp-reduction-moat": "/research/false-positive-reduction/",
    "/research/competitive-landscape": "/research/",
    "/research/agent-techniques": "/research/",
    "/research/feature-extractor": "/research/",
    "/research/journal-orchestrator-design": "/research/",
    "/research/xben-099-investigation": "/research/",
    "/research/unsolved-eight-investigation": "/research/",
    "/research/dynamic-routing-design": "/research/finding-triage-ml/",
    "/research/dynamic-triage-routing": "/research/finding-triage-ml/",
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
      title: "0security docs",
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://0.security", crossorigin: "anonymous" } },
      ],
      description:
        "0security is the open-source security harness that fixes what it finds: it finds vulnerabilities in your software, proves them and ships tested fixes.",
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
        MobileMenuFooter: "./src/components/DocsMobileMenuFooter.astro",
        Sidebar: "./src/components/DocsSidebar.astro",
        PageTitle: "./src/components/DocsPageTitle.astro",
        Footer: "./src/components/DocsFooter.astro",
        ThemeProvider: "./src/components/DocsThemeProvider.astro",
        ThemeSelect: "./src/components/DocsThemeToggle.astro",
      },
      // Code blocks take their surfaces from the design tokens (src/styles/tokens.css).
      expressiveCode: {
        themes: ["github-dark-default", "github-light-default"],
        styleOverrides: {
          borderRadius: "var(--radius-card)",
          borderColor: "var(--border-1)",
          borderWidth: "1px",
          codeBackground: "var(--code-background)",
          codeFontFamily: "var(--font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.7",
          codePaddingBlock: "1rem",
          codePaddingInline: "1.125rem",
          uiFontFamily: "var(--font-sans)",
          uiFontSize: "0.8125rem",
          focusBorder: "var(--ring)",
          scrollbarThumbColor: "var(--border-2)",
          scrollbarThumbHoverColor: "var(--border-3)",
          frames: {
            shadowColor: "transparent",
            frameBoxShadowCssValue: "none",
            editorBackground: "var(--code-background)",
            editorTabBarBackground: "var(--code-background)",
            editorTabBarBorderColor: "var(--border-1)",
            editorTabBarBorderBottomColor: "var(--border-1)",
            editorActiveTabBackground: "var(--code-background)",
            editorActiveTabForeground: "var(--foreground)",
            editorActiveTabBorderColor: "transparent",
            editorActiveTabIndicatorTopColor: "transparent",
            editorActiveTabIndicatorBottomColor: "var(--foreground)",
            terminalBackground: "var(--code-background)",
            terminalTitlebarBackground: "var(--code-background)",
            terminalTitlebarForeground: "var(--muted-foreground)",
            terminalTitlebarBorderBottomColor: "var(--border-1)",
            terminalTitlebarDotsForeground: "var(--border-3)",
            terminalTitlebarDotsOpacity: "1",
            inlineButtonForeground: "var(--muted-foreground)",
            inlineButtonBackground: "var(--secondary)",
            inlineButtonBackgroundIdleOpacity: "0",
            inlineButtonBackgroundHoverOrFocusOpacity: "1",
            inlineButtonBackgroundActiveOpacity: "1",
            inlineButtonBorder: "var(--border-2)",
            inlineButtonBorderOpacity: "1",
            tooltipSuccessBackground: "var(--foreground)",
            tooltipSuccessForeground: "var(--background)",
          },
        },
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Quickstart", slug: "index" },
            { label: "Concepts", slug: "concepts" },
            { label: "Browser app", slug: "app" },
            { label: "Models and keys", slug: "models" },
            { label: "Scope and authorization", slug: "scope" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
        {
          label: "Find and fix",
          items: [
            { label: "Scan code", slug: "scan-code" },
            { label: "Scan web and APIs", slug: "scan-web" },
            { label: "Dependencies", slug: "dependencies" },
            { label: "Verify and fix", slug: "verify-and-fix" },
            { label: "Findings", slug: "findings" },
            { label: "Reports and disclosure", slug: "reports" },
            { label: "Specialist research", slug: "research-workflows" },
          ],
        },
        {
          label: "Automate and extend",
          items: [
            { label: "Automations", slug: "automations" },
            { label: "Sentinels", slug: "sentinels" },
            { label: "CI/CD", slug: "ci/github-action" },
            { label: "Agents and MCP", slug: "mcp" },
            { label: "Plugins", slug: "plugins" },
            { label: "Plugin security", slug: "plugin-trust" },
            { label: "Skills", slug: "skills" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI reference", slug: "commands" },
            { label: "Configuration", slug: "configuration" },
            { label: "Costs and budgets", slug: "budgets" },
            { label: "Remote engines and teams", slug: "engines" },
            { label: "Findings API", slug: "findings-api" },
            { label: "Verification result schema", slug: "verification-result" },
            { label: "Docker", slug: "docker" },
          ],
        },
        {
          label: "How it works",
          collapsed: true,
          items: [
            { label: "Architecture", slug: "architecture" },
            { label: "Agent loop", slug: "agent-loop" },
            { label: "Triage and validation", slug: "triage" },
            { label: "Self-improvement", slug: "self-improvement" },
            { label: "Benchmarks", slug: "benchmark" },
          ],
        },
        { label: "Research", slug: "research" },
        { label: "Changelog", link: "https://github.com/0sec-labs/0/blob/main/docs/CHANGELOG.md" },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
