/**
 * Coverage seed for `@0/cli`'s `dashboard` command. This is the local
 * mission-control HTTP server (1.5k LoC, zero tests before this seed) —
 * it spawns a Node http server, opens a browser, manages the orchestrator
 * daemon child process, and exposes a control-token-gated POST surface
 * over `/api/control/*`. Every regression here ships silently:
 *
 *   • A bad port validation lets the action explode mid-listen.
 *   • A missing control-token check on /api/control/* would expose CSRF.
 *   • A leaked daemon child (no kill on stop-daemon) would orphan workers.
 *   • Path-traversal escapes from resolveAssetPath would leak local files.
 *
 * Strategy: mock the four heavy boundaries at the module level so we
 * never spawn a real HTTP server, open a real browser, spawn a real
 * orchestrator, or touch the WASM SQLite DB:
 *
 *   • `node:http`         — capture the request handler + listen call.
 *   • `node:child_process` — capture execFile (browser) + spawn (daemon).
 *   • `node:fs`            — fake existsSync/readFileSync so the asset
 *                            dir resolves and HTML "files" round-trip.
 *   • `@0/db`         — fake osecDB (no native bindings, no WAL).
 *   • `./orchestrate.js`   — fake recoverStaleWorkers (dynamic import).
 *   • `./db.js`            — fake seedVerificationWorkbench (dynamic import).
 *
 * The createServer fake captures the handler so individual tests can
 * fabricate IncomingMessage / ServerResponse pairs and drive `/api/*`
 * directly. The `server.listen()` callback is invoked synchronously
 * so we exercise the browser-open + log-banner code path too.
 *
 * Test areas covered:
 *   • CLI argument validation — port must be 1..65535 (rejects 0,
 *     negative, >65535, non-integer); default applied when omitted.
 *   • Dashboard asset directory resolution — found vs not-found cases.
 *   • Browser auto-open is suppressed by --no-open; happens otherwise.
 *   • Control-token gate — POST /api/control/* with wrong / missing
 *     token returns 403 (the load-bearing CSRF defense).
 *   • Control-token gate — non-POST method on control returns 405.
 *   • /api/dashboard GET — opens DB, lists scans/findings/verdicts,
 *     closes DB in finally.
 *   • /api/scans GET — minimal payload, DB lifecycle.
 *   • /api/events/recent — limit clamped to [1, 100], default 20.
 *   • /api/scans/:id — 404 on missing, OK on found, suffix routing
 *     (/events, /findings).
 *   • /api/finding-family/:fp — triage POST + workflow POST threaded
 *     into the DB updater with normalized status.
 *   • /api/control/start-daemon — refuses to start if heartbeats are
 *     fresh (409 conflict).
 *   • /api/control/start-daemon — spawns child with the orchestrate
 *     argv when no active heartbeats; child is unref'd.
 *   • /api/control/stop-daemon — SIGTERMs live workers AND any
 *     managed child this process owns.
 *   • /api/control/reset-database — refuses if active workers exist
 *     (409); otherwise calls resetOsecDatabase + reseeds.
 *   • /api/control/launch-run — validates inputs and delegates assessment
 *     ownership to the same persistent workflow engine without CLI children.
 *   • Unknown /api/* path → 404 fallthrough.
 *   • Non-/api/* request → falls through to static asset serve;
 *     unknown extension returns 404; HTML root injects control token.
 *   • Path-traversal probe (`/..\/etc\/passwd`) is rejected by
 *     resolveAssetPath (returns null, falls through to index.html
 *     injection — the assetDir-prefix invariant holds).
 *
 * Out of scope (refactor required — noted in PR body):
 *   • The dashboard helpers (groupFindings, buildWorkflowSummary,
 *     summarizeQueue, buildCases, parseScanPath, parseControlPath …)
 *     are file-internal. We exercise them through the HTTP surface;
 *     promoting them to named exports would let us drop the fake
 *     server + drive them directly. Not worth blocking the seed.
 *   • The SIGINT handler calls process.exit(0) inline — exercising
 *     the close-then-exit chain would need a child-process harness.
 *   • The real chalk-coloured banner is not asserted exactly; only
 *     the URL substring downstream relays may parse.
 *
 * Precedent: PR #310 (`mcp-server.test.ts`) for the SIGTERM listener
 * leak-cleanup, PR #309 (`db.test.ts`) for the DB-lifecycle assertion
 * shape, PR #307 (`disclose.test.ts`) for the dynamic-import mock
 * pattern, PR #301 (`run.test.ts`) for the Commander harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { EventEmitter } from "node:events";

// ── Module-level mocks ──────────────────────────────────────────────────────

// node:http — capture the createServer handler and listen call. The
// server stub records (port, host) and invokes the listening callback
// synchronously so the action exercises the open-browser path.
type RequestHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => unknown;

vi.mock("../../local-engine.js", () => ({ assertLocalEngineAvailable: vi.fn(), registerLocalEngine: vi.fn(() => vi.fn()) }));

const instanceMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock("../../web/dashboard-instance.js", () => ({ findDashboardInstance: instanceMock }));

const httpState: {
  lastHandler: RequestHandler | null;
  listenCalls: Array<{ port: number; host: string }>;
  closeCalled: boolean;
} = { lastHandler: null, listenCalls: [], closeCalled: false };

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    createServer(handler: RequestHandler) {
      httpState.lastHandler = handler;
      return {
        listen(port: number, host: string, cb?: () => void) {
          httpState.listenCalls.push({ port, host });
          if (cb) cb();
          return this;
        },
        on() { return this; },
        once() {
          return this;
        },
        address() {
          const binding = httpState.listenCalls.at(-1);
          if (!binding) return null;
          return {
            address: binding.host,
            family: binding.host.includes(":") ? "IPv6" : "IPv4",
            port: binding.port === 0 ? 46123 : binding.port,
          };
        },
        close(cb?: () => void) {
          httpState.closeCalled = true;
          if (cb) cb();
          return this;
        },
      };
    },
  };
});

// node:child_process — capture execFile (browser auto-open) and spawn
// (orchestrator daemon, scan run). The fake child is just enough of
// ChildProcess for `child.unref()`, `child.once("exit", …)`,
// `child.kill("SIGTERM")`, and the `.pid` / `.exitCode` / `.killed`
// fields the dashboard reads back.
const execFileMock = vi.fn();
const spawnMock = vi.fn();

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  killed = false;
  killSignals: string[] = [];
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  unref(): void {
    /* no-op */
  }
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killSignals.push(String(signal));
    this.killed = true;
    return true;
  }
}

const spawnedChildren: FakeChild[] = [];
let nextChildPid = 1000;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      execFileMock(...args);
      // Mimic the no-op callback signature; openBrowser uses execFile(cmd, args, () => {}).
      return new FakeChild(nextChildPid++);
    },
    spawn: (...args: unknown[]) => {
      spawnMock(...args);
      const child = new FakeChild(nextChildPid++);
      spawnedChildren.push(child);
      return child;
    },
  };
});

// node:fs — the dashboard does (a) `existsSync` to pick an asset dir,
// (b) `existsSync` again per-request to verify the resolved asset,
// (c) `readFileSync` to serve the file body. We say "yes, exists"
// for the first asset dir candidate and the index.html, "no" for
// anything path-traversal-shaped. readFileSync returns a stub HTML
// body with a </head> tag so the control-token injection has a hook.
const fsState: {
  existsPaths: Set<string>;
  readBodies: Map<string, string>;
} = { existsPaths: new Set(), readBodies: new Map() };

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => fsState.existsPaths.has(p),
    readFileSync: (p: string) => {
      const body = fsState.readBodies.get(p);
      if (body === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return Buffer.from(body, "utf-8");
    },
  };
});

