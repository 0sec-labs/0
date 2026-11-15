import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";
import { eventBus } from "../events/bus.js";
import {
  analyticsPipeline,
  ANALYTICS_SENT_LOG_FILENAME,
  POSTHOG_PROPERTY_KEYS,
  POSTHOG_TIMEOUT_MS,
} from "./analytics-pipeline.js";
import { DEFAULT_POSTHOG_HOST, normalizePostHogHost, resolvePostHogDestination } from "./posthog-destination.js";

const FAKE_KEY = "phc_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";
const FAKE_HOST = "http://127.0.0.1:9";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const dirs: string[] = [];
let home: string;
let posts: Array<{ url: string; body: string }>;

function fakeFetch(behaviour: "ok" | "fail" | "hang" = "ok"): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: String(init?.body ?? "") });
    if (behaviour === "fail") return Promise.reject(new Error("ECONNREFUSED internal.example"));
    if (behaviour === "hang") {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

function logPath(): string {
  return join(home, ".0", ANALYTICS_SENT_LOG_FILENAME);
}

function emitUsage(): void {
  eventBus.emit("tool_call_started", { tool: "http_request", turn: 0, args_preview: "GET https://victim.example/admin", ts: Date.now() });
  eventBus.emit("tool_call_started", { tool: "mcp__acme-internal__lookup", turn: 0, args_preview: "x", ts: Date.now() });
  eventBus.emit("tool_call_started", { tool: "my_secret_plugin_for_client_acme", turn: 0, args_preview: "x", ts: Date.now() });
  eventBus.emit("tool_call_completed", {
    tool: "shell", turn: 0, duration_ms: 5, status: "error",
    error: "spawn failed: ETIMEDOUT contacting 10.1.2.3 /Users/alice/secret.txt", ts: Date.now(),
  });
  eventBus.emit("finding_ingested", { severity: "high", category: "ssrf-at-victim.example", title: "Admin panel at victim.example", evidence: "password=hunter2" });
  eventBus.emit("cost_update", { cost_usd: 0.25 });
  eventBus.emit("agent_turn_completed", { turn: 0, duration_ms: 1200, reason: "finished" });
}

function allEvents(): Array<{ event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }> {
  return posts.flatMap((p) => (JSON.parse(p.body) as { batch: never[] }).batch);
}

beforeEach(() => {
  analyticsPipeline.__resetForTests();
  posts = [];
  home = mkdtempSync(join(tmpdir(), "0-posthog-"));
  dirs.push(home);
  for (const name of ["ZERO_CLOUD_TOKEN", "0SEC_CLOUD_TOKEN", "ZERO_CLOUD_HOST", "ZERO_ANALYTICS_LEVEL", "ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK", "ZERO_ANALYTICS_POSTHOG_HOST"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("ZERO_ANALYTICS_POSTHOG_KEY", FAKE_KEY);
  vi.stubEnv("ZERO_ANALYTICS_POSTHOG_HOST", FAKE_HOST);
  analyticsPipeline.configure({ homeDir: home, fetchImpl: fakeFetch(), surface: "web", releaseChannel: "beta", knownToolNames: ["http_request", "shell"] });
});

afterEach(() => {
  analyticsPipeline.__resetForTests();
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("PostHog destination resolution", () => {
  it("uses the built-in key with the EU host when there is no override", () => {
    expect(resolvePostHogDestination({}, FAKE_KEY)).toEqual({ key: FAKE_KEY, host: DEFAULT_POSTHOG_HOST });
    expect(DEFAULT_POSTHOG_HOST).toBe("https://eu.i.posthog.com");
  });
  it("source and PR builds (no built-in key, no override) have no destination", () => {
    expect(resolvePostHogDestination({}, undefined)).toBeNull();
  });
  it("an override wins over the built-in key; an EMPTY override disables the path", () => {
    const other = "phc_OTHEROTHEROTHEROTHEROTHER0000";
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_KEY: other }, FAKE_KEY)?.key).toBe(other);
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_KEY: "" }, FAKE_KEY)).toBeNull();
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_KEY: "   " }, FAKE_KEY)).toBeNull();
  });
  it("rejects malformed keys and non-https / non-loopback hosts", () => {
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_KEY: "not-a-key" }, FAKE_KEY)).toBeNull();
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_HOST: "http://example.com" }, FAKE_KEY)).toBeNull();
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_HOST: "https://u:p@example.com" }, FAKE_KEY)).toBeNull();
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_HOST: "ftp://example.com" }, FAKE_KEY)).toBeNull();
    expect(normalizePostHogHost("https://ph.example.test/path/")).toBe("https://ph.example.test");
    expect(normalizePostHogHost("http://localhost:8123")).toBe("http://localhost:8123");
    expect(resolvePostHogDestination({ ZERO_ANALYTICS_POSTHOG_HOST: "https://ph.example.test" }, FAKE_KEY)).toEqual({ key: FAKE_KEY, host: "https://ph.example.test" });
  });
});

