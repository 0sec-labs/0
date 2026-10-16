# Current interface captures

Captured on 2026-10-02 from Zero v0.23.0 at engine commit
`14a91c5ab5dd`, using the actual built web interface and headless Chromium.
Both JPEGs are uncomposited viewport screenshots at 1280 × 900 pixels.
No controls, statuses, tool calls, findings, or execution results were drawn or
reconstructed. Only ordinary navigation and scrolling were used.

`web-chat.jpg` displays the retained public review in
[`../examples/demo-api/review.md`](../examples/demo-api/review.md), introduced by
commit `0bc700d7` on 2026-09-30. That file records a real source-only Zero review
using `gpt-5.6-sol`; it does not record runtime exploit verification. The capture
imports its report body verbatim, starting at `### 1.`. Its document title and
provenance preamble are excluded from the assistant message. No user prompt or
tool activity was invented. The title comes from the source document.

This is a historical report rendered in the current interface, not a new model
execution. The isolated fixture has no model credentials. Its resume attempt
returned HTTP 409 while retaining the historical message; the session was then
closed through the normal session API. The screenshot faithfully shows the
closed, read-only conversation rather than claiming an active model connection.

`web-workflow.jpg` displays the current `repository-review` catalog template,
saved through the workflow API. Its target `./customer-api` resolves to the
included public demo sources copied into the isolated engine's working directory.
The trigger is manual. No schedule was added and the workflow was never run;
the graph is an editable definition, not evidence of completed assessments.

Reproduce with `pnpm run build`, then
`node assets/screenshots/capture.mjs`. The script creates a temporary home,
database and public fixture, launches its own loopback web server, captures the
real pages with Playwright, and stops that server. It does not access existing
private conversations, start a paid assessment, or print authentication tokens.