// @0/db — fake osecDB plus resetOsecDatabase. We log every
// constructor + method call so we can assert on lifecycle (always
// close in finally) and argument plumbing.
interface FakeWorker {
  id: string;
  status: string;
  label: string;
  pid?: number | null;
  heartbeatAt: string;
  lastError?: string | null;
  host?: string | null;
}

const dbState: {
  ctorPaths: Array<string | undefined>;
  closes: number;
  workers: FakeWorker[];
  upserts: Array<Record<string, unknown>>;
  deleteByStatusCalls: string[];
  triageUpdates: Array<{ fp: string; status: string; note?: string }>;
  workflowUpdates: Array<{ fp: string; status: string; assignee: string | null }>;
  scans: Array<{
    id: string;
    target: string;
    depth: string;
    runtime: string;
    mode: string;
    status: string;
    startedAt: string;
  }>;
  findings: Array<{
    id: string;
    scanId: string;
    fingerprint?: string | null;
    [key: string]: unknown;
  }>;
  recentEvents: Array<{
    id: string;
    scanId: string;
    scanTarget: string;
    stage: string;
    eventType: string;
    payload: string;
    timestamp: number;
  }>;
} = {
  ctorPaths: [],
  closes: 0,
  workers: [],
  upserts: [],
  deleteByStatusCalls: [],
  triageUpdates: [],
  workflowUpdates: [],
  scans: [],
  findings: [],
  recentEvents: [],
};

const resetOsecDatabaseMock = vi.fn();

vi.mock("@0/db", () => {
  // The web workflow service owns a separate definition/history store.
  // Keep that boundary mocked too, rather than opening SQLite in HTTP tests.
  class FakeLearningStore {
    listEvents(): unknown[] { return []; }
    listKnowledge(): unknown[] { return []; }
    listCandidates(): unknown[] { return []; }
    queueStatus() { return { pending: 0, claimed: 0, completed: 0 }; }
    claimWork(): null { return null; }
    recordExperience(): void {}
    close(): void {}
  }
  class FakeSecurityWorkflowStore {
    learningStore() { return new FakeLearningStore(); }
    interruptActiveExecutions(): number { return 0; }
    list(): unknown[] { return []; }
    close(): void {}
  }
  class FakeSecurityWorkflowStoreError extends Error {
    constructor(message: string, readonly statusCode: number) { super(message); }
  }
  class FakeOsecDB {
    constructor(dbPath?: string) {
      dbState.ctorPaths.push(dbPath);
    }
    listScans(): unknown[] {
      return dbState.scans;
    }
    listFindings(): unknown[] {
      return dbState.findings;
    }
    listFindingFamiliesByBusinessPriority() {
      const families = new Map<string, typeof dbState.findings>();
      for (const finding of dbState.findings) {
        const key = finding.fingerprint ?? finding.id;
        const rows = families.get(key) ?? [];
        rows.push(finding);
        families.set(key, rows);
      }
      return [...families.entries()].map(([key, rows]) => ({
        key, latest: [...rows].sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0],
        count: rows.length, scanCount: new Set(rows.map(row => row.scanId)).size,
        verdictCounts: { truePositive: 0, falsePositive: 0, unsure: 0, total: 0 }, activeSessions: [],
      }));
    }
    updateFindingImpactAssessment(id: string, impactAssessment: unknown): boolean {
      const finding = dbState.findings.find(row => row.id === id);
      if (!finding) return false;
      finding.impactAssessment = impactAssessment === null ? null : JSON.stringify(impactAssessment);
      return true;
    }
    listVerdicts(): unknown[] {
      return [];
    }
    listSessions(): unknown[] {
      return [];
    }
    listWorkers(): FakeWorker[] {
      return dbState.workers;
    }
    listWorkItems(): unknown[] {
      return [];
    }
    listCases(): unknown[] {
      return [];
    }
    listRecentEvents(): unknown[] {
      return dbState.recentEvents;
    }
    listArtifacts(): unknown[] {
      return [];
    }
    getScan(id: string): unknown {
      return dbState.scans.find((s) => s.id === id);
    }
    getFindings(): unknown[] {
      return [];
    }
    getEvents(): unknown[] {
      return [];
    }
    getRelatedFindings(): unknown[] {
      return [];
    }
    deleteWorkersByStatus(status: string): number {
      dbState.deleteByStatusCalls.push(status);
      return 2;
    }
    upsertWorker(record: Record<string, unknown>): void {
      dbState.upserts.push(record);
    }
    updateFindingTriageByFingerprint(fp: string, status: string, note?: string): void {
      dbState.triageUpdates.push({ fp, status, note });
    }
    updateFindingWorkflowByFingerprint(fp: string, status: string, assignee: string | null): void {
      dbState.workflowUpdates.push({ fp, status, assignee });
    }
    close(): void {
      dbState.closes += 1;
    }
  }
  return {
    osecDB: FakeOsecDB,
    // Identity persistence is covered by the real registry suite; this fake DB
    // never creates on-disk state, including adjacent engine identity files.
    resolveOsecDbPath: () => ":memory:",
    WorkflowTriggerStore: class {
      list() { return []; }
      close() {}
    },
    nextWorkflowTriggerFire: () => new Date().toISOString(),
    SecurityWorkflowStore: FakeSecurityWorkflowStore,
    SecurityWorkflowStoreError: FakeSecurityWorkflowStoreError,
    LearningStore: FakeLearningStore,
    LearningStoreError: FakeSecurityWorkflowStoreError,
    learningProjectId: (root: string) => root,
    resetOsecDatabase: resetOsecDatabaseMock,
  };
});

// Dynamic imports — recoverStaleWorkers (orchestrate.js) and
// seedVerificationWorkbench (db.js). Vitest hoists vi.mock so the
// dynamic await import() in handleApiRequest also hits these stubs.
const recoverStaleWorkersMock = vi.fn();
vi.mock("../orchestrate.js", () => ({
  recoverStaleWorkers: recoverStaleWorkersMock,
}));

const seedVerificationWorkbenchMock = vi.fn();
vi.mock("../db.js", () => ({
  seedVerificationWorkbench: seedVerificationWorkbenchMock,
}));

const engineInvoke = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const engineReady = vi.hoisted(() => vi.fn(async () => {}));
const engineDispose = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../workflow-engine-service.js", () => ({ WorkflowEngineService: class {
  ready = engineReady();
  invoke = engineInvoke;
  dispose = engineDispose;
} }));
const skillsHttp = vi.hoisted(() => ({
  list: vi.fn(() => ({ skills: [], mounts: [], diagnostics: [] })),
  create: vi.fn((input: unknown) => ({ id: "mount/workspace/test-review", input })),
  get: vi.fn((id: string) => ({ id, content: "standard skill" })),
  export: vi.fn((id: string) => ({ format: "agent-skill", version: 1, name: "test-review", id, files: [] })),
  import: vi.fn(() => ({ id: "mount/workspace/imported-review" })),
  update: vi.fn((id: string, input: unknown) => ({ id, input })),
  mount: vi.fn(() => ({ id: "mount-one" })),
  unmount: vi.fn(),
}));
vi.mock("../../web/skills.js", () => ({ SkillsStore: class {
  discoveryOptions() { return { homeDir: null, mounts: [] }; }
  list = skillsHttp.list; create = skillsHttp.create; get = skillsHttp.get;
  export = skillsHttp.export; import = skillsHttp.import; update = skillsHttp.update;
  mount = skillsHttp.mount; unmount = skillsHttp.unmount;
} }));
const { registerDashboardCommand } = await import("../dashboard.js");

