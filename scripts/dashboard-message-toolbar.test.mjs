/** Browser check: the message action bar never covers message text, never shifts layout and reveals on hover and keyboard focus. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/web/package.json"));
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core")); } catch { /* optional dependency */ }
const port = 48000 + (process.pid % 900);

test("message toolbar geometry", { skip: !chromium && "playwright-core is not installed" }, async (t) => {
  const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: join(root, "packages/web"), stdio: "ignore" });
  t.after(() => vite.kill());
  let browser;
  try { browser = await chromium.launch(); } catch { return t.skip("no Chromium available"); }
  t.after(() => browser.close());
  for (const [width, touch] of [[1400, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    for (let i = 0; ; i++) {
      try { await page.goto(`http://127.0.0.1:${port}/test-harness/index.html`); break; } catch { if (i > 60) throw new Error("vite did not start"); await new Promise((r) => setTimeout(r, 500)); }
    }
    await page.waitForSelector("[data-slot=code-block]");
    const rails = await page.$$("[data-rail]");
    assert.equal(rails.length, 2);
    for (const rail of rails) {
      const box = await rail.boundingBox();
      const before = await rail.evaluate((el) => el.querySelector("[data-text]").getBoundingClientRect().top);
      if (!touch) {
        await page.mouse.move(2, 2);
        assert.equal(await rail.evaluate((el) => getComputedStyle(el.querySelector("[data-slot=message-toolbar]")).opacity), "0");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
      }
      const r = await rail.evaluate((el) => {
        const bar = el.querySelector("[data-slot=message-toolbar]").getBoundingClientRect();
        const text = el.querySelector("[data-text]").getBoundingClientRect();
        const opacity = getComputedStyle(el.querySelector("[data-slot=message-toolbar]")).opacity;
        return { opacity, top: text.top, overlap: !(bar.bottom <= text.top || bar.top >= text.bottom || bar.right <= text.left || bar.left >= text.right) };
      });
      assert.equal(r.opacity, "1", `toolbar visible (${width}px)`);
      assert.equal(r.overlap, false, `toolbar must not intersect message text (${width}px)`);
      assert.equal(r.top, before, "revealing the toolbar must not move text");
    }
    if (!touch) {
      await page.mouse.move(2, 2);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      assert.equal(await page.$eval("[data-slot=message-toolbar]", (el) => getComputedStyle(el).opacity), "1", "keyboard focus reveals the toolbar");
      await page.evaluate(() => document.activeElement.blur());
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1600); // past the tooltip skip window, so the delay is cold
      await page.hover("[data-slot=message-toolbar] button[aria-label='Copy message']");
      const started = Date.now();
      await page.waitForSelector("[data-slot=tooltip-content]", { timeout: 2000 });
      const delay = Date.now() - started;
      assert.ok(delay >= 150 && delay < 900, `tooltip opens after a hover-intent delay, got ${delay}ms`);
    }
    await context.close();
  }
});
