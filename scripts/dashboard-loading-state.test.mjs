import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("shared square activity mark stays still for waiting and both reduced-motion modes", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".loading-state-test-"));
  let browser;
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { ActivityIndicator, ChatHistorySkeleton, ConversationSkeleton, LoadingDots } from "./src/console/loading-state";
      export const active = renderToStaticMarkup(React.createElement(ActivityIndicator, { label: "Reviewing source" }));
      export const waiting = renderToStaticMarkup(React.createElement(ActivityIndicator, { label: "Waiting for you", waiting: true }));
      export const history = renderToStaticMarkup(React.createElement(ChatHistorySkeleton));
      export const conversation = renderToStaticMarkup(React.createElement(ConversationSkeleton));
      export const compact = renderToStaticMarkup(React.createElement(LoadingDots, { className: "console-loading-dots-compact" }));
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent" });
    const fixture = await import(pathToFileURL(output).href);
    const css = [await readFile(resolve(dashboard, "src/console/loading-state.css"), "utf8"), await readFile(resolve(dashboard, "../ui/src/styles/loader.css"), "utf8"), await readFile(resolve(dashboard, "../ui/src/styles/skeleton.css"), "utf8")].join("\n");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`<style>${css}</style><main style="color:rgb(210,210,210)"><div id="active">${fixture.active}</div><div id="waiting">${fixture.waiting}</div><div id="compact">${fixture.compact}</div><div id="history">${fixture.history}</div><div id="conversation">${fixture.conversation}</div></main>`);
    assert.equal(await page.getByRole("status").count(), 4);
    assert.equal(await page.getByRole("status", { name: "Loading chats", exact: true }).getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#history [data-slot=skeleton]").count(), 5);
    assert.ok(await page.locator("#conversation [data-slot=skeleton]").count() >= 10);
    assert.equal(await page.locator("#history button,#history a,#conversation button,#conversation input").count(), 0, "placeholders never impersonate interactive controls");
    const shimmer = () => page.locator("#history [data-slot=skeleton]").first().evaluate(element => getComputedStyle(element, "::after").animationName);
    assert.equal(await shimmer(), "ui-skeleton-shimmer");
    assert.equal(await page.locator("#active [aria-hidden=true] rect").count(), 9);
    assert.equal(await page.locator("#active circle").count(), 0);
    const cells = selector => page.locator(`${selector} rect`).evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, fill: style.fill };
    }));
    const initialBox = await page.locator("#active .console-activity-mark").boundingBox();
    assert.ok((await cells("#active")).every(cell => cell.animation === "ui-loader-wave" && cell.fill === "rgb(210, 210, 210)"));
    assert.ok((await cells("#waiting")).every(cell => cell.animation === "none"));
    assert.equal((await page.locator("#compact .console-activity-mark").boundingBox()).width, 14);
    await page.evaluate(() => document.querySelector("main").setAttribute("data-reduced-motion", "true"));
    assert.ok((await cells("#active")).every(cell => cell.animation === "none"));
    assert.equal(await shimmer(), "none");
    await page.evaluate(() => document.querySelector("main").removeAttribute("data-reduced-motion"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.ok((await cells("#active")).every(cell => cell.animation === "none"));
    assert.equal(await shimmer(), "none");
    const reducedBox = await page.locator("#active .console-activity-mark").boundingBox();
    assert.deepEqual({ width: reducedBox.width, height: reducedBox.height }, { width: initialBox.width, height: initialBox.height });
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
