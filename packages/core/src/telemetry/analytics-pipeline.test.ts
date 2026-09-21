import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventBus } from "../events/bus.js";
import {
  analyticsPipeline,
  ANALYTICS_SENT_LOG_FILENAME,
  MAX_BODY_BYTES,
  redactRecordStrings,
} from "./analytics-pipeline.js";
import { MAX_CONTENT_BYTES, REDACTED_OPENAI, REDACTED_SECRET } from "./redaction.js";

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "0sec-analytics-pipeline-"));
  dirs.push(d);
  return d;
}

interface Captured {
  url: string;
  body: string;
}

let captured: Captured[];
let home: string;

/** A fetch stand-in that records every POST and reports success. */
function capturingFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function logPath(): string {
  return join(home, ".0", ANALYTICS_SENT_LOG_FILENAME);
}

/** Parse the single record from the most recent captured POST body. */
function lastRecord(): Record<string, unknown> {
  const body = captured.at(-1)?.body ?? "{}";
  const parsed = JSON.parse(body) as { records: Record<string, unknown>[] };
  return parsed.records[0];
}

beforeEach(() => {
  analyticsPipeline.__resetForTests();
  captured = [];
  home = tmpHome();
  vi.stubEnv("ZERO_CLOUD_TOKEN", "test-token");
  vi.stubEnv("ZERO_CLOUD_HOST", "https://analytics.test");
  vi.stubEnv("ZERO_ANALYTICS_LEVEL", undefined);
  vi.stubEnv("ZERO_OFFLINE", undefined);
  vi.stubEnv("ZERO_NO_TELEMETRY", undefined);
  vi.stubEnv("DO_NOT_TRACK", undefined);
  analyticsPipeline.configure({ homeDir: home, fetchImpl: capturingFetch() });
});

afterEach(() => {
  analyticsPipeline.__resetForTests();
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("consent gate", () => {
  it("drops everything when level=off — nothing transmitted or logged", async () => {
    analyticsPipeline.setLevel("off");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: { http_request: 3 }, note: "sk-ABCDEFGHIJKLMNOPQRST" },
      "usage",
    );
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(0);
    expect(existsSync(logPath())).toBe(false);
  });

  it("transmits once the level meets the required tier", async () => {
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: { http_request: 1 }, findingCounts: {}, errorCategories: {}, turnCount: 1, durationMs: 10 },
      "usage",
    );
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://analytics.test/api/cli-analytics");
    const rec = lastRecord();
    expect(rec["kind"]).toBe("usage");
    // Random identifiers and finite runtime metadata, not an anonymity guarantee.
    expect(typeof rec["installId"]).toBe("string");
    expect(typeof rec["sessionId"]).toBe("string");
    expect(rec["schemaVersion"]).toBe(1);
  });
});

describe("redaction on the choke path", () => {
  it("scrubs a secret-shaped VALUE before it can be transmitted", async () => {
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: {}, findingCounts: {}, errorCategories: {}, turnCount: 0, durationMs: 0, leaked: "token sk-ABCDEFGHIJKLMNOPQRSTUVWX here" },
      "usage",
    );
    await analyticsPipeline.flushNow();
    const rec = lastRecord();
    expect(String(rec["leaked"])).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(String(rec["leaked"])).toContain(REDACTED_OPENAI);
  });

  it("scrubs a secret-shaped KEY as well as values", () => {
    const out = redactRecordStrings({
      featureCounts: { "password=hunter2supersecret": 4 },
    }) as { featureCounts: Record<string, number> };
    const keys = Object.keys(out.featureCounts);
    expect(keys.some((k) => k.includes("hunter2supersecret"))).toBe(false);
    expect(keys.some((k) => k.includes(REDACTED_SECRET))).toBe(true);
  });
});

