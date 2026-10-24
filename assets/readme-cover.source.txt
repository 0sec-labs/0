README UI tours and artwork — 2026-10-23

The main web UI tour is 8.5 seconds. Four feature tours add findings (7s),
workflows (7.5s), hosts/plugins (7.5s), and skills/memory (6.5s).
Cuts are immediate; camera emphasis settles in roughly 0.2 seconds.
Feature tours use 16 fps for smoother camera motion; the retimed main review
keeps the captured source cadence at 8 fps. The full
navigation is visible in the opening context views of the feature tours.
GIFs loop silently, MP4s provide full-resolution playback, and JPGs serve
readers who prefer reduced motion. No explanatory captions are displayed
under the embedded media in the README.

Sources
  Main tour: real source-only review of assets/examples/demo-api in the 0 UI.
  readme-ui-demo.source.mp4 retains the longer privacy-reviewed source edit.
  Feature tours: actual 0 UI views captured from an isolated local demo DB.
  The demo DB contains the two source findings and two source-backed lessons
  from that review, prepared for demonstration. Findings remain discovered,
  not runtime-verified; no payload was executed or fix applied.
  Workflow steps, findings queue/board/evidence, local host selection, blank
  GitHub connection dialog, extension controls, built-in skills, and lesson
  source disclosures are genuine UI states. No UI controls were fabricated.
  Private history, remote SSH inventories, and credentials are not published.
  The workspace label in the local host picker is masked.

Website backgrounds
  readme-cover.webp: public/cloudlight/soft-hero.webp (main tour).
  readme-background-findings.webp: public/cloudlight/cloud-dusk.webp.
  readme-background-workflows.webp: public/cloudlight/pointillist-hero.webp.
  readme-background-tools.webp: public/cloudlight/coral-optics.webp.
  readme-background-memory.webp: public/cloudlight/signal-field.webp.
  readme-infrastructure.webp: public/cloudlight/dependency-security-20261020.webp.
  These are byte-for-byte copies from ../0cloud/0-www, checkout
  01f662807e669435a0680fe06286b1fbf0a64c83.

Framing
  readme-demo-frame.html defines the rounded window, border, shadow, and
  background composition. The recorded UI pixels are framed through HTML/CSS,
  with camera zooms applied inside the window. No mascot or promotional text
  is added over the artwork or UI.
