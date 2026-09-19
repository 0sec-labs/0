/**
 * Unit tests for the next-gen browser tool scaffold (browser-tool-20260913).
 *
 * These pin the two things that must hold with NO real browser present:
 *  1. arg-validation (missing/unknown action, missing url/selector/text/value),
 *  2. the "backend not installed" degradation path (guarded driver seam).
 *
 * A fake driver stands in for playwright so the multi-tab routing + scope-gating
 * can be exercised deterministically without launching Chromium.
 */
import { describe, it, expect } from "vitest";
import {
  BROWSER_ACTIONS,
  browserToolDefinitions,
  browserDispatch,
  executeBrowser,
  PlaywrightDriver,
  type BrowserDriver,
  type BrowserDriverFactory,
  type BrowserDriverOptions,
  type BrowserDriverHost,
  type BrowserPage,
  type BrowserToolContext,
} from "./browser.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakePage(url = "https://target.test/"): BrowserPage {
  let current = url;
  return {
    async goto(to) {
      current = to;
      return { url: to, status: 200, title: "Fake Page" };
    },
    async click() {},
    async type() {},
    async evaluate() {
      return { ok: true };
    },
    async content() {
      return { html: "<html><body>hi</body></html>", text: "hi" };
    },
    async screenshot() {
      return "QUJD"; // base64 "ABC"
    },
    currentUrl: () => current,
    drainDialogs: () => [],
    drainConsole: () => [],
  };
}

function fakeDriver(): BrowserDriver {
  const tabs = new Map<string, BrowserPage>();
  return {
    async tab(name) {
      let p = tabs.get(name);
      if (!p) {
        p = fakePage();
        tabs.set(name, p);
      }
      return p;
    },
    listTabs: () => [...tabs.entries()].map(([name, page]) => ({ name, url: page.currentUrl() })),
    async closeTab(name) {
      return tabs.delete(name);
    },
    async closeAll() {
      const n = tabs.size;
      tabs.clear();
      return n;
    },
    async dispose() {
      tabs.clear();
    },
  };
}

const fakeFactory: BrowserDriverFactory = async () => ({ driver: fakeDriver() });
const missingBackendFactory: BrowserDriverFactory = async () => ({
  error: "browser backend not installed — run `npm i playwright && npx playwright install chromium`",
});

const unscopedCtx: BrowserToolContext = { target: "https://target.test" };

// A scope stub matching only *.target.test — enough for gateUrl.
function scopedCtx(): BrowserToolContext {
  const scope = {
    match(url: string) {
      const allowed = /^https?:\/\/([a-z0-9-]+\.)?target\.test(\/|$)/.test(url);
      return { allowed, reason: allowed ? "in scope" : "host not in scope", raw: url };
    },
  } as unknown as NonNullable<BrowserToolContext["scope"]>;
  return { target: "https://target.test", scope };
}

// ── Definition / dispatch shape ───────────────────────────────────────────────


// ── Arg validation ────────────────────────────────────────────────────────────

describe("executeBrowser arg validation", () => {
  const deps = { createDriver: fakeFactory };

  it("rejects a missing action", async () => {
    const r = await executeBrowser(unscopedCtx, {}, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/action is required/);
  });

  it("rejects an unknown action", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "teleport" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown browser action/);
  });

  it("requires url for navigate", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "navigate" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/url is required/);
  });

  it("requires selector for click", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "click" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/selector is required/);
  });

  it("requires selector and text for type", async () => {
    const noSel = await executeBrowser(unscopedCtx, { action: "type", text: "x" }, deps);
    expect(noSel.error).toMatch(/selector is required/);
    const noText = await executeBrowser(unscopedCtx, { action: "type", selector: "#a" }, deps);
    expect(noText.error).toMatch(/text is required/);
  });

  it("requires value for eval", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "eval" }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/value .*is required/);
  });
});

// ── Backend-not-installed guard (no real browser) ─────────────────────────────

describe("executeBrowser backend guard", () => {
  it("returns a clear, actionable error when the backend is missing", async () => {
    const r = await executeBrowser(
      unscopedCtx,
      { action: "navigate", url: "https://target.test/" },
      { createDriver: missingBackendFactory },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/backend not installed/);
    expect(r.error).toMatch(/playwright install chromium/);
  });

  it("does not construct a driver for arg-validation failures", async () => {
    // Even with the missing-backend factory, a bad arg fails BEFORE the factory
    // is consulted — so the error is the validation error, not the guard error.
    const r = await executeBrowser(unscopedCtx, { action: "navigate" }, { createDriver: missingBackendFactory });
    expect(r.error).toMatch(/url is required/);
  });
});

