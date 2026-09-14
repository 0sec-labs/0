/**
 * Scope-gated, multi-tab browser tool backed by optional Playwright.
 * Required arguments are checked before backend acquisition. ToolExecutor owns
 * the driver lifecycle and the scope-pinned network interceptor.
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
  "attach",
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
      "page and capture dialogs/console — the primary XSS signal), list_tabs, close, " +
      "attach (connect over CDP to an operator's ALREADY-AUTHENTICATED Chrome so new tabs " +
      "inherit its cookies/MFA/SSO session — for testing post-auth flows, IDOR/CSRF/XSS). " +
      "Every navigation is gated through the engagement scope exactly like http_request/crawl, " +
      "including on a CDP-attached context.",
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
      cdp_url: {
        type: "string",
        description:
          "attach: the operator's Chrome CDP endpoint (e.g. http://127.0.0.1:9222), launched with " +
          "--remote-debugging-port. New tabs open in the browser's already-authenticated context so " +
          "cookies/MFA/SSO carry over. Only ever supply an endpoint the operator explicitly provides.",
      },
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
   * OPT-IN CDP attach. When set, the driver connects to an ALREADY-RUNNING,
   * operator-authenticated Chrome via `chromium.connectOverCDP(cdpEndpoint)`
   * (an http url like `http://127.0.0.1:9222` or a ws devtools endpoint) and
   * ADOPTS that browser's existing context — so new tabs inherit its
   * cookies/MFA/SSO session — instead of launching a fresh, clean browser.
   * Never auto-discovered: only ever set from an explicit operator-supplied url.
   */
  cdpEndpoint?: string;
  /**
   * Launch a headed (non-headless) browser and reduce a couple of the most
   * obvious automation fingerprints. Ignored on the CDP-attach path (the
   * operator's Chrome is already a real, headed browser). Default false.
   */
  headed?: boolean;
  /**
   * Optional scope-pinned request sink supplied by ToolExecutor. It mediates
   * page requests. Without it, handler URL checks do not isolate subresources.
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
    launch(opts: { headless: boolean; args?: string[] }): Promise<BackendBrowser>;
    /** Connect to a running Chrome over the DevTools Protocol (CDP-attach path). */
    connectOverCDP(endpointURL: string): Promise<BackendBrowser>;
  };
}
interface BackendBrowser {
  newContext(opts: Record<string, unknown>): Promise<BackendContext>;
  /** Existing contexts — for CDP-attach, `contexts()[0]` is the authed default context. */
  contexts(): BackendContext[];
  close(): Promise<void>;
}
interface BackendContext {
  newPage(): Promise<BackendPage>;
  /** Pages already open in the context (used only to count adopted operator tabs). */
  pages(): BackendPage[];
  route(glob: string, handler: (route: unknown) => void): Promise<void>;
  addInitScript(script: string): Promise<void>;
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
// Optional Playwright backend; ToolExecutor supplies the scope-pinned interceptor.
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

export class PlaywrightDriver implements BrowserDriver {
  private browser: BackendBrowser | null = null;
  private context: BackendContext | null = null;
  /** True when `context` is a CDP-adopted operator context we must not tear down. */
  private adopted = false;
  private readonly tabs = new Map<string, PlaywrightPage>();

  constructor(
    private readonly mod: BackendModule,
    private readonly opts: BrowserDriverOptions,
  ) {}