// The action registers SIGINT handlers per invocation; raise the
// listener ceiling and detach them in afterEach (the PR #310 pattern).
process.setMaxListeners(64);

// ── Test harness ────────────────────────────────────────────────────────────

async function runCli(argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerDashboardCommand(program);
  try {
    await program.parseAsync(["node", "@0/cli", ...argv]);
    return undefined;
  } catch (err) {
    return err;
  }
}

// Fabricate a minimal IncomingMessage with body. We extend EventEmitter
// so `req.on("data" | "end" | "error", …)` works for the readJson path.
function makeRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): import("node:http").IncomingMessage {
  const emitter = new EventEmitter() as unknown as import("node:http").IncomingMessage;
  (emitter as unknown as { method: string }).method = opts.method;
  (emitter as unknown as { url: string }).url = opts.url;
  const binding = httpState.listenCalls.at(-1);
  const boundHost = binding?.host ?? "127.0.0.1";
  const authority = `${boundHost.includes(":") ? `[${boundHost}]` : boundHost}:${binding?.port === 0 ? 46123 : binding?.port ?? 48123}`;
  (emitter as unknown as { headers: Record<string, string> }).headers = { host: authority, ...opts.headers };
  // Emit the body lazily, AFTER the handler's readJson() has registered
  // its "end" listener. We hook into .on so the emission fires exactly
  // when the consumer is ready — eager `queueMicrotask` would emit
  // before the async handler started reading and the consumer would
  // miss the events. (This mirrors how a real http.IncomingMessage
  // would deliver data only once consumers are attached via .on.)
  emitter.resume = (() => emitter) as import("node:http").IncomingMessage["resume"];
  const originalOn = emitter.on.bind(emitter);
  (emitter as unknown as { on: EventEmitter["on"] }).on = function patchedOn(
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    originalOn(event, listener);
    if (event === "end") {
      // Defer to nextTick so all .on("data") / .on("error") listeners
      // registered in the same readJson() Promise constructor also
      // get attached before we start firing.
      process.nextTick(() => {
        if (opts.body !== undefined) {
          emitter.emit("data", JSON.stringify(opts.body));
        }
        emitter.emit("end");
      });
    }
    return emitter;
  } as unknown as EventEmitter["on"];
  return emitter;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function makeResponse(): {
  res: import("node:http").ServerResponse;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: "" };
  const res = {
    setHeader(name: string, value: string) { captured.headers[name] = value; },
    writeHead(code: number, headers: Record<string, string>) {
      captured.statusCode = code;
      captured.headers = { ...captured.headers, ...headers };
    },
    end(body?: string | Buffer) {
      if (body !== undefined) {
        captured.body = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      }
    },
  } as unknown as import("node:http").ServerResponse;
  return { res, captured };
}

async function invokeHandler(req: import("node:http").IncomingMessage): Promise<CapturedResponse> {
  if (!httpState.lastHandler) {
    throw new Error("createServer handler not captured — did the action run?");
  }
  const { res, captured } = makeResponse();
  await httpState.lastHandler(req, res);
  return captured;
}