// ── Scope gating ──────────────────────────────────────────────────────────────

describe("executeBrowser scope gating", () => {
  it("allows an in-scope navigation", async () => {
    const r = await executeBrowser(scopedCtx(), { action: "navigate", url: "https://target.test/x" }, { createDriver: fakeFactory });
    expect(r.success).toBe(true);
    expect((r.output as { url: string }).url).toBe("https://target.test/x");
  });

  it("refuses an out-of-scope navigation before touching the driver", async () => {
    const r = await executeBrowser(scopedCtx(), { action: "navigate", url: "https://evil.example/" }, { createDriver: fakeFactory });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/out-of-scope/);
  });
});

// ── Multi-tab routing + lifecycle ─────────────────────────────────────────────

describe("executeBrowser multi-tab", () => {
  it("tracks tabs across calls via an injected host and closes them", async () => {
    const host = { driver: null as BrowserDriver | null };
    const deps = { createDriver: fakeFactory, host };

    await executeBrowser(unscopedCtx, { action: "navigate", url: "https://target.test/", tab: "victim" }, deps);
    await executeBrowser(unscopedCtx, { action: "navigate", url: "https://target.test/", tab: "authed" }, deps);

    const list = await executeBrowser(unscopedCtx, { action: "list_tabs" }, deps);
    expect((list.output as { tabs: unknown[] }).tabs).toHaveLength(2);

    const closed = await executeBrowser(unscopedCtx, { action: "close", tab: "victim" }, deps);
    expect((closed.output as { closed: number }).closed).toBe(1);

    const closeAll = await executeBrowser(unscopedCtx, { action: "close", all: true }, deps);
    expect((closeAll.output as { closed: number }).closed).toBe(1);
  });
});

// ── Screenshot image meta (rendered as an ImageCard by the TUI) ───────────────

// A real 1×1 PNG so `pngDimensions` can decode the IHDR width/height.
const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function pngDriver(): BrowserDriver {
  const page: BrowserPage = { ...fakePage(), async screenshot() { return ONE_BY_ONE_PNG_B64; } };
  return {
    async tab() { return page; },
    listTabs: () => [{ name: "main", url: page.currentUrl() }],
    async closeTab() { return true; },
    async closeAll() { return 1; },
    async dispose() {},
  };
}

describe("executeBrowser screenshot image meta", () => {
  const deps = { createDriver: async () => ({ driver: pngDriver() }) };

  it("attaches an image meta kind with the full base64 + decoded PNG dimensions", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "screenshot" }, deps);
    expect(r.success).toBe(true);
    expect(r.meta?.kind).toBe("image");
    expect(r.meta?.image?.mimeType).toBe("image/png");
    // Full, untruncated base64 rides in meta for the display-only image card.
    expect(r.meta?.image?.imageBase64).toBe(ONE_BY_ONE_PNG_B64);
    expect(r.meta?.image?.width).toBe(1);
    expect(r.meta?.image?.height).toBe(1);
    // The model-facing output still carries the (bounded) base64 as before.
    expect((r.output as { screenshot_base64: string }).screenshot_base64).toBe(ONE_BY_ONE_PNG_B64);
  });
});

// ── Driver options threading (attribution + scope-pinned interceptor) ─────────


// ── CDP attach (connect to operator's already-authenticated Chrome) ───────────

