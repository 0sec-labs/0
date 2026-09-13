/**
 * Next-gen headless-browser tool (SCAFFOLD — browser-tool-20260913).
 *
 * Modeled on oh-my-pi's `browser` tool (multi-tab, one explicit action surface),
 * but adapted to 0sec's evidence-first / scope-gated pentest posture:
 *
 *  - ONE `browser` tool with an `action` enum
 *    (navigate | click | type | screenshot | get_content | eval | list_tabs | close),
 *    replacing the terse recon.ts `browser` def (navigate/click/fill/evaluate/content/screenshot).
 *  - A MULTI-TAB model keyed by `tab` name (OMP's tab-supervisor idea, trimmed to
 *    what a pentest needs): several pages held open across turns so the agent can
 *    juggle an authed session and a victim frame at once.
 *  - The real browser lives behind a lazy, guarded {@link BrowserDriver} seam.
 *    The factory dynamically imports the backend and, when it is not installed,
 *    returns a clear "backend not installed — run <cmd>" error instead of throwing
 *    at import time. This module therefore TYPECHECKS with no browser dep present:
 *    there is no top-level `playwright`/`puppeteer` import, and the dynamic import
 *    uses a non-literal specifier so tsc cannot try to resolve the module.
 *
 * DEPENDENCY DECISION: we drive the backend through **playwright**, NOT
 * puppeteer-core (OMP's choice). 0sec already standardizes on playwright — it is
 * declared as an `optionalDependency` in packages/core/package.json ("^1.52.0")
 * and is already used via dynamic `import("playwright")` in agent/tools.ts
 * (`ensureBrowser`), triage/oracles.ts, agent/egats.ts, and racing.ts. Reusing it
 * (a) adds no new dependency, (b) reuses the proven scope-pinned `context.route`
 * interception already shipping in tools.ts, and (c) keeps one browser stack.
 *
 * This file is PURE next-gen module code + its guarded driver seam. It is not yet
 * imported by ./index.ts or ./dispatch.ts — see the WIRING TODOs at the bottom —
 * because `browser` is presently owned by recon.ts + `ToolExecutor.browserAction`,
 * and swapping ownership touches the monolithic executor + the shared registry
 * barrels. Keeping this module standalone lets it compile and be unit-tested in
 * isolation while the swap is reviewed.
 */