async function getControlToken(): Promise<string> {
  // The dashboard injects <meta name="0-control-token" content="…">
  // into the served HTML. The injection only happens on the SPA-route
  // fallback (resolveAssetPath returns null AND extname is empty),
  // NOT on resolveAssetPath's explicit-asset branch. We request a
  // non-existent extension-less path (`/dashboard-spa-route`) so the
  // handler falls through to that branch.
  const captured = await invokeHandler(
    makeRequest({ method: "GET", url: "/dashboard-spa-route" }),
  );
  const m = captured.body.match(/0-control-token" content="([^"]+)"/);
  if (!m) {
    throw new Error(`control token not found in HTML; body=${captured.body.slice(0, 200)}`);
  }
  return m[1]!;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.values(skillsHttp).forEach(mock => mock.mockClear());
  instanceMock.mockResolvedValue(false);
  engineInvoke.mockClear();
  engineReady.mockReset().mockResolvedValue(undefined);
  engineDispose.mockReset().mockResolvedValue(undefined);
  // Reset http capture.
  httpState.lastHandler = null;
  httpState.listenCalls.length = 0;
  httpState.closeCalled = false;

  // Reset child_process capture.
  execFileMock.mockReset();
  spawnMock.mockReset();
  spawnedChildren.length = 0;
  nextChildPid = 1000;

  // Pre-seed the fs fake so the action finds an asset dir:
  //   - existsSync(<assetDir>/index.html) → true (the resolveDashboardAssetDir loop)
  //   - existsSync(<assetDir>) → true (resolveAssetPath defaults to /index.html)
  //   - readFileSync(<assetDir>/index.html) → stub HTML with </head>
  fsState.existsPaths.clear();
  fsState.readBodies.clear();

  // The resolveDashboardAssetDir candidates check existsSync(join(candidate, "index.html"))
  // for each candidate; we whitelist one. The exact path doesn't matter
  // — the dashboard normalizes to whatever existsSync says is real.
  // We pick a unique prefix so we can detect path-traversal escapes.
  const cwdCandidate = `${process.cwd()}/dist/dashboard`;
  const assetIndex = `${cwdCandidate}/index.html`;
  fsState.existsPaths.add(assetIndex);
  fsState.readBodies.set(
    assetIndex,
    "<html><head><title>dash</title></head><body>ok</body></html>",
  );

  // DB state reset.
  dbState.ctorPaths.length = 0;
  dbState.closes = 0;
  dbState.workers.length = 0;
  dbState.upserts.length = 0;
  dbState.deleteByStatusCalls.length = 0;
  dbState.triageUpdates.length = 0;
  dbState.workflowUpdates.length = 0;
  dbState.scans.length = 0;
  dbState.findings.length = 0;
  dbState.recentEvents.length = 0;

  resetOsecDatabaseMock.mockReset().mockReturnValue("/fake/0.db");
  recoverStaleWorkersMock.mockReset().mockReturnValue(3);
  seedVerificationWorkbenchMock
    .mockReset()
    .mockReturnValue({ scans: 4, families: 8, workers: 2 });

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  logSpy.mockRestore();
  errSpy.mockRestore();
  // The action attaches a one-shot SIGINT listener and never detaches
  // it (it expects the process to die). Strip them so they don't
  // accumulate across the many invocations in this file.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

// ── Tests: argument validation ──────────────────────────────────────────────

describe("dashboard — argument validation", () => {
  it("rejects non-integer port", async () => {
    const err = await runCli(["dashboard", "--port", "abc"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid port/i);
    // No server should have been created on the rejection path.
    expect(httpState.listenCalls).toHaveLength(0);
  });

  it("lets port 0 allocate a free loopback port and emits a machine-readable URL", async () => {
    const err = await runCli(["dashboard", "--no-open", "--port", "0", "--ready-json"]);
    expect(err).toBeUndefined();
    expect(httpState.listenCalls).toEqual([{ port: 0, host: "127.0.0.1" }]);
    expect(logSpy).toHaveBeenCalledWith(
      'ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:46123"}',
    );
  });

  it("rejects port > 65535", async () => {
    const err = await runCli(["dashboard", "--port", "70000"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid port/i);
    expect(httpState.listenCalls).toHaveLength(0);
  });

  it("accepts default port 48123 and host 127.0.0.1 when no flags given", async () => {
    const err = await runCli(["dashboard", "--no-open"]);
    expect(err).toBeUndefined();
    expect(httpState.listenCalls).toEqual([{ port: 48123, host: "127.0.0.1" }]);
  });

  it("accepts IPv6 loopback and threads it into server.listen", async () => {
    const err = await runCli([
      "dashboard",
      "--no-open",
      "--port",
      "9090",
      "--host",
      "::1",
    ]);
    expect(err).toBeUndefined();
    expect(httpState.listenCalls).toEqual([{ port: 9090, host: "::1" }]);
  });

  it("rejects a non-loopback host before starting the server", async () => {
    const err = await runCli([
      "dashboard",
      "--no-open",
      "--host",
      "0.0.0.0",
    ]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/only binds loopback/i);
    expect(httpState.listenCalls).toHaveLength(0);
  });

  it("throws if the dashboard asset dir cannot be located", async () => {
    // Clear all candidate asset-dir hits.
    fsState.existsPaths.clear();
    const err = await runCli(["dashboard", "--no-open"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Dashboard assets not found/);
    expect(httpState.listenCalls).toHaveLength(0);
  });

  it("uses explicit dashboard assets before checkout-relative candidates", async () => {
    fsState.existsPaths.clear();
    const assetDir = "/tmp/0-desktop-dashboard";
    fsState.existsPaths.add(`${assetDir}/index.html`);
    fsState.readBodies.set(
      `${assetDir}/index.html`,
      "<html><head><title>desktop dashboard</title></head><body>ok</body></html>",
    );

    const err = await runCli(["dashboard", "--no-open", "--asset-dir", assetDir]);

    expect(err).toBeUndefined();
    expect(httpState.listenCalls).toEqual([{ port: 48123, host: "127.0.0.1" }]);
  });
});

// ── Tests: browser auto-open ────────────────────────────────────────────────

describe("dashboard — browser auto-open behaviour", () => {
  it("default (no --no-open) triggers execFile to open the URL", async () => {
    await runCli(["dashboard"]);
    expect(execFileMock).toHaveBeenCalledOnce();
    const args = execFileMock.mock.calls[0]!;
    // execFile(cmd, [url], cb) on darwin/linux; on win32 it's
    // ["/c", "start", "", url]. Just assert the URL is somewhere
    // in the args array.
    const argList = args[1] as string[];
    const url = "http://127.0.0.1:48123";
    expect(argList.some((a) => a === url || a.includes(url))).toBe(true);
  });

  it("suppresses browser open when --no-open is passed", async () => {
    // Commander 12's `--no-foo` sets `opts.foo = false` (NOT
    // `opts.noFoo = true`). dashboard.ts now reads `opts.open !== false`,
    // so `--no-open` correctly skips the openBrowser() call.
    // Regression test for #316; pinned in #314 with the previous
    // (buggy) assertion which has been flipped here.
    await runCli(["dashboard", "--no-open"]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ── Tests: static asset serving ─────────────────────────────────────────────

describe("dashboard — static asset serving", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("GET / injects the page-bound control token into index.html", async () => {
    // The browser loads "/" before React routes to /chat. The bootstrap document
    // therefore needs the same token as a deep-linked SPA route; otherwise the
    // renderer can render chat but every authenticated API request is rejected.
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/" }));
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["Content-Type"]).toMatch(/text\/html/);
    expect(captured.body).toMatch(/0-control-token" content="[0-9a-f-]{8,}"/);
  });

  it("GET /<spa-route> serves index.html WITH the control-token <meta> injected", async () => {
    // The SPA-fallback branch: extension-less path that resolveAssetPath
    // misses (because we did not whitelist <assetDir>/scans/abc/index.html
    // in fsState.existsPaths). Token injection MUST happen here so the
    // dashboard JS can authenticate /api/control/* calls.
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/scans/abc" }),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["Content-Type"]).toMatch(/text\/html/);
    expect(captured.body).toMatch(/0-control-token" content="[0-9a-f-]{8,}"/);
  });

  it("unknown extension under / returns 404 (asset-not-found path)", async () => {
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/missing.js" }),
    );
    expect(captured.statusCode).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: "Asset not found" });
  });

  it("path-traversal probe falls through to index.html (assetDir-prefix invariant holds)", async () => {
    // The traversal escapes the assetDir, so resolveAssetPath returns
    // null. Since extname("/../../etc/passwd") is non-empty (".passwd"
    // depending on the input), it lands on 404 Asset not found. Either
    // way it must NOT 200 with the raw /etc/passwd contents. We don't
    // need a strict status — we just need to be sure we did not
    // readFileSync the escape target.
    const probe = "/../../../etc/passwd";
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: probe }),
    );
    // Either 404 (extname path) or 200-with-index (no extname path) —
    // both are fine. The invariant: body must not contain the
    // assetDir-escape filename.
    expect(captured.body).not.toMatch(/root:x:/);
    expect(captured.statusCode).not.toBe(500);
  });
});

// ── Tests: web console control surface ──────────────────────────────────

describe("dashboard — web console API", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("protects chat search and validates bounded pagination before reading history", async () => {
    const denied = await invokeHandler(makeRequest({ method: "GET", url: "/api/console/search?q=review" }));
    expect(denied.statusCode).toBe(403);
    const headers = { "x-0-control-token": await getControlToken() };
    const invalid = await invokeHandler(makeRequest({ method: "GET", url: "/api/console/search?q=review&limit=101", headers }));
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).error).toContain("Search limit");
    const oversized = await invokeHandler(makeRequest({ method: "GET", url: `/api/console/search?q=${"x".repeat(201)}`, headers }));
    expect(oversized.statusCode).toBe(400);
  });

  it("requires the page-bound control token before exporting retained reports", async () => {
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/scans/example/export?format=json" }));
    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Invalid or missing control token" });
  });

  it("requires the control token for engagement collections, edits and reports", async () => {
    for (const request of [
      { method: "GET", url: "/api/engagements" },
      { method: "POST", url: "/api/engagements", body: { name: "Fixture" } },
      { method: "PATCH", url: "/api/engagements/fixture", body: { notes: "Fixture" } },
      { method: "GET", url: "/api/engagements/fixture/report" },
    ]) {
      const response = await invokeHandler(makeRequest(request));
      expect(response.statusCode).toBe(403);
    }
  });

  it("rejects unsupported engagement report formats and methods before storage reads", async () => {
    const headers = { "x-0-control-token": await getControlToken() };
    const format = await invokeHandler(makeRequest({ method: "GET", url: "/api/engagements/fixture/report?format=html", headers }));
    expect(format.statusCode).toBe(400);
    const method = await invokeHandler(makeRequest({ method: "POST", url: "/api/engagements/fixture/report", headers }));
    expect(method.statusCode).toBe(405);
  });

  it("rejects unsupported report formats and non-GET exports before reading report data", async () => {
    const headers = { "x-0-control-token": await getControlToken() };
    const format = await invokeHandler(makeRequest({ method: "GET", url: "/api/findings/export?format=exe", headers }));
    expect(format.statusCode).toBe(400);
    expect(JSON.parse(format.body).error).toContain("Unsupported report export format");
    const method = await invokeHandler(makeRequest({ method: "POST", url: "/api/scans/example/export?format=json", headers }));
    expect(method.statusCode).toBe(405);
    expect(JSON.parse(method.body).error).toContain("Use GET");
  });

  it("requires the page-bound control token before creating a console session", async () => {
    const captured = await invokeHandler(
      makeRequest({ method: "POST", url: "/api/console/sessions", body: {} }),
    );

    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({ error: "Invalid or missing control token" });
  });

  it("returns Codex device-auth status without exposing credential material", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "GET",
        url: "/api/console/providers/chatgpt-codex",
        headers: { "x-0-control-token": token },
      }),
    );

    expect(captured.statusCode).toBe(200);
    const payload = JSON.parse(captured.body);
    expect(payload.status).toMatchObject({ phase: expect.any(String), lines: expect.any(Array) });
    expect(payload.provider.id).toBe("chatgpt-codex");
    expect(payload).not.toHaveProperty("credentials");
    expect(payload.provider).not.toHaveProperty("apiKey");
    expect(payload.provider.accounts.every((account: Record<string, unknown>) =>
      !Object.hasOwn(account, "apiKey") && !Object.hasOwn(account, "accessToken") && !Object.hasOwn(account, "refreshToken"))).toBe(true);
  });

  it("creates a session and returns its renderer-safe event ledger", async () => {
    const token = await getControlToken();
    const created = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/console/sessions",
        headers: { "x-0-control-token": token },
        body: {
          target: "https://app.example.test",
          role: "audit",
          autonomyMode: "standard",
        },
      }),
    );

    expect(created.statusCode).toBe(201);
    const session = JSON.parse(created.body) as { session: { id: string; target: string; status: string } };
    expect(session.session).toMatchObject({
      target: "https://app.example.test",
      status: "ready",
    });

    const events = await invokeHandler(
      makeRequest({
        method: "GET",
        url: `/api/console/sessions/${session.session.id}/events?after=0`,
        headers: { "x-0-control-token": token },
      }),
    );

    expect(events.statusCode).toBe(200);
    expect(JSON.parse(events.body)).toMatchObject({
      events: [{ type: "session", sessionId: session.session.id }],
    });
  });
});

