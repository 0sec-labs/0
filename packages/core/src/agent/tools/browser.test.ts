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
  type BrowserDriver,
  type BrowserDriverFactory,
  type BrowserDriverOptions,
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

describe("browser tool definition", () => {
  it("declares the full action enum", () => {
    expect(browserToolDefinitions.browser.parameters.action.enum).toEqual([...BROWSER_ACTIONS]);
    expect(browserToolDefinitions.browser.required).toEqual(["action"]);
  });
  it("routes through the browserAction handler name (unchanged from recon.ts)", () => {
    expect(browserDispatch.browser).toBe("browserAction");
  });
});

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

describe("executeBrowser driver options", () => {
  it("forwards userAgent / extraHeaders / interceptor into the backend factory", async () => {
    let seen: BrowserDriverOptions | undefined;
    const capturingFactory: BrowserDriverFactory = async (opts) => {
      seen = opts;
      return { driver: fakeDriver() };
    };
    const interceptor: BrowserDriverOptions["interceptor"] = async () => null;
    await executeBrowser(unscopedCtx, { action: "list_tabs" }, {
      createDriver: capturingFactory,
      userAgent: "0sec-browser/1.0",
      extraHeaders: { "X-0sec": "engagement" },
      interceptor,
    });
    expect(seen?.userAgent).toBe("0sec-browser/1.0");
    expect(seen?.extraHeaders).toEqual({ "X-0sec": "engagement" });
    expect(seen?.interceptor).toBe(interceptor);
  });
});