import type { ScopePolicy } from "../../scope/scope.js";
import type { ToolDefinition, ToolResult } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition (mirrors the per-domain module shape: `*ToolDefinitions` +
// `*Dispatch`, exactly like system.ts / recon.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** The action surface, kept as a const tuple so the handler and the schema agree. */
export const BROWSER_ACTIONS = [
  "navigate",
  "click",
  "type",
  "screenshot",
  "get_content",
  "eval",
  "list_tabs",
  "close",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** Default tab name when the caller omits `tab` (OMP uses "main" likewise). */
export const DEFAULT_TAB = "main";

/** Install hint surfaced when the browser backend is unavailable. */
export const BROWSER_INSTALL_HINT = "npm i playwright && npx playwright install chromium";

export const browserToolDefinitions: Record<string, ToolDefinition> = {
  browser: {
    name: "browser",
    description:
      "Drive a real headless browser to interact with a JavaScript-rendered target. " +
      "Multi-tab: pass `tab` to keep several pages open across turns (e.g. an authed " +
      "session and a victim frame). Actions: navigate (goto a URL — scope-validated, " +
      "with a post-redirect re-check), click (CSS selector), type (fill a field), " +
      "screenshot (PNG, base64), get_content (HTML + visible text), eval (run JS in the " +
      "page and capture dialogs/console — the primary XSS signal), list_tabs, close. " +
      "Every navigation is gated through the engagement scope exactly like http_request/crawl.",
    parameters: {
      action: {
        type: "string",
        description: "Browser action",
        enum: [...BROWSER_ACTIONS],
      },
      url: { type: "string", description: "URL to navigate to (for navigate)" },
      selector: { type: "string", description: "CSS selector (for click/type)" },
      text: { type: "string", description: "Text to type (for type)" },
      value: { type: "string", description: "JavaScript source to run (for eval)" },
      tab: {
        type: "string",
        description: `Named tab to act on (default "${DEFAULT_TAB}"). For close, omit and set all:true to release every tab.`,
      },
      all: { type: "boolean", description: "close: release every open tab instead of one" },
    },
    required: ["action"],
  },
};

/**
 * Tool-name → ToolExecutor handler-method name. Mirrors reconDispatch's
 * `browser: "browserAction"`. When this module supersedes the recon.ts entry,
 * `ToolExecutor.browserAction` is rewired to delegate to {@link executeBrowser}
 * (see WIRING TODOs), so the routed method name is deliberately unchanged.
 */
export const browserDispatch: Record<string, string> = {
  browser: "browserAction",
};

// ─────────────────────────────────────────────────────────────────────────────
// Driver seam. The handler talks ONLY to these interfaces; the concrete backend
// is loaded lazily by the factory. Nothing here references playwright's types,
// so the module typechecks with the optional dep absent.
// ─────────────────────────────────────────────────────────────────────────────

/** One navigation/observation result. */
export interface BrowserNavResult {
  url: string;
  status: number | null;
  title: string;
}

/** Page content snapshot (bounded — the handler caps these further). */
export interface BrowserContent {
  html: string;
  text: string;
}

/** A single managed page (OMP's per-tab page handle, trimmed). */
export interface BrowserPage {
  /** Navigate; returns the FINAL (post-redirect) url so the handler can re-check scope. */
  goto(url: string, opts: { timeoutMs: number; waitUntil?: string }): Promise<BrowserNavResult>;
  click(selector: string, opts: { timeoutMs: number }): Promise<void>;
  type(selector: string, text: string, opts: { timeoutMs: number }): Promise<void>;
  /** Run JS in page context; return value is JSON-safe or stringified by the driver. */
  evaluate(expression: string): Promise<unknown>;
  content(): Promise<BrowserContent>;
  /** PNG screenshot as base64 (no data: prefix). */
  screenshot(): Promise<string>;
  currentUrl(): string;
  /** Dialogs (alert/confirm/prompt) captured since the last drain — the XSS signal. */
  drainDialogs(): string[];
  /** Console messages captured since the last drain. */
  drainConsole(): string[];
}

/** Multi-tab browser session. Held across tool calls by the host executor. */
export interface BrowserDriver {
  /** Get-or-create a named tab. */
  tab(name: string): Promise<BrowserPage>;
  /** Snapshot of open tabs for `list_tabs`. */
  listTabs(): Array<{ name: string; url: string }>;
  /** Release one named tab; false when no such tab. */
  closeTab(name: string): Promise<boolean>;
  /** Release every tab; returns how many were closed. */
  closeAll(): Promise<number>;
  /** Tear the whole browser down (call on agent-loop end). */
  dispose(): Promise<void>;
}

/** Options handed to the backend factory. */
export interface BrowserDriverOptions {
  /** UA string to pin (attribution token or the "0sec-browser/1.0" default). */
  userAgent?: string;
  /** Extra headers Chrome attaches to every outgoing request (attribution). */
  extraHeaders?: Record<string, string>;
  /** When true, treat like public-network browsing (serviceWorkers blocked, etc.). */
  publicNetwork?: boolean;
  /**
   * Optional scope-pinned request sink. When supplied, the backend routes EVERY
   * page resource through it (mirrors tools.ts `context.route("**\/*") →
   * fetchTarget`) so no resource ever escapes scope. When omitted, the driver
   * falls back to pre-`goto` validation + a per-request scope check.
   */
  interceptor?: (req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array } | null>;
}

/** Factory contract — resolves a driver, or a guard error when the dep is missing. */
export type BrowserDriverFactory = (
  opts: BrowserDriverOptions,
) => Promise<{ driver: BrowserDriver } | { error: string }>;

/**
 * Minimal structural view of the backend module we lazily import. Local so the
 * module typechecks with no `playwright` types on disk. Only the members the
 * driver actually touches are declared.
 */
interface BackendModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<BackendBrowser>;
  };
}
interface BackendBrowser {
  newContext(opts: Record<string, unknown>): Promise<BackendContext>;
  close(): Promise<void>;
}
interface BackendContext {
  newPage(): Promise<BackendPage>;
  route(glob: string, handler: (route: unknown) => void): Promise<void>;
}
interface BackendPage {
  goto(url: string, opts: Record<string, unknown>): Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  click(selector: string, opts: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, opts: Record<string, unknown>): Promise<void>;
  type(selector: string, text: string, opts: Record<string, unknown>): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  content(): Promise<string>;
  screenshot(opts: Record<string, unknown>): Promise<Buffer>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: string, handler: (arg: unknown) => void): void;
  close(): Promise<void>;
}

