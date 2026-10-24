README artwork — 2026-10-23

Website source: ../0cloud/0-www, checkout revision
01f662807e669435a0680fe06286b1fbf0a64c83.
Existing website footage and art, with code-authored typography and diagrams.
No mascot artwork is displayed.

readme-infrastructure.webp
  Byte-for-byte copy of public/cloudlight/dependency-security-20261020.webp,
  also used by HomeDependencySecurity.astro. Linked to the 0cloud waitlist.

readme-security-hero.gif / readme-security-hero.png
  Existing public/hero/hero-logo-clear-20261020.mp4 footage, composited with
  code-authored typography from readme-hero-overlay.html. No generated imagery.
  Overlay exported with Chromium at 1440x800, transparent background.
  Font: the website's Geist variable font (see public/fonts/geist-LICENSE.txt).
  Video: scale to fill/crop 1440x800, overlay at 0,0; GIF at 960px wide,
  6 fps, 256-color palette, Sierra dithering. Full original animation, silent loop.
  PNG is the static alternative for prefers-reduced-motion.

readme-setup.svg / readme-setup-mobile.svg
  Native SVG diagrams, including all typography and illustrations. Desktop
  cards become stacked mobile cards via a picture source at 600px.

readme-nav-*-light.svg / readme-nav-*-dark.svg
  Native SVG navigation labels. Each is wrapped in its own real README link.
  0cloud is the orange CTA. The source variants follow the reader's theme.

readme-cli-demo.mp4 / readme-cli-demo.gif / readme-cli-demo.png
  Edited terminal playback of actual 0 CLI output, captured on 2026-10-23.
  Source transcript: readme-cli-demo.transcript.json; native playback layout:
  readme-cli-demo.html. Commands: 0 --help; workflow list --templates;
  workflow show --template repository-review; mcp-server --help.
  jq extracts template IDs and step labels in the commands shown on screen.
  All four commands exited successfully. No model invocation or scan is shown.
  Rendered at 1200x760, 8 fps. Four six-second chapters, with command typing,
  real output, chapter headings, and a subtle camera zoom. GIF loops silently.
  PNG is the reduced-motion alternative. No browser-dashboard footage is used.