// ── Tests: /api/dashboard read surface ──────────────────────────────────────

describe("dashboard — read APIs", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open", "--db-path", "/tmp/fake.db"]);
  });

  it("GET /api/dashboard opens DB, returns scans/cases/groups, closes DB", async () => {
    dbState.scans.push({
      id: "scan-1",
      target: "https://example.com",
      depth: "default",
      runtime: "api",
      mode: "deep",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/dashboard", headers: { "x-0-control-token": await getControlToken() } }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body).toHaveProperty("scans");
    expect(body).toHaveProperty("cases");
    expect(body).toHaveProperty("groups");
    expect(body).toHaveProperty("queue");
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0].target).toBe("https://example.com");
    // DB lifecycle: opened with the configured --db-path, closed exactly once.
    expect(dbState.ctorPaths[dbState.ctorPaths.length - 1]).toBe("/tmp/fake.db");
    expect(dbState.closes).toBeGreaterThanOrEqual(1);
  });

  it("returns validated business impact objects and keeps absent or malformed assessments unknown", async () => {
    const impact = { reachability_tier: "remote-auth", blast_radius: "All customer billing records", weaponizability: "info-leak", business_impact: "headline", rationale: "Exposure of regulated customer data", assessment_source: "provided" };
    const base = { scanId: "scan-impact", title: "Customer data access", description: "Access control failure", severity: "medium", category: "idor", status: "confirmed", timestamp: 1800000000000, evidenceRequest: "GET /billing", evidenceResponse: "record", evidenceAnalysis: "Confirmed" };
    dbState.findings.push({ ...base, id: "assessed", fingerprint: "assessed", impactAssessment: JSON.stringify(impact) }, { ...base, id: "malformed", fingerprint: "malformed", severity: "critical", impactAssessment: '{"business_impact":"headline"}' }, { ...base, id: "absent", fingerprint: "absent", severity: "critical" });
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/dashboard", headers: { "x-0-control-token": await getControlToken() } }));
    expect(captured.statusCode).toBe(200);
    const groups = JSON.parse(captured.body).groups;
    expect(groups.find((group: { latest: { id: string } }) => group.latest.id === "assessed").latest.impactAssessment).toEqual(impact);
    expect(groups.find((group: { latest: { id: string } }) => group.latest.id === "malformed").latest.impactAssessment).toBeNull();
    expect(groups.find((group: { latest: { id: string } }) => group.latest.id === "absent").latest.impactAssessment).toBeNull();
  });

  it("GET /api/scans returns summarized scans", async () => {
    dbState.scans.push({
      id: "scan-9",
      target: "lib-a",
      depth: "deep",
      runtime: "api",
      mode: "deep",
      status: "complete",
      startedAt: new Date().toISOString(),
    });
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/scans", headers: { "x-0-control-token": await getControlToken() } }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0].id).toBe("scan-9");
  });

  it("GET /api/scans/:id returns 404 when scan is missing", async () => {
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/scans/missing-id", headers: { "x-0-control-token": await getControlToken() } }),
    );
    expect(captured.statusCode).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: "Scan not found" });
  });

  it("GET /api/scans/:id returns the summarized scan when present", async () => {
    dbState.scans.push({
      id: "scan-7",
      target: "https://example.com",
      depth: "default",
      runtime: "api",
      mode: "deep",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/scans/scan-7", headers: { "x-0-control-token": await getControlToken() } }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.scan.id).toBe("scan-7");
  });

  it("GET /api/events/recent returns canonical presentation records additively", async () => {
    dbState.recentEvents.push({
      id: "event-1",
      scanId: "scan-1",
      scanTarget: "https://example.test",
      stage: "attack",
      eventType: "tool_call_started",
      payload: JSON.stringify({ tool: "read" }),
      timestamp: Date.parse("2026-08-26T00:00:00.000Z"),
    });

    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/events/recent", headers: { "x-0-control-token": await getControlToken() } }),
    );

    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.events).toEqual([
      expect.objectContaining({
        id: "event-1",
        presentation: {
          protocol: "0.presentation/v1",
          kind: "event",
          source: "core",
          sequence: 1,
          at: "2026-08-26T00:00:00.000Z",
          eventType: "tool_call_started",
          payload: { tool: "read" },
          scanId: "scan-1",
        },
      }),
    ]);
  });

  it("unknown /api/* path → 404 (handler returns false, top-level falls through)", async () => {
    const captured = await invokeHandler(
      makeRequest({ method: "GET", url: "/api/does-not-exist", headers: { "x-0-control-token": await getControlToken() } }),
    );
    expect(captured.statusCode).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: "Not found" });
  });
});

// ── Tests: control-token gate (the CSRF defense) ────────────────────────────

describe("dashboard — control-token gate", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("POST /api/control/* without a token → 403", async () => {
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/recover-stale-workers",
        body: {},
      }),
    );
    expect(captured.statusCode).toBe(403);
    expect(JSON.parse(captured.body)).toEqual({
      error: "Invalid or missing control token",
    });
    // Critical: the dynamic import path for recoverStaleWorkers must
    // NOT have been reached on the rejection branch.
    expect(recoverStaleWorkersMock).not.toHaveBeenCalled();
  });

  it("POST /api/control/* with the wrong token → 403", async () => {
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/recover-stale-workers",
        headers: { "x-0-control-token": "not-the-real-token" },
        body: {},
      }),
    );
    expect(captured.statusCode).toBe(403);
    expect(recoverStaleWorkersMock).not.toHaveBeenCalled();
  });

  it("non-POST on /api/control/* → 405 method-not-allowed", async () => {
    const captured = await invokeHandler(
      makeRequest({
        method: "GET",
        url: "/api/control/recover-stale-workers",
        headers: { "x-0-control-token": await getControlToken() },
      }),
    );
    expect(captured.statusCode).toBe(405);
    expect(JSON.parse(captured.body)).toEqual({ error: "Method not allowed" });
  });

  it("POST /api/control/recover-stale-workers with the right token calls recoverStaleWorkers", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/recover-stale-workers",
        headers: { "x-0-control-token": token },
        body: { staleAfterMs: 45_000 },
      }),
    );
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, recovered: 3 });
    expect(recoverStaleWorkersMock).toHaveBeenCalledWith(undefined, 45_000);
  });
});

