import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventBus } from "../events/bus.js";
import {
  analyticsPipeline,
  ANALYTICS_SENT_LOG_FILENAME,
  redactRecordStrings,
} from "./analytics-pipeline.js";
import { REDACTED_OPENAI, REDACTED_SECRET } from "./redaction.js";

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
  return join(home, ".0sec", ANALYTICS_SENT_LOG_FILENAME);
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
  // Cloud credentials via env so loadCloudCredentials resolves (source=env).
  process.env["0SEC_CLOUD_TOKEN"] = "test-token";
  process.env["0SEC_CLOUD_HOST"] = "https://analytics.test";
  // Ensure no opt-out env interferes.
  delete process.env["0SEC_OFFLINE"];
  delete process.env["0SEC_NO_TELEMETRY"];
  delete process.env["DO_NOT_TRACK"];
  analyticsPipeline.configure({ homeDir: home, fetchImpl: capturingFetch() });
});

afterEach(() => {
  analyticsPipeline.__resetForTests();
  delete process.env["0SEC_CLOUD_TOKEN"];
  delete process.env["0SEC_CLOUD_HOST"];
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
    // Envelope attached, with finite + anonymous identity only.
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
    delete process.env["0SEC_CLOUD_TOKEN"];
    delete process.env["0SEC_CLOUD_HOST"];
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

describe("transparency log", () => {
  it("writes every transmitted (post-redaction) payload as JSONL", async () => {
    analyticsPipeline.setLevel("usage");
    analyticsPipeline.__enqueueForTests(
      { kind: "usage", featureCounts: {}, findingCounts: {}, errorCategories: {}, turnCount: 2, durationMs: 3, leaked: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" },
      "usage",
    );
    await analyticsPipeline.flushNow();
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]) as Record<string, unknown>;
    // The transparency log is post-redaction: the secret must already be gone.
    expect(JSON.stringify(logged)).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(String(logged["leaked"])).toContain(REDACTED_OPENAI);
  });
});