  private async ensureContext(): Promise<BackendContext> {
    if (this.context) return this.context;

    if (this.opts.cdpEndpoint) {
      // ── CDP-attach path (opt-in) ──────────────────────────────────────────
      // Connect to the operator's already-running, already-authenticated Chrome
      // and ADOPT its existing context so newly opened tabs inherit the live
      // cookies/MFA/SSO session. We reuse the default context rather than making
      // a clean one (`newContext` would start unauthenticated and defeat the
      // whole point). The operator's browser is never launched or closed by us.
      this.browser = await this.mod.chromium.connectOverCDP(this.opts.cdpEndpoint);
      const existing = this.browser.contexts();
      if (existing.length > 0) {
        this.context = existing[0];
        this.adopted = true;
      } else {
        // Degenerate case: a CDP target with no context yet. Fall back to a new
        // one (still on the operator's browser) so attach doesn't hard-fail.
        this.context = await this.browser.newContext({ ignoreHTTPSErrors: true });
        this.adopted = false;
      }
    } else {
      this.browser = await this.mod.chromium.launch({
        headless: !this.opts.headed,
        ...(this.opts.headed ? { args: ["--disable-blink-features=AutomationControlled"] } : {}),
      });
      this.context = await this.browser.newContext({
        ignoreHTTPSErrors: true,
        ...(this.opts.publicNetwork ? { serviceWorkers: "block" } : {}),
        ...(this.opts.userAgent ? { userAgent: this.opts.userAgent } : {}),
        ...(this.opts.extraHeaders && Object.keys(this.opts.extraHeaders).length > 0
          ? { extraHTTPHeaders: this.opts.extraHeaders }
          : {}),
      });
      // Trim the most obvious automation fingerprint when running headed/stealth.
      if (this.opts.headed) {
        await this.context
          .addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
          .catch(() => {});
      }
    }
    // Scope-pinned transport (lifted from tools.ts `ensureBrowser`): route EVERY
    // page resource — the top document and every sub-resource, redirects included
    // — through the executor's `fetchTarget` sink so Chromium never resolves an
    // unchecked destination. The interceptor returns the fulfilled response, or
    // `null` to let the request continue directly (the executor returns null for
    // non-public scans, mirroring the old `if (!publicNetwork) route.continue()`).
    // A throw / missing response aborts the request (`blockedbyclient`).
    //
    // CDP-attach limitation (documented): the route is installed on the adopted
    // operator context, so it governs every NEW page and every future
    // navigation/sub-resource on it — which is what the agent drives. It does
    // NOT retroactively cover the operator's pre-existing tabs, in-flight
    // requests, or service-worker fetches, and `connectOverCDP` interception is
    // "lower fidelity" than a launched context (per Playwright's own note). We
    // mitigate this by NEVER adopting the operator's open pages as agent tabs:
    // `tab()` always opens a fresh page, and the agent can only reach it through
    // the scope-gated `navigate` action — so scope still governs every page the
    // agent actually touches, external context or not.
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
    // Always release the pages WE opened. For an adopted CDP context we then
    // only sever the DevTools connection (never close the operator's context) so
    // their authenticated browser and its tabs survive. For a launched browser
    // we close it fully as before. `browser.close()` on a `connectOverCDP`
    // connection disconnects Playwright without shutting down the real Chrome.
    await this.closeAll();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.adopted = false;
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
 * needs. ToolExecutor passes its context directly.
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
  /** Launch headed + light stealth on the LAUNCH path (ignored for CDP-attach). */
  headed?: boolean;
}

const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** Accept only the CDP endpoint shapes Playwright's connectOverCDP understands. */
function isValidCdpEndpoint(value: string): boolean {
  return /^(https?|wss?):\/\/.+/i.test(value);
}

function fail(error: string): ToolResult {
  return { success: false, output: null, error };
}

/** Effective scope for browser egress — public-network scope wins when set. */
function effectiveScope(ctx: BrowserToolContext): ScopePolicy | undefined {
  return ctx.publicNetwork ? ctx.publicNetwork.scope : ctx.scope;
}

/**
 * Check the effective engagement scope. ToolExecutor's interceptor separately
 * validates and pins each network request.
 */
function gateUrl(ctx: BrowserToolContext, url: string): { ok: true } | { ok: false; reason: string } {
  const scope = effectiveScope(ctx);
  if (!scope) return { ok: true }; // unscoped scans keep today's behaviour
  const verdict = scope.match(url);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason };
  return { ok: true };
}

/**
 * Route browser actions and gate navigation targets. Screenshot results retain
 * PNG base64 together with image metadata.
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

  switch (action as BrowserAction) {
    case "navigate": {
      if (typeof args.url !== "string" || !args.url) return fail("url is required for navigate");
      const gate = gateUrl(ctx, args.url);
      if (!gate.ok) return fail(`navigate refused: out-of-scope URL '${args.url}' (${gate.reason})`);
      break;
    }
    case "click":
    case "type":
      if (typeof args.selector !== "string" || !args.selector) return fail(`selector is required for ${action}`);
      if (action === "type" && typeof args.text !== "string") return fail("text is required for type");
      break;
    case "eval":
      if (typeof args.value !== "string" || !args.value) return fail("value (JavaScript) is required for eval");
      break;
    case "attach":
      if (typeof args.cdp_url !== "string" || !args.cdp_url) return fail("cdp_url is required for attach");
      if (!isValidCdpEndpoint(args.cdp_url)) {
        return fail(
          `attach refused: cdp_url '${args.cdp_url}' is not a CDP endpoint (expected http(s):// or ws(s)://, e.g. http://127.0.0.1:9222)`,
        );
      }
      break;
  }

  const timeoutMs = deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const tabName = typeof args.tab === "string" && args.tab.length > 0 ? args.tab : DEFAULT_TAB;
  const factory = deps.createDriver ?? createBrowserDriver;
  const host = deps.host;

  // OPT-IN CDP attach: only the `attach` action carries a cdp_url, so the launch
  // path is completely unchanged for every other action. `attach` (re)connects
  // to the operator's authed Chrome, so if a driver already exists (a prior
  // launch, or an earlier attach) we tear it down first and reconnect fresh.
  const cdpEndpoint = action === "attach" ? (args.cdp_url as string) : undefined;
  if (action === "attach" && host?.driver) {
    await host.driver.dispose().catch(() => {});
    host.driver = null;
  }

  // Lazy, guarded driver acquisition. A missing backend degrades to a clear,
  // actionable error — never an import-time throw.
  let driver = host?.driver ?? null;
  if (!driver) {
    const made = await factory({
      publicNetwork: !!ctx.publicNetwork,
      userAgent: deps.userAgent,
      extraHeaders: deps.extraHeaders,
      interceptor: deps.interceptor,
      cdpEndpoint,
      headed: deps.headed,
    });
    if ("error" in made) return fail(made.error);
    driver = made.driver;
    if (host) host.driver = driver;
  }

  try {
    switch (action as BrowserAction) {
      case "attach": {
        // Force the CDP connection now (ensureContext runs on first tab()) so a
        // bad endpoint surfaces here as a clear error, and open one fresh,
        // authenticated page the agent can immediately navigate (scope-gated).
        await driver.tab(tabName);
        return {
          success: true,
          output: {
            attached: true,
            cdp_url: cdpEndpoint,
            tab: tabName,
            tabs: driver.listTabs(),
            note:
              "Connected to the operator's authenticated Chrome over CDP. New tabs share its " +
              "cookies/session; navigate (scope-gated) to reach an in-scope authenticated page.",
          },
        };
      }

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
        const rawUrl = args.url as string;
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
        const selector = args.selector as string;
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
        const selector = args.selector as string;
        const text = args.text as string;
        const page = await driver.tab(tabName);
        await page.type(selector, text, { timeoutMs });
        return { success: true, output: { tab: tabName, filled: selector, dialogs: page.drainDialogs() } };
      }

      case "eval": {
        const expression = args.value as string;
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