describe("dashboard — browser request boundaries", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it.each(["/api/dashboard", "/api/scans", "/api/console/sessions", "/api/console/providers", "/api/console/workflow-triggers", "/api/console/learning"])(
    "refuses unauthenticated reads of %s before opening the database",
    async (url) => {
      const captured = await invokeHandler(makeRequest({ method: "GET", url }));
      expect(captured.statusCode).toBe(403);
      expect(JSON.parse(captured.body)).toEqual({ error: "Invalid or missing control token" });
      expect(dbState.ctorPaths).toHaveLength(0);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("lists workflow schedules through the authenticated router", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/console/workflow-triggers", headers: { "x-0-control-token": token } }));
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ triggers: [] });
  });

  it("lists learning state through the authenticated router", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/console/learning", headers: { "x-0-control-token": token } }));
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ events: [], knowledge: [], improvements: [], worker: { events: 0, knowledge: 0, improvements: 0, queue: { pending: 0, claimed: 0, completed: 0 } } });
  });

  it.each(["attacker.example:48123", "127.0.0.1:9000", ""])(
    "refuses to issue a browser token for hostile or missing Host %s",
    async (host) => {
      const captured = await invokeHandler(makeRequest({ method: "GET", url: "/", headers: { host } }));
      expect(captured.statusCode).toBe(403);
      expect(captured.body).not.toContain("0-control-token");
    },
  );

  it("refuses a foreign Origin even when the API token is valid", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(makeRequest({ method: "POST", url: "/api/control/recover-stale-workers",
      headers: { "x-0-control-token": token, origin: "https://attacker.example" }, body: {} }));
    expect(captured.statusCode).toBe(403);
    expect(recoverStaleWorkersMock).not.toHaveBeenCalled();
    expect(dbState.ctorPaths).toHaveLength(0);
  });

  it("refuses a cross-site read even when the API token is valid", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/dashboard",
      headers: { "x-0-control-token": token, "sec-fetch-site": "cross-site" } }));
    expect(captured.statusCode).toBe(403);
    expect(dbState.ctorPaths).toHaveLength(0);
  });

  it("allows only the top-level OIDC callback to reach its state validator", async () => {
    const callback = await invokeHandler(makeRequest({ method: "GET", url: "/api/team/auth/callback?state=untrusted&code=untrusted", headers: { "sec-fetch-site": "cross-site" } }));
    expect(callback.statusCode).toBe(404); // TeamAuth refuses the unconfigured provider.
    expect(JSON.parse(callback.body).error).toContain("not configured");
    for (const [method, url] of [["POST", "/api/team/auth/callback"], ["GET", "/api/team/auth/sso"], ["GET", "/api/team/auth/callback/other"]]) {
      const other = await invokeHandler(makeRequest({ method: method!, url: url!, headers: { "sec-fetch-site": "cross-site" } }));
      expect(other.statusCode).toBe(403);
    }
  });

  it("accepts the browser's matching Origin and token", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(makeRequest({ method: "GET", url: "/api/scans",
      headers: { "x-0-control-token": token, origin: "http://127.0.0.1:48123", "sec-fetch-site": "same-origin" } }));
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ scans: [] });
    expect(dbState.closes).toBe(1);
  });
});

// ── Tests: daemon lifecycle ─────────────────────────────────────────────────

describe("dashboard — daemon control", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open", "--db-path", "/tmp/fake.db"]);
  });

  it("start-daemon refuses (409) when an active worker is heartbeating", async () => {
    dbState.workers.push({
      id: "w-1",
      status: "running",
      label: "control-plane-1",
      pid: 999,
      heartbeatAt: new Date().toISOString(), // fresh
    });
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/start-daemon",
        headers: { "x-0-control-token": token },
        body: {},
      }),
    );
    expect(captured.statusCode).toBe(409);
    expect(JSON.parse(captured.body).error).toMatch(/active daemon is already heartbeating/);
    // The spawn boundary must not have been touched on the refusal path.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("start-daemon spawns the orchestrate child when no active heartbeats", async () => {
    // A stopped worker should not block startup.
    dbState.workers.push({
      id: "w-2",
      status: "stopped",
      label: "ghost",
      pid: 12345,
      heartbeatAt: new Date(0).toISOString(),
    });
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/start-daemon",
        headers: { "x-0-control-token": token },
        body: { label: "my-daemon", pollIntervalMs: 5000 },
      }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.ok).toBe(true);
    expect(body.label).toBe("my-daemon");
    expect(typeof body.pid).toBe("number");

    // Inspect the spawn call: arg shape (orchestrate --watch --label …).
    expect(spawnMock).toHaveBeenCalledOnce();
    const spawnArgs = spawnMock.mock.calls[0]!;
    const childArgs = spawnArgs[1] as string[];
    expect(childArgs).toContain("orchestrate");
    expect(childArgs).toContain("--watch");
    expect(childArgs).toContain("--label");
    expect(childArgs).toContain("my-daemon");
    expect(childArgs).toContain("--poll-interval");
    expect(childArgs).toContain("5000");
    expect(childArgs).toContain("--db-path");
    expect(childArgs).toContain("/tmp/fake.db");
  });

  it("stop-daemon SIGTERMs live workers and marks them stopped in the DB", async () => {
    dbState.workers.push({
      id: "w-3",
      status: "running",
      label: "control-plane-1",
      pid: 31337,
      heartbeatAt: new Date().toISOString(),
    });
    // Capture process.kill so we can assert the SIGTERM call without
    // actually killing a real PID.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const token = await getControlToken();
      const captured = await invokeHandler(
        makeRequest({
          method: "POST",
          url: "/api/control/stop-daemon",
          headers: { "x-0-control-token": token },
        }),
      );
      expect(captured.statusCode).toBe(200);
      expect(JSON.parse(captured.body)).toEqual({ ok: true, stopped: 1 });
      expect(killSpy).toHaveBeenCalledWith(31337, "SIGTERM");
      // The worker row is updated to status=stopped via upsertWorker.
      expect(dbState.upserts).toHaveLength(1);
      expect(dbState.upserts[0]!.status).toBe("stopped");
    } finally {
      killSpy.mockRestore();
    }
  });
});

// ── Tests: launch-run ───────────────────────────────────────────────────────

