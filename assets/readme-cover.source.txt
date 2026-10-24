README artwork refreshed from the current 0.security website in ../0cloud/0-www.

Source checkout revision: 0sec-labs/0cloud@01f662807e669435a0680fe06286b1fbf0a64c83
Static artwork is copied byte-for-byte from the local website checkout. The animated hero is encoded from the existing website video. No generated or mascot artwork is used.

readme-cover.webp
  Source: public/cloudlight/soft-hero.webp
  Used by: HomeProductExplanation.astro and PricingTransparency.astro.
  Orange sunset and dark cloudscape.

readme-infrastructure.webp
  Source: public/cloudlight/dependency-security-20261020.webp
  Used by: HomeDependencySecurity.astro.
  Floating infrastructure in orange and violet clouds.

The product screenshot in README.md is retained. Older mascot exports remain on disk for historical references but are not displayed in the README.

readme-hero.gif
  Source: public/hero/hero-logo-clear-20261020.mp4
  Full 14-second website animation, encoded as a looping GIF for inline GitHub README playback.
  FFmpeg filter: fps=6,scale=720:-1:flags=lanczos; palettegen=max_colors=80:stats_mode=diff; paletteuse=dither=sierra2_4a.
  No audio. The README links the animation to https://0.security/.

The README now uses the animated hero instead of readme-cover.webp.