describe("bus-derived usage feed", () => {
  it("derives COUNTERS only — carries no raw content / preview", async () => {
    analyticsPipeline.setLevel("usage"); // subscribes the sink to the bus
    eventBus.emit("tool_call_started", {
      tool: "http_request",
      turn: 0,
      args_preview: "GET https://secret.internal/admin?token=sk-ABCDEFGHIJKLMNOP",
      ts: Date.now(),
    });
    eventBus.emit("tool_call_started", { tool: "http_request", turn: 0, args_preview: "x", ts: Date.now() });
    eventBus.emit("tool_call_completed", {
      tool: "shell",
      turn: 0,
      duration_ms: 5,
      status: "error",
      error: "spawn failed: ETIMEDOUT after 30s",
      ts: Date.now(),
    });
    eventBus.emit("finding_ingested", { severity: "high", category: "ssrf" });
    eventBus.emit("cost_update", { cost_usd: 0.42 });
    eventBus.emit("agent_turn_completed", { turn: 0, duration_ms: 1200, reason: "finished" });

    await analyticsPipeline.flushNow();
    const rec = lastRecord();

    // Counters are present and correct.
    expect((rec["featureCounts"] as Record<string, number>)["http_request"]).toBe(2);
    expect((rec["errorCategories"] as Record<string, number>)["timeout"]).toBe(1);
    expect((rec["findingCounts"] as Record<string, number>)["ssrf"]).toBe(1);
    expect(rec["costUsd"]).toBe(0.42);
    expect(rec["turnCount"]).toBe(1);
    expect(rec["durationMs"]).toBe(1200);

    // No raw content / preview fields anywhere in the transmitted payload, and
    // no trace of the secret carried in the (ignored) args_preview.
    const body = captured.at(-1)?.body ?? "";
    expect(body).not.toContain("args_preview");
    expect(body).not.toContain("secret.internal");
    expect(body).not.toContain("sk-ABCDEFGHIJKLMNOP");
  });
});

describe("fail-soft transport", () => {
  it("never throws when the cloud is offline (no credentials)", async () => {
    delete process.env["ZERO_CLOUD_TOKEN"];
    delete process.env["ZERO_CLOUD_HOST"];
    // Point at a fresh empty home so no cloud.env file is found either.
    analyticsPipeline.configure({ homeDir: tmpHome(), fetchImpl: capturingFetch() });
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: { x: 1 }, findingCounts: {}, errorCategories: {}, turnCount: 0, durationMs: 0 },
      "usage",
    );
    await expect(analyticsPipeline.flushNow()).resolves.toBeUndefined();
    expect(captured).toHaveLength(0); // offline → no transmit, no log
  });

  it("never throws when transmission fails", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    analyticsPipeline.configure({ homeDir: home, fetchImpl: throwingFetch });
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: { x: 1 }, findingCounts: {}, errorCategories: {}, turnCount: 0, durationMs: 0 },
      "usage",
    );
    await expect(analyticsPipeline.flushNow()).resolves.toBeUndefined();
  });
});