describe("anonymous usage to PostHog (no cloud token)", () => {
  it("sends exactly the allowlisted property set, with anonymity flags and a random install id", async () => {
    analyticsPipeline.setLevel("usage");
    emitUsage();
    await analyticsPipeline.flushNow();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${FAKE_HOST}/batch/`);
    const body = JSON.parse(posts[0].body) as { api_key: string; batch: unknown[] };
    expect(Object.keys(body).sort()).toEqual(["api_key", "batch"]);
    expect(body.api_key).toBe(FAKE_KEY);
    const [event] = allEvents();
    expect(Object.keys(event).sort()).toEqual(["distinct_id", "event", "properties", "timestamp"]);
    expect(event.event).toBe("usage");
    expect(Object.keys(event.properties).sort()).toEqual([...POSTHOG_PROPERTY_KEYS].sort());
    expect(event.properties).toMatchObject({
      tool_counts: { http_request: 1, mcp: 1, other: 1 },
      error_counts: { timeout: 1 },
      finding_severity_counts: { high: 1 },
      turn_count: 1, duration_ms: 1200, cost_usd: 0.25,
      surface: "web", channel: "beta", runtime: "node",
      $lib: "0security", $geoip_disable: true, $process_person_profile: false, $ip: null,
    });
    expect(typeof event.properties.version).toBe("string");
    expect(typeof event.properties.os).toBe("string");
    expect(typeof event.properties.arch).toBe("string");
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);

    // distinct_id is the persisted random install id: a UUID, no host or user data.
    const installId = readFileSync(join(home, ".0", "analytics-id"), "utf8").trim();
    expect(event.distinct_id).toBe(installId);
    expect(installId).toMatch(UUID);
    expect(installId.includes(hostname())).toBe(false);
    expect(installId.includes(userInfo().username)).toBe(false);
  });

  it("never serializes planted targets, urls, paths, finding text, messages or secrets", async () => {
    analyticsPipeline.setLevel("usage");
    emitUsage();
    // A hostile direct record: secrets in labels and extra unlisted fields.
    analyticsPipeline.__enqueueForTests({
      kind: "usage",
      featureCounts: { "sk-ABCDEFGHIJKLMNOPQRSTUVWX": 1, "https://victim.example/a?token=zzz": 1 },
      findingCounts: { "xss at victim.example": 1 },
      errorCategories: { "ECONNREFUSED 10.9.9.9": 1, "/Users/alice/.ssh/id_rsa": 1 },
      turnCount: 1, durationMs: 1,
      targetUrl: "https://victim.example", message: "hello secret message", path: "/Users/alice/x",
    }, "usage");
    await analyticsPipeline.flushNow();
    const wire = posts.map((p) => p.body).join("\n");
    for (const planted of ["victim.example", "hunter2", "10.1.2.3", "10.9.9.9", "/Users/alice", "acme", "my_secret_plugin", "sk-ABCDEF", "hello secret", "targetUrl", "token=zzz", "Admin panel", "args_preview", "ssrf-at-victim", "spawn failed"]) {
      expect(wire, planted).not.toContain(planted);
    }
    for (const event of allEvents()) expect(Object.keys(event.properties).every((k) => (POSTHOG_PROPERTY_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("sends deltas, not running totals, across successive snapshots", async () => {
    analyticsPipeline.setLevel("usage");
    eventBus.emit("tool_call_started", { tool: "shell", turn: 0, args_preview: "", ts: 1 });
    await analyticsPipeline.flushNow();
    eventBus.emit("tool_call_started", { tool: "shell", turn: 0, args_preview: "", ts: 2 });
    await analyticsPipeline.flushNow();
    expect(allEvents().map((e) => e.properties.tool_counts)).toEqual([{ shell: 1 }, { shell: 1 }]);
    // A flush with nothing new sends nothing.
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(2);
  });

  it("writes the transparency log without the api key", async () => {
    analyticsPipeline.setLevel("usage");
    emitUsage();
    await analyticsPipeline.flushNow();
    const log = readFileSync(logPath(), "utf8");
    expect(log).toContain('"event":"usage"');
    expect(log).not.toContain(FAKE_KEY);
  });

  it.each([
    ["DO_NOT_TRACK", "1"], ["ZERO_NO_TELEMETRY", "1"], ["ZERO_OFFLINE", "1"],
  ])("%s wins: nothing sent, nothing queued, no install id", async (name, value) => {
    analyticsPipeline.setLevel("usage");
    vi.stubEnv(name, value);
    emitUsage();
    analyticsPipeline.__enqueueForTests({ kind: "usage", featureCounts: { shell: 1 }, turnCount: 1, durationMs: 1 }, "usage");
    expect(analyticsPipeline.__pendingCountForTests()).toBe(0);
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(0);
    expect(existsSync(logPath())).toBe(false);
    expect(existsSync(join(home, ".0", "analytics-id"))).toBe(false);
  });

  it("a late opt-out drops already-queued records before they are sent", async () => {
    analyticsPipeline.setLevel("usage");
    emitUsage();
    analyticsPipeline.__enqueueForTests({ kind: "usage", featureCounts: { shell: 1 }, turnCount: 1, durationMs: 1 }, "usage");
    expect(analyticsPipeline.__pendingCountForTests()).toBe(1);
    vi.stubEnv("DO_NOT_TRACK", "1");
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(0);
  });

  it("level off sends nothing and queues nothing", async () => {
    analyticsPipeline.setLevel("off");
    emitUsage();
    analyticsPipeline.__enqueueForTests({ kind: "usage", featureCounts: { shell: 1 }, turnCount: 1, durationMs: 1 }, "usage");
    expect(analyticsPipeline.__pendingCountForTests()).toBe(0);
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(0);
  });

  it("no key (source or PR build) and an empty override send nothing and queue nothing", async () => {
    analyticsPipeline.setLevel("usage");
    for (const key of [undefined, ""]) {
      vi.stubEnv("ZERO_ANALYTICS_POSTHOG_KEY", key);
      emitUsage();
      analyticsPipeline.__enqueueForTests({ kind: "usage", featureCounts: { shell: 1 }, turnCount: 1, durationMs: 1 }, "usage");
      expect(analyticsPipeline.__pendingCountForTests()).toBe(0);
      await analyticsPipeline.flushNow();
    }
    expect(posts).toHaveLength(0);
  });

  it("commands and full tier records never reach PostHog", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordCommand({ tool: "shell", args: "curl https://victim.example", output: "root:x:0", status: "ok", durationMs: 1, turn: 0 });
    analyticsPipeline.recordCode({ lang: "py", source: "print(1)", origin: "model" });
    analyticsPipeline.recordScope({ target: "https://victim.example", kind: "target" });
    analyticsPipeline.recordFinding({ severity: "high", category: "x", title: "t", description: "d", evidence: "e", confidence: 1 });
    expect(analyticsPipeline.__pendingCountForTests()).toBe(0);
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(0);
  });

  it("a cloud token keeps the authenticated cloud path only: no PostHog, no double counting", async () => {
    vi.stubEnv("ZERO_CLOUD_TOKEN", "test-token");
    vi.stubEnv("ZERO_CLOUD_HOST", "https://analytics.test");
    analyticsPipeline.setLevel("usage");
    emitUsage();
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://analytics.test/api/cli-analytics");
    expect(posts.some((p) => p.url.includes("/batch/") || p.body.includes(FAKE_KEY))).toBe(false);
  });

  it("failure and timeout are silent and never throw", async () => {
    analyticsPipeline.configure({ fetchImpl: fakeFetch("fail") });
    analyticsPipeline.setLevel("usage");
    emitUsage();
    await expect(analyticsPipeline.flushNow()).resolves.toBeUndefined();
    expect(posts).toHaveLength(1);

    vi.useFakeTimers();
    try {
      analyticsPipeline.configure({ fetchImpl: fakeFetch("hang") });
      analyticsPipeline.__enqueueForTests({ kind: "usage", featureCounts: { shell: 1 }, turnCount: 1, durationMs: 1 }, "usage");
      const flushed = analyticsPipeline.flushNow();
      await vi.advanceTimersByTimeAsync(POSTHOG_TIMEOUT_MS + 10);
      await expect(flushed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(POSTHOG_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it("flushes the pending batch on demand (what the beforeExit hook calls)", async () => {
    analyticsPipeline.setLevel("usage");
    emitUsage();
    expect(posts).toHaveLength(0); // debounced, not yet sent
    await analyticsPipeline.flushNow();
    expect(posts).toHaveLength(1);
  });
});