describe("executeBrowser CDP attach", () => {
  it("declares the attach action", () => {
    expect([...BROWSER_ACTIONS]).toContain("attach");
  });

  it("requires cdp_url for attach", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "attach" }, { createDriver: fakeFactory });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/cdp_url is required/);
  });

  it("rejects a cdp_url that is not a CDP endpoint", async () => {
    const r = await executeBrowser(unscopedCtx, { action: "attach", cdp_url: "127.0.0.1:9222" }, { createDriver: fakeFactory });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not a CDP endpoint/);
  });

  it("routes a valid cdp_url through the factory as cdpEndpoint", async () => {
    let seen: BrowserDriverOptions | undefined;
    const capturingFactory: BrowserDriverFactory = async (opts) => {
      seen = opts;
      return { driver: fakeDriver() };
    };
    const r = await executeBrowser(
      unscopedCtx,
      { action: "attach", cdp_url: "http://127.0.0.1:9222" },
      { createDriver: capturingFactory },
    );
    expect(r.success).toBe(true);
    expect(seen?.cdpEndpoint).toBe("http://127.0.0.1:9222");
    expect((r.output as { attached: boolean }).attached).toBe(true);
  });

  it("omitting cdp_url preserves the launch path (no cdpEndpoint)", async () => {
    let seen: BrowserDriverOptions | undefined;
    const capturingFactory: BrowserDriverFactory = async (opts) => {
      seen = opts;
      return { driver: fakeDriver() };
    };
    await executeBrowser(
      unscopedCtx,
      { action: "navigate", url: "https://target.test/" },
      { createDriver: capturingFactory },
    );
    expect(seen).toBeDefined();
    expect(seen?.cdpEndpoint).toBeUndefined();
  });

  it("keeps scope-gating on a CDP-attached context", async () => {
    const host: BrowserDriverHost = { driver: null };
    const deps = { createDriver: fakeFactory, host };
    const attach = await executeBrowser(scopedCtx(), { action: "attach", cdp_url: "http://127.0.0.1:9222" }, deps);
    expect(attach.success).toBe(true);
    // An in-scope navigation on the adopted context is allowed …
    const ok = await executeBrowser(scopedCtx(), { action: "navigate", url: "https://target.test/dash" }, deps);
    expect(ok.success).toBe(true);
    // … but an out-of-scope one is refused just as on a launched context.
    const bad = await executeBrowser(scopedCtx(), { action: "navigate", url: "https://evil.example/" }, deps);
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/out-of-scope/);
  });

  it("re-attach disposes any prior driver before reconnecting", async () => {
    let disposed = false;
    const prior: BrowserDriver = { ...fakeDriver(), async dispose() { disposed = true; } };
    const host: BrowserDriverHost = { driver: prior };
    await executeBrowser(unscopedCtx, { action: "attach", cdp_url: "http://127.0.0.1:9222" }, { createDriver: fakeFactory, host });
    expect(disposed).toBe(true);
    expect(host.driver).not.toBe(prior);
    expect(host.driver).toBeTruthy();
  });
});

// ── PlaywrightDriver CDP backend seam (mock playwright module, no real Chrome) ─

function mockBackendPage() {
  return {
    async goto() { return { status: () => 200 }; },
    url: () => "https://target.test/",
    async title() { return "Authed"; },
    async click() {},
    async fill() {},
    async type() {},
    async evaluate() { return null; },
    async content() { return "<html></html>"; },
    async screenshot() { return Buffer.from(""); },
    async waitForTimeout() {},
    on() {},
    async close() {},
  };
}

describe("PlaywrightDriver CDP backend", () => {
  it("connects over CDP, adopts the existing context, and never tears the operator's browser/context down", async () => {
    let opCtxClosed = false;
    let routeGlob: string | undefined;
    const operatorContext = {
      pages: () => [mockBackendPage()],
      newPage: async () => mockBackendPage(),
      async route(glob: string) { routeGlob = glob; },
      async addInitScript() {},
      async close() { opCtxClosed = true; },
    };
    let browserClosed = false;
    const browser = {
      contexts: () => [operatorContext],
      async newContext() { return operatorContext; },
      async close() { browserClosed = true; },
    };
    let connectedTo: string | undefined;
    let launched = false;
    const mod = {
      chromium: {
        async launch() { launched = true; return browser; },
        async connectOverCDP(ep: string) { connectedTo = ep; return browser; },
      },
    };
    const interceptor: BrowserDriverOptions["interceptor"] = async () => null;
    const driver = new PlaywrightDriver(
      mod as unknown as ConstructorParameters<typeof PlaywrightDriver>[0],
      { cdpEndpoint: "http://127.0.0.1:9222", interceptor },
    );

    // First tab() forces the CDP connection + context adoption.
    await driver.tab("main");
    expect(connectedTo).toBe("http://127.0.0.1:9222");
    expect(launched).toBe(false); // never launched a fresh browser
    expect(routeGlob).toBe("**/*"); // scope interceptor installed on the adopted context

    await driver.dispose();
    expect(opCtxClosed).toBe(false); // operator's authenticated context left intact
    expect(browserClosed).toBe(true); // only the CDP connection is severed
  });

  it("launches a fresh browser when no cdpEndpoint is given (default path)", async () => {
    let launched = false;
    let connected = false;
    const context = {
      pages: () => [],
      newPage: async () => mockBackendPage(),
      async route() {},
      async addInitScript() {},
      async close() {},
    };
    const browser = { contexts: () => [], async newContext() { return context; }, async close() {} };
    const mod = {
      chromium: {
        async launch() { launched = true; return browser; },
        async connectOverCDP() { connected = true; return browser; },
      },
    };
    const driver = new PlaywrightDriver(
      mod as unknown as ConstructorParameters<typeof PlaywrightDriver>[0],
      {},
    );
    await driver.tab("main");
    expect(launched).toBe(true);
    expect(connected).toBe(false);
  });
});