describe("dashboard — launch-run control", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("rejects (400) when target is missing", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/launch-run",
        headers: { "x-0-control-token": token },
        body: {},
      }),
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error).toEqual(expect.any(String));
    expect(engineInvoke).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("delegates session and bounded assessment to the same persistent engine", async () => {
    engineInvoke.mockResolvedValueOnce({ id: "session-owner" } as never).mockResolvedValueOnce({ id: "assessment-run", jobId: "assessment-job" } as never);
    const captured = await invokeHandler(makeRequest({ method: "POST", url: "/api/control/launch-run", headers: { "x-0-control-token": await getControlToken() }, body: { target: "https://example.com", depth: "deep" } }));
    expect(captured.statusCode).toBe(202);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, engineOwned: true, sessionId: "session-owner", runId: "assessment-run", jobId: "assessment-job" });
    expect(engineInvoke.mock.calls).toEqual([
      ["create_session", { config: { target: "https://example.com", title: "Assessment: https://example.com" } }],
      ["start_assessment", { sessionId: "session-owner", target: "https://example.com", plan: expect.objectContaining({ goal: "unknown-vulnerabilities", depth: "deep", runCount: 1, executionMode: "sequential", timeCapMs: expect.any(Number), costCapUsd: expect.any(Number) }) }],
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported external runtimes and daemon ownership before invoking the engine", async () => {
    const headers = { "x-0-control-token": await getControlToken() };
    for (const input of [{ runtime: "claude" }, { runtime: "api" }, { mode: "deep" }, { mode: "web" }, { ensureDaemon: true }]) {
      const captured = await invokeHandler(makeRequest({ method: "POST", url: "/api/control/launch-run", headers, body: { target: "https://example.com", ...input } }));
      expect(captured.statusCode).toBe(400);
    }
    expect(engineInvoke).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

});

// ── Tests: reset-database ───────────────────────────────────────────────────

describe("dashboard — reset-database control", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("rejects unsupported seed presets (400)", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/reset-database",
        headers: { "x-0-control-token": token },
        body: { seed: "kitchen-sink" },
      }),
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error).toMatch(/Unsupported seed preset/);
    expect(resetOsecDatabaseMock).not.toHaveBeenCalled();
  });

  it("refuses (409) if an active worker is running", async () => {
    dbState.workers.push({
      id: "w-5",
      status: "running",
      label: "control-plane-1",
      pid: undefined,
      heartbeatAt: new Date().toISOString(),
    });
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/reset-database",
        headers: { "x-0-control-token": token },
        body: { seed: "verification" },
      }),
    );
    expect(captured.statusCode).toBe(409);
    expect(JSON.parse(captured.body).error).toMatch(
      /Stop active orchestration daemons before resetting/,
    );
    expect(resetOsecDatabaseMock).not.toHaveBeenCalled();
  });

  it("happy path: resets + seeds verification workbench", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/reset-database",
        headers: { "x-0-control-token": token },
        body: { seed: "verification" },
      }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/fake/0.db");
    expect(body.seed).toBe("verification");
    expect(body.scans).toBe(4);
    expect(resetOsecDatabaseMock).toHaveBeenCalledOnce();
    expect(seedVerificationWorkbenchMock).toHaveBeenCalledOnce();
  });

  it("--seed empty: resets but skips the workbench seeder", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/reset-database",
        headers: { "x-0-control-token": token },
        body: { seed: "empty" },
      }),
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.ok).toBe(true);
    expect(body.seed).toBe("empty");
    expect(resetOsecDatabaseMock).toHaveBeenCalledOnce();
    expect(seedVerificationWorkbenchMock).not.toHaveBeenCalled();
  });
});

// ── Tests: finding-family triage + workflow POSTs ───────────────────────────

describe("dashboard — finding-family POST handlers", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("POST /api/finding-family/:fp/triage normalises invalid status to 'new'", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/finding-family/fp-1/triage",
        headers: { "x-0-control-token": token },
        body: { triageStatus: "bogus-value", triageNote: "looks weird" },
      }),
    );
    expect(captured.statusCode).toBe(200);
    expect(dbState.triageUpdates).toEqual([
      { fp: "fp-1", status: "new", note: "looks weird" },
    ]);
  });

  it("POST /api/finding-family/:fp/triage passes through 'accepted' verbatim", async () => {
    const token = await getControlToken();
    await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/finding-family/fp-2/triage",
        headers: { "x-0-control-token": token },
        body: { triageStatus: "accepted" },
      }),
    );
    expect(dbState.triageUpdates).toEqual([
      { fp: "fp-2", status: "accepted", note: undefined },
    ]);
  });

  it("POST /api/finding-family/:fp/workflow normalises invalid status via inferWorkflowStatus", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/finding-family/fp-3/workflow",
        headers: { "x-0-control-token": token },
        body: { workflowStatus: "bogus", workflowAssignee: "  alice  " },
      }),
    );
    expect(captured.statusCode).toBe(200);
    // The fallback inference path (no row context) lands on "backlog".
    expect(dbState.workflowUpdates).toEqual([
      { fp: "fp-3", status: "backlog", assignee: "alice" },
    ]);
  });
});

// ── Tests: prune-stopped-workers ────────────────────────────────────────────

describe("dashboard — prune-stopped-workers", () => {
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open"]);
  });

  it("deletes workers in 'stopped' status and reports the count", async () => {
    const token = await getControlToken();
    const captured = await invokeHandler(
      makeRequest({
        method: "POST",
        url: "/api/control/prune-stopped-workers",
        headers: { "x-0-control-token": token },
        body: {},
      }),
    );
    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ ok: true, deleted: 2 });
    expect(dbState.deleteByStatusCalls).toEqual(["stopped"]);
  });
});

 it("reopens the existing dashboard without creating another server", async () => {
   instanceMock.mockResolvedValue(true);
   expect(await runCli(["web", "--ready-json"])).toBeUndefined();
   expect(httpState.listenCalls).toHaveLength(0);
   expect(execFileMock).toHaveBeenCalled();
   expect(logSpy).toHaveBeenCalledWith('ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:48123"}');
 });


describe("dashboard — persistent engine boundaries", () => {
  const bearer = "engine-test-secret-" + "x".repeat(32);
  beforeEach(async () => {
    vi.stubEnv("ZERO_TEST_ENGINE_TOKEN", bearer);
    expect(await runCli(["dashboard", "--no-open", "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN", "--ready-json"])).toBeUndefined();
  });
  it("accepts the engine bearer for both outer and inner control/triage authorization", async () => {
    const control = await invokeHandler(makeRequest({ method: "POST", url: "/api/control/recover-stale-workers", headers: { authorization: `Bearer ${bearer}` }, body: { staleAfterMs: 1000 } }));
    expect(control.statusCode).toBe(200); expect(recoverStaleWorkersMock).toHaveBeenCalled();
    const triage = await invokeHandler(makeRequest({ method: "POST", url: "/api/finding-family/family-1/triage", headers: { authorization: `Bearer ${bearer}` }, body: { status: "confirmed" } }));
    expect(triage.statusCode).toBe(200); expect(dbState.triageUpdates).toHaveLength(1);
  });
  it("returns a compatible handshake and routes engine calls without leaking its bearer", async () => {
    const response = await invokeHandler(makeRequest({ method: "GET", url: "/api/backend/handshake", headers: { authorization: `Bearer ${bearer}`, "x-0-request-id": "request-42" } }));
    expect(response.statusCode).toBe(200); const handshake = JSON.parse(response.body);
    expect(handshake.protocolVersion).toBe(1); expect(handshake.capabilities).toContain("workflow-engine"); expect(response.headers["X-0-Request-ID"]).toBe("request-42");
    const call = await invokeHandler(makeRequest({ method: "POST", url: "/api/workflow-engine/call", headers: { authorization: `Bearer ${bearer}`, "x-0-expected-engine-id": handshake.engineId }, body: { name: "list_templates", args: {} } }));
    expect(call.statusCode).toBe(200); expect(engineInvoke).toHaveBeenCalledWith("list_templates", {});
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain(bearer); expect(response.body).not.toContain(bearer);
  });
  it("rejects another engine identity before mutating or resolving an approval", async () => {
    const response = await invokeHandler(makeRequest({ method: "POST", url: "/api/control/recover-stale-workers", headers: { authorization: `Bearer ${bearer}`, "x-0-expected-engine-id": "engine-other" }, body: {} }));
    expect(response.statusCode).toBe(409); expect(recoverStaleWorkersMock).not.toHaveBeenCalled();
    const approval = await invokeHandler(makeRequest({ method: "POST", url: "/api/console/sessions/same-id/decisions/same-approval", headers: { authorization: `Bearer ${bearer}`, "x-0-expected-engine-id": "engine-other" }, body: { approved: true } }));
    expect(approval.statusCode).toBe(409);
  });
  it("does not reuse an existing dashboard when engine admission is explicitly configured", async () => {
    instanceMock.mockClear().mockResolvedValue(true); httpState.listenCalls.length = 0;
    expect(await runCli(["dashboard", "--no-open", "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN"])).toBeUndefined();
    expect(httpState.listenCalls).toHaveLength(1); expect(instanceMock).not.toHaveBeenCalled();
  });
});