/**
 * Default factory. Dynamically imports the playwright backend; on any import
 * failure (optional dep not installed) returns a clear, actionable error rather
 * than throwing — so the tool degrades gracefully exactly like `browserAction`
 * does today.
 *
 * The specifier is held in a variable so TypeScript treats `import(spec)` as
 * `Promise<any>` and does NOT try to resolve "playwright" at compile time — this
 * is what keeps the module typechecking with the optional dep absent.
 */
export const createBrowserDriver: BrowserDriverFactory = async (opts) => {
  const spec = "playwright";
  let mod: BackendModule;
  try {
    mod = (await import(spec)) as unknown as BackendModule;
  } catch {
    return { error: `browser backend not installed — run \`${BROWSER_INSTALL_HINT}\`` };
  }
  return { driver: new PlaywrightDriver(mod, opts) };
};

// ─────────────────────────────────────────────────────────────────────────────
// Concrete backend (playwright). Guarded behind the factory; never imported at
// module top level. Kept intentionally small — the scope-pinned `context.route`
// interception is stubbed to the `opts.interceptor` seam so the full transport
// wiring can be lifted from tools.ts during integration (WIRING TODO).
// ─────────────────────────────────────────────────────────────────────────────

class PlaywrightPage implements BrowserPage {
  private dialogs: string[] = [];
  private console: string[] = [];
  constructor(private readonly page: BackendPage) {
    page.on("dialog", (d) => {
      const dialog = d as { type(): string; message(): string; dismiss(): Promise<void> };
      this.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss().catch(() => {});
    });
    page.on("console", (m) => {
      if (this.console.length >= 50) return;
      const msg = m as { type(): string; text(): string };
      this.console.push(`[${msg.type()}] ${msg.text()}`);
    });
  }
  async goto(url: string, opts: { timeoutMs: number; waitUntil?: string }): Promise<BrowserNavResult> {
    const resp = await this.page.goto(url, {
      timeout: opts.timeoutMs,
      waitUntil: opts.waitUntil ?? "domcontentloaded",
    });
    return { url: this.page.url(), status: resp?.status() ?? null, title: await this.page.title() };
  }
  async click(selector: string, opts: { timeoutMs: number }): Promise<void> {
    await this.page.click(selector, { timeout: opts.timeoutMs });
    await this.page.waitForTimeout(300);
  }
  async type(selector: string, text: string, opts: { timeoutMs: number }): Promise<void> {
    await this.page.fill(selector, text, { timeout: opts.timeoutMs });
  }
  async evaluate(expression: string): Promise<unknown> {
    return this.page.evaluate(expression);
  }
  async content(): Promise<BrowserContent> {
    const html = await this.page.content();
    const text = (await this.page
      .evaluate("document.body ? document.body.innerText : ''")
      .catch(() => "")) as string;
    return { html, text };
  }
  async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "png", fullPage: false });
    return buf.toString("base64");
  }
  currentUrl(): string {
    return this.page.url();
  }
  drainDialogs(): string[] {
    const out = this.dialogs;
    this.dialogs = [];
    return out;
  }
  drainConsole(): string[] {
    const out = this.console;
    this.console = [];
    return out;
  }
}

class PlaywrightDriver implements BrowserDriver {
  private browser: BackendBrowser | null = null;
  private context: BackendContext | null = null;
  private readonly tabs = new Map<string, PlaywrightPage>();

  constructor(
    private readonly mod: BackendModule,
    private readonly opts: BrowserDriverOptions,
  ) {}

