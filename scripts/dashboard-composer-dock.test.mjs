import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const conversation = readFileSync(new URL("../packages/web/src/console/conversation.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../packages/web/src/styles.css", import.meta.url), "utf8");

test("the composer dock keeps Capy spacing: 4px below the footer row, nothing between transcript and card", () => {
  assert.match(conversation, /px-3 pb-\[calc\(0\.25rem\+env\(safe-area-inset-bottom\)\)\] sm:px-6/);
  assert.doesNotMatch(conversation, /"p-3 sm:px-6"/);
  assert.match(conversation, /data-composer-status\n\s+className="@container\/rail flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 px-4 text-xs/);
});

test("the transcript fades only at the top so the last lines are never dimmed above the composer", () => {
  assert.match(conversation, /console-transcript-scroller md:scroll-fade-top /);
  const utility = styles.match(/@utility scroll-fade-top \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(utility, "scroll-fade-top utility exists");
  assert.doesNotMatch(utility, /sf-bottom|calc\(100%/);
});

test("Scroll to latest floats above the card without taking layout space", () => {
  const pill = conversation.match(/<button\s+type="button"\s+aria-label=\{\s*unseen > 0[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  assert.match(pill, /\babsolute bottom-full left-1\/2\b/);
  assert.match(pill, /\bmb-2\b/);
  assert.match(pill, /\bh-7\b/);
  assert.match(pill, /-translate-x-1\/2/);
});