describe("command / code collectors (commands tier)", () => {
  it("drops recordCommand entirely at level=usage (nothing queued)", async () => {
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.recordCommand({
      tool: "shell",
      args: { cmd: "curl -H 'authorization: sk-ABCDEFGHIJKLMNOPQRSTUVWX' https://x" },
      output: "ok",
      status: "ok",
      durationMs: 12,
      turn: 1,
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(0);
  });

  it("drops recordCommand / recordCode entirely at level=off", async () => {
    analyticsPipeline.setLevel("off");
    analyticsPipeline.recordCommand({ tool: "shell", args: "x", output: "y", status: "ok", durationMs: 1, turn: 0 });
    analyticsPipeline.recordCode({ lang: "ts", source: "const x = 1;", origin: "executable-plugin" });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(0);
    expect(existsSync(logPath())).toBe(false);
  });

  it("transmits a redacted command at level=commands", async () => {
    analyticsPipeline.setLevel("commands");
    analyticsPipeline.recordCommand({
      tool: "shell",
      args: { cmd: "deploy --key sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      output: "leaked sk-ABCDEFGHIJKLMNOPQRSTUVWX in log",
      status: "ok",
      durationMs: 42,
      turn: 3,
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(1);
    const rec = lastRecord();
    expect(rec["tool"]).toBe("shell");
    expect(rec["status"]).toBe("ok");
    expect(rec["durationMs"]).toBe(42);
    expect(rec["turn"]).toBe(3);
    // Secret redacted in both args and output on the wire.
    const body = captured.at(-1)?.body ?? "";
    expect(body).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(String(rec["argsRedacted"])).toContain(REDACTED_OPENAI);
    expect(String(rec["outputRedacted"])).toContain(REDACTED_OPENAI);
  });

  it("transmits a redacted code snippet at level=full (commands is met)", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordCode({
      lang: "ts",
      source: "const key = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'; run(key);",
      origin: "executable-plugin",
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(1);
    const rec = lastRecord();
    expect(rec["lang"]).toBe("ts");
    expect(rec["origin"]).toBe("executable-plugin");
    expect(String(rec["sourceRedacted"])).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(String(rec["sourceRedacted"])).toContain(REDACTED_OPENAI);
  });

  it("recordCommand / recordCode are no-throw when off", () => {
    analyticsPipeline.setLevel("off");
    expect(() => analyticsPipeline.recordCommand({ tool: 1, args: undefined, output: null, status: {}, durationMs: NaN, turn: "x" })).not.toThrow();
    expect(() => analyticsPipeline.recordCode({ lang: null, source: undefined, origin: 3 })).not.toThrow();
  });
});

describe("scope / finding collectors (full tier)", () => {
  it("drops recordScope / recordFinding below full (commands)", async () => {
    analyticsPipeline.setLevel("commands");
    analyticsPipeline.recordScope({ target: "https://acme.example", kind: "target" });
    analyticsPipeline.recordFinding({
      severity: "high", category: "ssrf", title: "t", description: "d",
      evidence: "e", confidence: 0.9,
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(0);
  });

  it("transmits a redacted scope entry at level=full", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordScope({
      target: "https://acme.example/leak sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      kind: "target",
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(1);
    const rec = lastRecord();
    expect(rec["kind"]).toBe("target");
    expect(String(rec["targetRedacted"])).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(String(rec["targetRedacted"])).toContain(REDACTED_OPENAI);
  });

  it("transmits a redacted finding at level=full", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordFinding({
      severity: "critical",
      category: "secrets",
      title: "Leaked key sk-ABCDEFGHIJKLMNOPQRSTUVWX",
      description: "found password=hunter2supersecret in config",
      evidence: { request: "GET /", response: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      confidence: 0.75,
    });
    await analyticsPipeline.flushNow();
    expect(captured).toHaveLength(1);
    const rec = lastRecord();
    expect(rec["severity"]).toBe("critical");
    expect(rec["category"]).toBe("secrets");
    expect(rec["confidence"]).toBe(0.75);
    const body = captured.at(-1)?.body ?? "";
    expect(body).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(body).not.toContain("hunter2supersecret");
    expect(String(rec["titleRedacted"])).toContain(REDACTED_OPENAI);
    expect(String(rec["descriptionRedacted"])).toContain(REDACTED_SECRET);
  });

});

describe("consent changes with pending records", () => {
  it("permanently purges full-tier records on downgrade, regardless of scope kind", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordCode({ lang: "ts", source: "keep", origin: "test" });
    analyticsPipeline.recordScope({ target: "drop.example", kind: "usage" });
    analyticsPipeline.setLevel("commands");
    analyticsPipeline.setLevel("full");
    await analyticsPipeline.flushNow();
    expect(JSON.parse(captured[0]!.body).records.map((record: Record<string, unknown>) => record.sourceRedacted)).toEqual(["keep"]);
    expect(captured[0]!.body).not.toContain("drop.example");
  });

  it("discards queued content and counters while off, without replay after re-enabling", async () => {
    analyticsPipeline.setLevel("full");
    analyticsPipeline.recordCode({ lang: "ts", source: "discard", origin: "test" });
    eventBus.emit("tool_call_started", { tool: "before_off", turn: 0, ts: Date.now() });
    analyticsPipeline.setLevel("off");
    eventBus.emit("tool_call_started", { tool: "while_off", turn: 0, ts: Date.now() });
    await analyticsPipeline.flushNow();
    expect(captured).toEqual([]);
    expect(existsSync(logPath())).toBe(false);
    analyticsPipeline.setLevel("full");
    eventBus.emit("tool_call_started", { tool: "after_on", turn: 1, ts: Date.now() });
    await analyticsPipeline.flushNow();
    expect(lastRecord()["featureCounts"]).toEqual({ after_on: 1 });
  });

  it("honors an environment opt-out and clears earlier accumulated usage", async () => {
    analyticsPipeline.setLevel("full");
    eventBus.emit("tool_call_started", { tool: "before_off", turn: 0, ts: Date.now() });
    process.env["ZERO_ANALYTICS_LEVEL"] = "off";
    eventBus.emit("tool_call_started", { tool: "while_off", turn: 0, ts: Date.now() });
    await analyticsPipeline.flushNow();
    expect(captured).toEqual([]);
    delete process.env["ZERO_ANALYTICS_LEVEL"];
    eventBus.emit("tool_call_started", { tool: "after_on", turn: 1, ts: Date.now() });
    await analyticsPipeline.flushNow();
    expect(lastRecord()["featureCounts"]).toEqual({ after_on: 1 });
  });

  it("rechecks the environment before later POSTs, retaining only permitted usage", async () => {
    analyticsPipeline.setLevel("full");
    const capture = capturingFetch();
    analyticsPipeline.configure({ fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      const response = await capture(...args);
      process.env["ZERO_ANALYTICS_LEVEL"] = "usage";
      return response;
    }) as typeof fetch });
    for (let i = 0; i < 100; i++) analyticsPipeline.recordCode({ lang: "ts", source: `code ${i}`, origin: "test" });
    analyticsPipeline.recordScope({ target: "must-not-send.example", kind: "usage" });
    eventBus.emit("tool_call_started", { tool: "safe_counter", turn: 1, ts: Date.now() });
    await analyticsPipeline.flushNow();
    expect(captured.map((request) => JSON.parse(request.body).records.length)).toEqual([100, 1]);
    expect(lastRecord()["featureCounts"]).toEqual({ safe_counter: 1 });
    expect(captured.some((request) => request.body.includes("must-not-send.example"))).toBe(false);
  });

  it("does not resurrect unsent records when consent is downgraded then restored during HTTP", async () => {
    analyticsPipeline.setLevel("full");
    const capture = capturingFetch();
    analyticsPipeline.configure({ fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      const response = await capture(...args);
      analyticsPipeline.setLevel("usage");
      analyticsPipeline.setLevel("full");
      return response;
    }) as typeof fetch });
    for (let i = 0; i < 101; i++) analyticsPipeline.recordCode({ lang: "ts", source: `code ${i}`, origin: "test" });
    await analyticsPipeline.flushNow();
    expect(captured.map((request) => JSON.parse(request.body).records.length)).toEqual([100]);
  });
});

describe("receiver byte and record limits", () => {
  it("splits at 100 records without losing or duplicating records", async () => {
    analyticsPipeline.setLevel("commands");
    const sources = Array.from({ length: 150 }, (_, i) => `code ${i}`);
    for (const source of sources) analyticsPipeline.recordCode({ lang: "ts", source, origin: "test" });
    await analyticsPipeline.flushNow();
    const batches: Record<string, unknown>[][] = captured.map((request) => JSON.parse(request.body).records);
    expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
    expect(batches.flat().map((record) => record.sourceRedacted)).toEqual(sources);
  });

  it("preserves long Unicode content while splitting by encoded JSON bytes including escaping", async () => {
    analyticsPipeline.setLevel("commands");
    const source = "界\n".repeat(50_000);
    for (let i = 0; i < 5; i++) analyticsPipeline.recordCode({ lang: "ts", source, origin: "test" });
    await analyticsPipeline.flushNow();
    const batches: Record<string, unknown>[][] = captured.map((request) => JSON.parse(request.body).records);
    expect(batches.map((batch) => batch.length)).toEqual([4, 1]);
    expect(batches.flat().map((record) => record.sourceRedacted)).toEqual(Array(5).fill(source));
    for (const request of captured) expect(Buffer.byteLength(request.body, "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("accepts the exact redacted field limit and reports oversize fields and records locally only", async () => {
    analyticsPipeline.setLevel("commands");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const boundary = "界".repeat(Math.floor(MAX_CONTENT_BYTES / 3)) + "a";
      analyticsPipeline.recordCode({ lang: "ts", source: boundary, origin: "test" });
      analyticsPipeline.recordCode({ lang: "ts", source: boundary + "界", origin: "test" });
      // Raw size exceeds the limit, but the fully redacted field fits.
      analyticsPipeline.recordCode({ lang: "ts", source: "sk-" + "a".repeat(MAX_CONTENT_BYTES + 1), origin: "test" });
      // Both fields fit individually; JSON control-character escaping makes
      // the complete wire record too large.
      analyticsPipeline.recordCommand({
        tool: "test", args: "\u0000".repeat(100_000), output: "\u0000".repeat(100_000),
        status: "ok", durationMs: 1, turn: 1,
      });
      await analyticsPipeline.flushNow();
      expect(JSON.parse(captured[0]!.body).records.map((record: Record<string, unknown>) => record.sourceRedacted)).toEqual([boundary, REDACTED_OPENAI]);
      expect(captured).toHaveLength(1);
      const outcomes = readFileSync(join(home, ".0", "analytics-outcomes.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(outcomes.map((outcome) => outcome.field)).toEqual(["sourceRedacted", "record"]);
      for (const outcome of outcomes) {
        expect(Object.keys(outcome).sort()).toEqual(["bytes", "field", "maxBytes", "outcome", "ts"]);
        expect(outcome.outcome).toBe("oversize");
        expect(outcome.bytes).toBeGreaterThan(outcome.maxBytes);
      }
      expect(stderr).toHaveBeenCalledTimes(2);
      await analyticsPipeline.flushNow();
      expect(captured).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("transparency log", () => {
  it("records only the post-redaction wire payload", async () => {
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: {}, findingCounts: {}, errorCategories: {}, turnCount: 2, durationMs: 3, leaked: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      "usage",
    );
    await analyticsPipeline.flushNow();
    const logged = readFileSync(logPath(), "utf8").trim();
    expect(JSON.parse(logged)).toEqual(lastRecord());
    expect(logged).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(logged).toContain(REDACTED_OPENAI);
  });
});
