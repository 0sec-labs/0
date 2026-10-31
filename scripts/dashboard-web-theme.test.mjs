import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("web appearance persists across hosts and reloads without terminal settings or network writes", async () => {
  const temporary = await mkdtemp(resolve(dashboard, ".web-theme-test-"));
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const values = new Map([["terminal-theme", "high-contrast"]]);
  const writes = [];
  const removed = [];
  const handlers = new Map();
  const classes = new Set();
  const root = { dataset: {}, style: { removeProperty: value => removed.push(value) }, classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
  globalThis.window = {
    location: { pathname: "/skills", search: "?host=local" },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } },
    addEventListener: (name, handler) => handlers.set(name, handler),
  };
  globalThis.document = { documentElement: root };
  globalThis.fetch = () => { throw new Error("Web appearance must never call the engine"); };
  try {
    const output = resolve(temporary, "web-theme.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/lib/web-theme.ts")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const first = await import(`${pathToFileURL(output).href}?first`);
    first.initializeWebTheme();
    assert.equal(first.getWebTheme(), "dark", "terminal or prior DOM theme does not select browser appearance");
    assert.equal(root.dataset.mode, "dark");
    assert.ok(classes.has("dark"));
    assert.ok(removed.includes("--destructive"), "old terminal ERROR palette is cleared");
    first.setWebTheme("light");
    assert.equal(root.dataset.mode, "light");
    assert.equal(root.style.colorScheme, "light");
    assert.equal(classes.has("dark"), false);
    assert.equal(values.get(first.WEB_THEME_STORAGE_KEY), "light");
    window.location.search = "?host=remote-engine";
    window.location.pathname = "/settings";
    assert.equal(first.getWebTheme(), "light", "host and page switches preserve browser selection");
    const reloaded = await import(`${pathToFileURL(output).href}?reload`);
    assert.equal(reloaded.getWebTheme(), "light", "a fresh app instance restores browser appearance");
    assert.equal(values.get("terminal-theme"), "high-contrast");
    assert.deepEqual(writes, [[first.WEB_THEME_STORAGE_KEY, "light"]]);
    values.set(first.WEB_THEME_STORAGE_KEY, "dark");
    handlers.get("storage")({ key: first.WEB_THEME_STORAGE_KEY });
    assert.equal(reloaded.getWebTheme(), "dark", "other tabs update the current page");
    reloaded.setWebTheme("solarized");
    assert.equal(reloaded.getWebTheme(), "dark", "terminal palette names are not web appearances");
    assert.equal(writes.length, 1);
    window.localStorage.getItem = () => { throw new Error("storage denied"); };
    window.localStorage.setItem = () => { throw new Error("storage denied"); };
    const restricted = await import(`${pathToFileURL(output).href}?restricted`);
    assert.equal(restricted.getWebTheme(), "dark");
    restricted.setWebTheme("light");
    assert.equal(restricted.getWebTheme(), "light", "restricted browsers retain an in-memory selection");
  } finally {
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("browser motion follows the OS until chosen and never changes terminal motion", async () => {
  const temporary = await mkdtemp(resolve(dashboard, ".web-motion-test-"));
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const values = new Map([["reduceMotion", "false"]]);
  const writes = [];
  const handlers = new Map();
  const media = { matches: true, addEventListener: (name, handler) => handlers.set(`media:${name}`, handler) };
  globalThis.window = {
    location: { search: "?host=local" },
    matchMedia: () => media,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } },
    addEventListener: (name, handler) => handlers.set(name, handler),
  };
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.fetch = () => { throw new Error("Browser motion must not call the engine"); };
  try {
    const output = resolve(temporary, "web-motion.mjs");
    await build({ entryPoints: [resolve(dashboard, "src/lib/web-motion.ts")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const store = await import(`${pathToFileURL(output).href}?first`);
    assert.equal(store.getWebReduceMotion(), true, "OS accessibility preference is the initial default");
    assert.equal(document.documentElement.dataset.reducedMotion, "true");
    store.setWebReduceMotion(false);
    assert.equal(store.getWebReduceMotion(), false);
    assert.equal(document.documentElement.dataset.reducedMotion, "false");
    window.location.search = "?host=remote";
    const reloaded = await import(`${pathToFileURL(output).href}?reload`);
    assert.equal(reloaded.getWebReduceMotion(), false, "the browser selection survives reloads and host switches");
    handlers.get("media:change")();
    assert.equal(reloaded.getWebReduceMotion(), false, "an explicit browser choice takes precedence over OS changes");
    assert.equal(values.get("reduceMotion"), "false", "terminal preference is untouched");
    assert.deepEqual(writes, [[store.WEB_MOTION_STORAGE_KEY, "false"]]);
    values.delete(store.WEB_MOTION_STORAGE_KEY);
    handlers.get("storage")({ key: store.WEB_MOTION_STORAGE_KEY });
    assert.equal(reloaded.getWebReduceMotion(), true, "clearing the browser choice restores the OS preference");
    reloaded.setWebReduceMotion("off");
    assert.equal(writes.length, 1, "terminal enum strings are not accepted");
  } finally {
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    await rm(temporary, { recursive: true, force: true });
  }
});


test("HTML restores browser appearance before styles and the app bundle load", async () => {
  const html = await readFile(resolve(dashboard, "index.html"), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "startup theme runs independently of the application module");
  assert.ok(html.indexOf(match[0]) < html.indexOf('type="module"'), "startup theme precedes the application module");
  for (const saved of [null, "dark", "light", "invalid", "denied"]) {
    const classes = new Set();
    const root = { dataset: {}, style: {}, classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
    runInNewContext(match[1], { document: { documentElement: root }, localStorage: { getItem: key => {
      assert.equal(key, "zero-web-theme");
      if (saved === "denied") throw new Error("Storage denied");
      return saved;
    } } });
    const expected = saved === "light" ? "light" : "dark";
    assert.equal(root.dataset.mode, expected);
    assert.equal(root.style.colorScheme, expected);
    assert.equal(classes.has("dark"), expected === "dark");
  }
});