it("cleans up the persistent engine when startup preflight fails before listening", async () => {
  vi.stubEnv("ZERO_TEST_ENGINE_TOKEN", "x".repeat(32));
  engineReady.mockRejectedValueOnce(new Error("Authorized workspace is unavailable."));
  const result = await runCli(["dashboard", "--no-open", "--engine-token-env", "ZERO_TEST_ENGINE_TOKEN"]);
  expect(result).toBeInstanceOf(Error);
  expect(engineDispose).toHaveBeenCalledOnce();
  expect(httpState.listenCalls).toHaveLength(0);
});

describe("business impact metadata mutations", () => {
  const assessment = { reachability_tier: "unknown", blast_radius: "Customer billing records", weaponizability: "info-leak", business_impact: "notable", rationale: "Confirm access controls on the billing service.", assessment_source: "model" };
  beforeEach(async () => {
    await runCli(["dashboard", "--no-open", "--db-path", "/tmp/business-impact-engine.db"]);
    dbState.findings.push({ id: "same-id", scanId: "scan-impact", severity: "critical", cvssScore: 9.8, status: "discovered", verification_result: "original verification", impactAssessment: null });
  });

  it("authenticates and validates engine-owned metadata before changing stored priority", async () => {
    const initial = structuredClone(dbState.findings[0]);
    const denied = await invokeHandler(makeRequest({ method: "POST", url: "/api/findings/same-id/impact-assessment", body: assessment }));
    expect(denied.statusCode).toBe(403);
    const headers = { "x-0-control-token": await getControlToken() };
    const invalid = await invokeHandler(makeRequest({ method: "POST", url: "/api/findings/same-id/impact-assessment", headers, body: { ...assessment, severity: "low", dbPath: "/another/engine.db" } }));
    expect(invalid.statusCode).toBe(400);
    expect(dbState.findings[0]).toEqual(initial);
    const saved = await invokeHandler(makeRequest({ method: "POST", url: "/api/findings/same-id/impact-assessment", headers, body: assessment }));
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toEqual({ findingId: "same-id", impactAssessment: { ...assessment, assessment_source: "provided" } });
    expect(dbState.findings[0]).toEqual({ ...initial, impactAssessment: JSON.stringify({ ...assessment, assessment_source: "provided" }) });
    expect(dbState.ctorPaths).toContain("/tmp/business-impact-engine.db");
    expect(dbState.ctorPaths).not.toContain("/another/engine.db");
  });

  it("clears only impact metadata and rejects unsupported methods or a missing finding", async () => {
    const headers = { "x-0-control-token": await getControlToken() };
    const missing = await invokeHandler(makeRequest({ method: "POST", url: "/api/findings/foreign-id/impact-assessment", headers, body: assessment }));
    expect(missing.statusCode).toBe(404);
    const method = await invokeHandler(makeRequest({ method: "GET", url: "/api/findings/same-id/impact-assessment", headers }));
    expect(method.statusCode).toBe(405);
    const cleared = await invokeHandler(makeRequest({ method: "DELETE", url: "/api/findings/same-id/impact-assessment", headers }));
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body)).toEqual({ findingId: "same-id", impactAssessment: null });
    expect(dbState.findings[0]).toMatchObject({ severity: "critical", cvssScore: 9.8, status: "discovered", verification_result: "original verification" });
  });
});


describe("dashboard — skills HTTP library", () => {
  beforeEach(async () => { await runCli(["dashboard", "--no-open"]); });
  async function call(method: string, url: string, body?: unknown) {
    return invokeHandler(makeRequest({ method, url, body, headers: { "x-0-control-token": await getControlToken() } }));
  }
  it("routes create, detail, revision edit and portable export/import with decoded skill IDs", async () => {
    expect((await call("POST", "/api/skills", { content: "SKILL.md source" })).statusCode).toBe(201);
    expect(skillsHttp.create).toHaveBeenCalledWith({ content: "SKILL.md source" });
    const id = "mount/workspace/test-review";
    expect((await call("GET", `/api/skills/${encodeURIComponent(id)}`)).statusCode).toBe(200);
    expect(skillsHttp.get).toHaveBeenCalledWith(id);
    const edited = { content: "New source", expectedRevision: "a".repeat(64) };
    expect((await call("PUT", `/api/skills/${encodeURIComponent(id)}`, edited)).statusCode).toBe(200);
    expect(skillsHttp.update).toHaveBeenCalledWith(id, edited);
    const exported = await call("GET", `/api/skills/${encodeURIComponent(id)}/export`);
    expect(exported.statusCode).toBe(200); expect(exported.headers["Content-Disposition"]).toContain("test-review.skill.json"); expect(skillsHttp.export).toHaveBeenCalledWith(id);
    const bundle = JSON.parse(exported.body);
    expect((await call("POST", "/api/skills/import", { bundle })).statusCode).toBe(201);
    expect(skillsHttp.import).toHaveBeenCalledWith({ bundle });
  });
  it("accepts base64-sized portable imports without expanding unrelated API body limits", async () => {
    const imported = { bundle: { files: [{ content: "a".repeat(11_200_000) }] } };
    expect((await call("POST", "/api/skills/import", imported)).statusCode).toBe(201);
    expect(skillsHttp.import).toHaveBeenCalledOnce();
    expect((await call("POST", "/api/skills", { content: "a".repeat(1_000_001) })).statusCode).toBe(413);
    expect(skillsHttp.create).not.toHaveBeenCalled();
    expect((await call("POST", "/api/skills/import", { bundle: "a".repeat(12 * 1024 * 1024) })).statusCode).toBe(413);
    expect(skillsHttp.import).toHaveBeenCalledOnce();
  });
  it("rejects malformed escaped skill IDs with an actionable client error", async () => {
    for (const path of ["/api/skills/%ZZ", "/api/skills/%ZZ/export", "/api/skills/mounts/%ZZ"]) {
      const result = await call(path.includes("mounts") ? "DELETE" : "GET", path);
      expect(result.statusCode).toBe(400); expect(JSON.parse(result.body).error).toBe("Invalid skill identifier.");
    }
    expect(skillsHttp.get).not.toHaveBeenCalled(); expect(skillsHttp.export).not.toHaveBeenCalled(); expect(skillsHttp.unmount).not.toHaveBeenCalled();
  });
});