  private async ensureContext(): Promise<BackendContext> {
    if (this.context) return this.context;
    this.browser = await this.mod.chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      ...(this.opts.publicNetwork ? { serviceWorkers: "block" } : {}),
      ...(this.opts.userAgent ? { userAgent: this.opts.userAgent } : {}),
      ...(this.opts.extraHeaders && Object.keys(this.opts.extraHeaders).length > 0
        ? { extraHTTPHeaders: this.opts.extraHeaders }
        : {}),
    });
    // Scope-pinned transport (lifted from tools.ts `ensureBrowser`): route EVERY
    // page resource — the top document and every sub-resource, redirects included
    // — through the executor's `fetchTarget` sink so Chromium never resolves an
    // unchecked destination. The interceptor returns the fulfilled response, or
    // `null` to let the request continue directly (the executor returns null for
    // non-public scans, mirroring the old `if (!publicNetwork) route.continue()`).
    // A throw / missing response aborts the request (`blockedbyclient`).
    const interceptor = this.opts.interceptor;
    if (interceptor) {
      await this.context.route("**/*", async (route: unknown) => {
        const r = route as {
          request(): {
            url(): string;
            method(): string;
            allHeaders(): Promise<Record<string, string>>;
            postDataBuffer(): Buffer | null;
          };
          continue(): Promise<void>;
          abort(errorCode?: string): Promise<void>;
          fulfill(opts: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
        };
        try {
          const request = r.request();
          const headers = await request.allHeaders();
          const post = request.postDataBuffer();
          const result = await interceptor({
            url: request.url(),
            method: request.method(),
            headers,
            body: post ? new Uint8Array(post) : undefined,
          });
          if (!result) {
            await r.continue();
            return;
          }
          await r.fulfill({ status: result.status, headers: result.headers, body: Buffer.from(result.body) });
        } catch {
          await r.abort("blockedbyclient").catch(() => {});
        }
      });
    }
    return this.context;
  }

  async tab(name: string): Promise<BrowserPage> {
    const existing = this.tabs.get(name);
    if (existing) return existing;
    const ctx = await this.ensureContext();
    const page = new PlaywrightPage(await ctx.newPage());
    this.tabs.set(name, page);
    return page;
  }

  listTabs(): Array<{ name: string; url: string }> {
    return [...this.tabs.entries()].map(([name, page]) => ({ name, url: page.currentUrl() }));
  }

  async closeTab(name: string): Promise<boolean> {
    const page = this.tabs.get(name);
    if (!page) return false;
    this.tabs.delete(name);
    // The underlying BackendPage close is reached via the concrete page; the
    // interface intentionally hides it (callers close by name).
    await (page as unknown as { page?: { close(): Promise<void> } }).page?.close().catch(() => {});
    return true;
  }

  async closeAll(): Promise<number> {
    const n = this.tabs.size;
    for (const name of [...this.tabs.keys()]) await this.closeTab(name);
    return n;
  }

  async dispose(): Promise<void> {
    await this.closeAll();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler. Standalone `executeBrowser(ctx, args)` that routes actions and gates
// navigation through scope. Deps are injectable so the "backend not installed"
// path and arg-validation are unit-testable without a real browser.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Narrow slice of {@link import("../types.js").ToolContext} the browser handler
 * needs. A real `ToolContext` is assignable to this, so the eventual
 * `ToolExecutor.browserAction` can call `executeBrowser(this.ctx, args, ...)`
 * without adaptation.
 */
export interface BrowserToolContext {
  target: string;
  scope?: ScopePolicy;
  publicNetwork?: { readonly scope?: ScopePolicy };
}

/** Per-session driver holder, kept by the host executor across tool calls. */
export interface BrowserDriverHost {
  driver?: BrowserDriver | null;
}

export interface BrowserToolDeps {
  /** Override the backend factory (tests inject a fake or a forced-missing one). */
  createDriver?: BrowserDriverFactory;
  /** Cross-call driver cache. When omitted, a fresh driver is made per call. */
  host?: BrowserDriverHost;
  /** Per-action timeout in ms (default 10s, matching browserAction today). */
  actionTimeoutMs?: number;
  /**
   * UA to pin on the browser context (attribution token, or the executor's
   * `0sec-browser/1.0` default). Threaded straight into
   * {@link BrowserDriverOptions.userAgent} on the first driver acquisition.
   */
  userAgent?: string;
  /** Attribution headers Chrome attaches to every in-scope request. */
  extraHeaders?: Record<string, string>;
  /**
   * The executor's scope-pinned request transport (the `context.route →
   * fetchTarget` mechanism). When supplied, every page sub-resource is routed
   * through it so nothing escapes scope; see {@link BrowserDriverOptions.interceptor}.
   */
  interceptor?: BrowserDriverOptions["interceptor"];
}

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

function fail(error: string): ToolResult {
  return { success: false, output: null, error };
}

/** Effective scope for browser egress — public-network scope wins when set. */
function effectiveScope(ctx: BrowserToolContext): ScopePolicy | undefined {
  return ctx.publicNetwork ? ctx.publicNetwork.scope : ctx.scope;
}

/**
 * Gate a candidate navigation URL. Mirrors http_request/crawl: reject anything
 * scope refuses. (Full parity uses tools.ts `validateTargetUrl`, which also
 * pins same-origin for non-public scans; the scaffold uses `scope.match` — the
 * same primitive `validateTargetUrl` ends in — and leaves the same-origin
 * refinement as a WIRING TODO when this replaces browserAction.)
 */
function gateUrl(ctx: BrowserToolContext, url: string): { ok: true } | { ok: false; reason: string } {
  const scope = effectiveScope(ctx);
  if (!scope) return { ok: true }; // unscoped scans keep today's behaviour
  const verdict = scope.match(url);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  return { ok: true };
}

/**
 * The browser tool handler. Routes the `action` enum, gates navigation targets,
 * and returns a plain {@link ToolResult}. Screenshots ride in `output` as base64
 * (rendering a real image card is a WIRING TODO — ToolResultMeta has no image
 * kind yet).
 */
export async function executeBrowser(
  ctx: BrowserToolContext,
  args: Record<string, unknown>,
  deps: BrowserToolDeps = {},
): Promise<ToolResult> {
  const action = args.action as string | undefined;
  if (!action) return fail("action is required");
  if (!(BROWSER_ACTIONS as readonly string[]).includes(action)) {
    return fail(`Unknown browser action: ${action}. Valid: ${BROWSER_ACTIONS.join(", ")}`);
  }

  const timeoutMs = deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const tabName = typeof args.tab === "string" && args.tab.length > 0 ? args.tab : DEFAULT_TAB;
  const factory = deps.createDriver ?? createBrowserDriver;
  const host = deps.host;

  // Lazy, guarded driver acquisition. A missing backend degrades to a clear,
  // actionable error — never an import-time throw.
  let driver = host?.driver ?? null;
  if (!driver) {
    const made = await factory({
      publicNetwork: !!ctx.publicNetwork,
      userAgent: deps.userAgent,
      extraHeaders: deps.extraHeaders,
      interceptor: deps.interceptor,
    });
    if ("error" in made) return fail(made.error);
    driver = made.driver;
    if (host) host.driver = driver;
  }

  try {
    switch (action as BrowserAction) {
      case "list_tabs":
        return { success: true, output: { tabs: driver.listTabs() } };

      case "close": {
        if (args.all === true) {
          const closed = await driver.closeAll();
          return { success: true, output: { closed } };
        }
        const ok = await driver.closeTab(tabName);
        return { success: true, output: { closed: ok ? 1 : 0, tab: tabName } };
      }

      case "navigate": {
        const rawUrl = args.url as string | undefined;
        if (!rawUrl) return fail("url is required for navigate");
        const gate = gateUrl(ctx, rawUrl);
        if (!gate.ok) return fail(`navigate refused: out-of-scope URL '${rawUrl}' (${gate.reason})`);
        const page = await driver.tab(tabName);
        const nav = await page.goto(rawUrl, { timeoutMs });
        // Post-navigation redirect re-check (0sec#218): goto follows redirects,
        // so an in-scope URL that 302s off-origin must be refused before any
        // subsequent action operates on a foreign page.
        const post = gateUrl(ctx, nav.url);
        if (!post.ok) {
          return fail(`navigate refused: redirected to out-of-scope URL '${nav.url}' (${post.reason})`);
        }
        return {
          success: true,
          output: {
            tab: tabName,
            url: nav.url,
            status: nav.status,
            title: nav.title,
            dialogs: page.drainDialogs(),
            console: page.drainConsole().slice(0, 20),
          },
        };
      }

      case "click": {
        const selector = args.selector as string | undefined;
        if (!selector) return fail("selector is required for click");
        const page = await driver.tab(tabName);
        await page.click(selector, { timeoutMs });
        return {
          success: true,
          output: {
            tab: tabName,
            clicked: selector,
            url: page.currentUrl(),
            dialogs: page.drainDialogs(),
            console: page.drainConsole().slice(0, 20),
          },
        };
      }

      case "type": {
        const selector = args.selector as string | undefined;
        const text = args.text as string | undefined;
        if (!selector) return fail("selector is required for type");
        if (text === undefined) return fail("text is required for type");
        const page = await driver.tab(tabName);
        await page.type(selector, text, { timeoutMs });
        return { success: true, output: { tab: tabName, filled: selector, dialogs: page.drainDialogs() } };
      }

      case "eval": {
        const expression = args.value as string | undefined;
        if (!expression) return fail("value (JavaScript) is required for eval");
        const page = await driver.tab(tabName);
        const raw = await page.evaluate(expression).catch((e: Error) => `Error: ${e.message}`);
        const result = typeof raw === "object" ? safeStringify(raw) : String(raw);
        return {
          success: true,
          output: { tab: tabName, result, dialogs: page.drainDialogs(), console: page.drainConsole().slice(0, 20) },
        };
      }

      case "get_content": {
        const page = await driver.tab(tabName);
        const { html, text } = await page.content();
        return {
          success: true,
          output: {
            tab: tabName,
            url: page.currentUrl(),
            html: html.slice(0, 10_000),
            text: text.slice(0, 5_000),
            dialogs: page.drainDialogs(),
          },
        };
      }

      case "screenshot": {
        const page = await driver.tab(tabName);
        const url = page.currentUrl();
        // Full base64 for the display-only image card (never sent to the model);
        // a bounded copy rides `output` for the model-facing string, as before.
        const fullBase64 = await page.screenshot();
        const dims = pngDimensions(fullBase64);
        return {
          success: true,
          output: {
            tab: tabName,
            url,
            screenshot_base64: fullBase64.slice(0, 50_000),
            dialogs: page.drainDialogs(),
          },
          meta: {
            kind: "image",
            image: {
              imageBase64: fullBase64,
              mimeType: "image/png",
              width: dims?.width ?? 0,
              height: dims?.height ?? 0,
              caption: url,
            },
          },
        };
      }
    }
    // Exhaustive — every BrowserAction is handled above.
    return fail(`Unhandled browser action: ${action}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: null, error: msg.slice(0, 2_000) };
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Decode a PNG's pixel dimensions from the IHDR chunk of its base64 payload.
 * A PNG begins with an 8-byte signature, then the IHDR chunk whose width and
 * height are big-endian uint32s at byte offsets 16 and 20. Only the first ~24
 * bytes are decoded; returns undefined for anything that isn't a PNG. Kept
 * local so the module needs no image lib and still typechecks with no browser.
 */
function pngDimensions(base64: string): { width: number; height: number } | undefined {
  try {
    // 32 base64 chars → 24 bytes, enough to reach the end of the IHDR fields.
    const head = Buffer.from(base64.slice(0, 32), "base64");
    if (head.length < 24) return undefined;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    if (head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) return undefined;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (width <= 0 || height <= 0) return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRING TODOs (registration requires editing shared / not-owned files):
//
// 1. REGISTRY (packages/core/src/agent/tools/index.ts + dispatch.ts — editable):
//    - remove `browser` from reconToolDefinitions (recon.ts) and reconDispatch,
//    - add `...browserToolDefinitions` to DOMAIN_DEFINITIONS and
//      `import { browserToolDefinitions, browserDispatch } from "./browser.js"`,
//    - add `...browserDispatch` to TOOL_DISPATCH in dispatch.ts.
//    NOTE: dispatch.test.ts asserts registry⇄dispatch⇄method symmetry, so this
//    must land together with step 2 or the suite fails.
//
// 2. EXECUTOR (packages/core/src/agent/tools.ts — shared monolith, NOT owned by
//    this task): rewire `ToolExecutor.browserAction(args)` to delegate:
//        return executeBrowser(this.ctx, args, { host: this._browserHost });
//    holding a `_browserHost: BrowserDriverHost = {}` field and disposing
//    `this._browserHost.driver` in `cleanup()`. Pass the scope-pinned interceptor
//    (the existing `context.route → fetchTarget` block) into `createBrowserDriver`
//    via BrowserDriverOptions.interceptor, and pass userAgent/extraHeaders from
//    `this.ctx.attribution`. The old inline playwright `ensureBrowser`/switch is
//    then deleted.
//
// 3. package.json: NO CHANGE NEEDED — `playwright: "^1.52.0"` is already an
//    optionalDependency. (If puppeteer-core were chosen instead it would be
//    `puppeteer-core: "^24"` — but see the DEPENDENCY DECISION header.)
//
// 4. CARD RENDERING (chat-screen.tsx / ToolCard.tsx — NOT owned): to draw a
//    screenshot as an image card, add a `browser`/`image` kind to
//    ToolResultMeta (types.ts) and populate `meta` from the screenshot result;
//    ToolCard then renders the base64 PNG. Until then screenshots ride in
//    `output.screenshot_base64` as they do today.
// ─────────────────────────────────────────────────────────────────────────────
