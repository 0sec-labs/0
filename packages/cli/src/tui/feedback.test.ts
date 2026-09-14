import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_FEEDBACK_URL,
  FEEDBACK_WIRE_FIELDS,
  appendFeedback,
  buildDiagnosticFeedback,
  buildSubmitPreview,
  feedbackEndpoint,
  feedbackFilePath,
  formatFeedbackEntry,
  scanForSecrets,
  submissionBlockedReason,
  parseFeedbackCommand,
  submitFeedback,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
  buildDiagnosticReview,
  diagnosticErrorText,
  LOCAL_DETAIL_NOTICE,
  MAX_LOCAL_DETAIL_CHARS,
  type DiagnosticInfo,
  type FeedbackPayload,
} from "./feedback.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "0sec-feedback-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("feedbackFilePath", () => {
  it("lives under the operator's own 0sec directory", () => {
    expect(feedbackFilePath("/home/op")).toBe("/home/op/.0sec/feedback.md");
  });
});

describe("formatFeedbackEntry", () => {
  it("renders a timestamped markdown block", () => {
    const out = formatFeedbackEntry({ message: "the picker is great", timestamp: "2026-08-22T10:00:00.000Z" });
    expect(out).toContain("## 2026-08-22T10:00:00.000Z");
    expect(out).toContain("the picker is great");
  });

  it("includes context only when supplied", () => {
    const bare = formatFeedbackEntry({ message: "x", timestamp: "t" });
    expect(bare).not.toContain("_");
    const rich = formatFeedbackEntry({
      message: "x",
      timestamp: "t",
      version: "0.13.0",
      model: "gpt-5.5",
      mode: "Standard",
    });
    expect(rich).toContain("_version 0.13.0 · model gpt-5.5 · mode Standard_");
  });

  it("trims the message body", () => {
    expect(formatFeedbackEntry({ message: "  padded  ", timestamp: "t" })).toContain("\npadded\n");
  });
});

describe("appendFeedback", () => {
  it("writes the entry and reports the path", () => {
    const home = tempHome();
    const result = appendFeedback({ message: "first", timestamp: "t1" }, home);
    expect(result.ok).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("first");
  });

  it("appends rather than overwriting", () => {
    const home = tempHome();
    appendFeedback({ message: "first", timestamp: "t1" }, home);
    const second = appendFeedback({ message: "second", timestamp: "t2" }, home);
    const body = readFileSync(second.path, "utf8");
    expect(body).toContain("first");
    expect(body).toContain("second");
  });

  it("reports failure instead of throwing when the path is unwritable", () => {
    const home = tempHome();
    // A regular file where the .0sec directory needs to be.
    writeFileSync(join(home, ".0sec"), "not a directory", "utf8");
    const result = appendFeedback({ message: "nope", timestamp: "t" }, home);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("parseFeedbackCommand", () => {
  it("keeps ordinary text local by default", () => {
    expect(parseFeedbackCommand("the picker is great")).toEqual({
      kind: "record",
      message: "the picker is great",
    });
  });

  it("recognizes only complete explicit send controls", () => {
    expect(parseFeedbackCommand("submit send this")).toEqual({ kind: "submit", message: "send this" });
    expect(parseFeedbackCommand("send")).toEqual({ kind: "send" });
    expect(parseFeedbackCommand("cancel")).toEqual({ kind: "cancel" });
    expect(parseFeedbackCommand("send extra")).toEqual({ kind: "usage" });
    expect(parseFeedbackCommand("cancel extra")).toEqual({ kind: "usage" });
  });

  it("requires a message for submit", () => {
    expect(parseFeedbackCommand("")).toEqual({ kind: "usage" });
    expect(parseFeedbackCommand("submit")).toEqual({ kind: "usage" });
  });
});

// ---------------------------------------------------------------------------
// Opt-in submission
// ---------------------------------------------------------------------------

const HTTPS_ENV = { "0SEC_FEEDBACK_URL": "https://feedback.example.test/v1/feedback" };
const NO_CLOUD = { cloudCredentials: () => null };
const CLOUD_CREDENTIALS = {
  cloudCredentials: () => ({
    host: "https://cloud.0sec.ai",
    token: "cloud-feedback-token",
  }),
};

function payload(overrides: Partial<FeedbackPayload> = {}): FeedbackPayload {
  return { message: "the picker is great", timestamp: "2026-08-22T10:00:00.000Z", ...overrides };
}

/** A transport that records calls and never touches the network. */
function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return impl(String(url), (init ?? {}) as RequestInit);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function okResponse(status = 202) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe("feedbackEndpoint", () => {
  it("reads the endpoint from the env var", () => {
    expect(feedbackEndpoint(HTTPS_ENV)).toBe("https://feedback.example.test/v1/feedback");
  });

  it("returns null when nothing is configured", () => {
    expect(feedbackEndpoint({}, NO_CLOUD)).toBeNull();
  });

  it("does not ship a guessed production URL", () => {
    // Guarding the TODO: a placeholder host would either black-hole feedback
    // or hand engagement context to whoever registers it.
    expect(DEFAULT_FEEDBACK_URL).toBe("");
  });

  it("ignores a blank or whitespace-only setting", () => {
    expect(feedbackEndpoint({ "0SEC_FEEDBACK_URL": "   " }, NO_CLOUD)).toBeNull();
  });

  it("derives the canonical authenticated cloud receiver from CLI credentials", () => {
    expect(feedbackEndpoint({}, CLOUD_CREDENTIALS)).toBe("https://cloud.0.security/api/cli-feedback");
  });

  it("can disable cloud fallback for a flow without a reviewed preview", () => {
    expect(feedbackEndpoint({}, { ...CLOUD_CREDENTIALS, allowCloud: false })).toBeNull();
    expect(
      feedbackEndpoint({ "0SEC_FEEDBACK_URL": "https://self-hosted.example/feedback" }, {
        ...CLOUD_CREDENTIALS,
        allowCloud: false,
      }),
    ).toBe("https://self-hosted.example/feedback");
  });
});

describe("submissionBlockedReason", () => {
  it("allows a configured https endpoint", () => {
    expect(submissionBlockedReason(HTTPS_ENV)).toBeNull();
  });

  it("reports no-endpoint when unset", () => {
    expect(submissionBlockedReason({}, NO_CLOUD)).toBe("no-endpoint");
  });

  it("refuses plaintext http", () => {
    expect(submissionBlockedReason({ "0SEC_FEEDBACK_URL": "http://feedback.example.test" })).toBe(
      "insecure-endpoint",
    );
  });

  it("refuses an unparseable endpoint", () => {
    expect(submissionBlockedReason({ "0SEC_FEEDBACK_URL": "not a url" })).toBe("insecure-endpoint");
  });

  it.each(["0SEC_OFFLINE", "0SEC_NO_TELEMETRY", "DO_NOT_TRACK"])(
    "%s wins over a configured endpoint",
    (name) => {
      expect(submissionBlockedReason({ ...HTTPS_ENV, [name]: "1" })).toBe("opt-out");
    },
  );

  it.each(["1", "true", "yes", "on"])("treats %s as opt-out", (value) => {
    expect(submissionBlockedReason({ ...HTTPS_ENV, "0SEC_OFFLINE": value })).toBe("opt-out");
  });

  it.each(["0", "false", "no", "", "  "])("does not treat %s as opt-out", (value) => {
    expect(submissionBlockedReason({ ...HTTPS_ENV, "0SEC_OFFLINE": value })).toBeNull();
  });
});

describe("buildSubmitPreview", () => {
  it("carries ONLY the declared fields on the wire", () => {
    const preview = buildSubmitPreview(
      payload({ version: "0.13.0", model: "gpt-5.5", mode: "Standard" }),
      HTTPS_ENV,
    );
    const parsed = JSON.parse(preview!.body);
    expect(Object.keys(parsed).sort()).toEqual([...FEEDBACK_WIRE_FIELDS].sort());
    expect(parsed).toEqual({
      message: "the picker is great",
      timestamp: "2026-08-22T10:00:00.000Z",
      version: "0.13.0",
      model: "gpt-5.5",
      mode: "Standard",
    });
  });

  it("attaches nothing the caller did not pass", () => {
    const preview = buildSubmitPreview(payload(), HTTPS_ENV);
    const parsed = JSON.parse(preview!.body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["message", "timestamp"]);
    // No transcript, findings, scan id, host, user, or environment detail.
    for (const forbidden of [
      "transcript",
      "history",
      "messages",
      "findings",
      "scanId",
      "scan_id",
      "sessionId",
      "target",
      "env",
      "environment",
      "os",
      "platform",
      "arch",
      "hostname",
      "user",
      "userId",
      "machineId",
      "telemetry",
      "cwd",
    ]) {
      expect(parsed[forbidden]).toBeUndefined();
    }
    expect(preview!.body).not.toContain(process.cwd());
  });

  it("sets no headers beyond content-type", () => {
    expect(buildSubmitPreview(payload(), HTTPS_ENV)!.headers).toEqual({
      "content-type": "application/json",
    });
  });

  it("shows the URL the bytes would go to", () => {
    expect(buildSubmitPreview(payload(), HTTPS_ENV)!.url).toBe(
      "https://feedback.example.test/v1/feedback",
    );
  });

  it("redacts cloud authorization in the preview but sends it on the wire", async () => {
    const preview = buildSubmitPreview(payload(), {}, CLOUD_CREDENTIALS)!;
    expect(preview.url).toBe("https://cloud.0.security/api/cli-feedback");
    expect(preview.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer <redacted>",
    });

    const { fn, calls } = stubFetch(() => okResponse());
    await submitFeedback(payload(), {}, { fetchImpl: fn, ...CLOUD_CREDENTIALS });
    expect(calls[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer cloud-feedback-token",
    });
  });

  it("surfaces credential warnings so the UI can show them before the confirm", () => {
    const preview = buildSubmitPreview(payload({ message: "broke on sk-abcdefghijklmnop123456" }), HTTPS_ENV);
    expect(preview!.warnings.length).toBeGreaterThan(0);
  });

  it("is null when submission is blocked", () => {
    expect(buildSubmitPreview(payload(), {}, NO_CLOUD)).toBeNull();
    expect(buildSubmitPreview(payload(), { ...HTTPS_ENV, "0SEC_OFFLINE": "1" })).toBeNull();
    expect(buildSubmitPreview(payload(), { "0SEC_FEEDBACK_URL": "http://x.test" })).toBeNull();
  });

  it("matches the bytes actually transmitted", async () => {
    const body = payload({ version: "0.13.0" });
    const preview = buildSubmitPreview(body, HTTPS_ENV)!;
    const { fn, calls } = stubFetch(() => okResponse());
    await submitFeedback(body, HTTPS_ENV, { fetchImpl: fn });
    expect(calls[0].init.body).toBe(preview.body);
    expect(calls[0].url).toBe(preview.url);
    expect(calls[0].init.headers).toEqual(preview.headers);
  });
});

describe("scanForSecrets", () => {
  const shapes: Array<[string, string]> = [
    ["sk- key", "here: sk-proj-AbCdEf0123456789XyZw"],
    ["github token", "token ghp_AbCdEf0123456789AbCdEf0123456789"],
    ["aws key id", "creds AKIAIOSFODNN7EXAMPLE broke it"],
    ["authorization header", "sent Authorization: Bearer abc.def.ghi and it 401'd"],
    ["pem private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"],
    ["long base64-ish run", "blob QWxhZGRpbjpvcGVuIHNlc2FtZQ123456789ABCDefghijkLMNop=="],
    ["google api key", "key AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
    ["slack token", "xoxb-" + "EXAMPLE-REDACTED-FIXTURE-TOKEN"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["assignment", "config had password=hunter2swordfish"],
  ];

  it.each(shapes)("warns on %s", (_label, message) => {
    expect(scanForSecrets(message).length).toBeGreaterThan(0);
  });

  it.each(shapes)("returns %s UNMODIFIED — warn, never scrub", (_label, message) => {
    // The whole point: no silent redaction. A scrubber would promise a
    // guarantee it cannot keep and stop the operator from reading their own
    // message. Prove the payload still carries every original byte.
    const before = message;
    scanForSecrets(message);
    expect(message).toBe(before);
    const preview = buildSubmitPreview(payload({ message }), HTTPS_ENV)!;
    expect(JSON.parse(preview.body).message).toBe(before);
    expect(preview.warnings.length).toBeGreaterThan(0);
  });

  it("stays quiet on ordinary feedback", () => {
    expect(
      scanForSecrets("The model picker is confusing when the list is longer than the panel."),
    ).toEqual([]);
    expect(scanForSecrets("Scanning https://staging.example.com/admin/login was slow.")).toEqual([]);
  });

  it("never echoes the matched secret back into the warning text", () => {
    const warnings = scanForSecrets("key sk-proj-AbCdEf0123456789XyZw");
    for (const warning of warnings) expect(warning).not.toContain("sk-proj-AbCdEf0123456789XyZw");
  });
});

describe("submitFeedback", () => {
  it("posts to the configured endpoint and reports the status", async () => {
    const { fn, calls } = stubFetch(() => okResponse(202));
    const result = await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn });
    expect(result).toEqual({ ok: true, status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
  });

  it("refuses when opted out, even though sending was explicitly requested", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    for (const name of ["0SEC_OFFLINE", "0SEC_NO_TELEMETRY", "DO_NOT_TRACK"]) {
      const result = await submitFeedback(payload(), { ...HTTPS_ENV, [name]: "1" }, { fetchImpl: fn });
      expect(result.ok).toBe(false);
      expect(result.skipped).toBe("opt-out");
      expect(result.error).toBeTruthy();
    }
    // Not one packet: the connection itself is what the org disabled.
    expect(calls).toHaveLength(0);
  });

  it("reports no-endpoint rather than throwing or silently succeeding", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    const result = await submitFeedback(payload(), {}, { fetchImpl: fn, cloudCredentials: () => null });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe("no-endpoint");
    expect(result.error).toContain("0SEC_FEEDBACK_URL");
    expect(calls).toHaveLength(0);
  });

  it("refuses a plaintext http endpoint", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    const result = await submitFeedback(
      payload(),
      { "0SEC_FEEDBACK_URL": "http://feedback.example.test" },
      { fetchImpl: fn },
    );
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe("insecure-endpoint");
    expect(calls).toHaveLength(0);
  });

  it("returns ok:false instead of throwing when the network fails", async () => {
    const { fn } = stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND feedback.example.test");
    });
    const result = await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
    expect(result.skipped).toBeUndefined();
  });

  it("returns ok:false on a rejected promise", async () => {
    const fn = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;
    await expect(submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn })).resolves.toEqual({
      ok: false,
      error: "socket hang up",
    });
  });

  it("surfaces a non-2xx response without throwing", async () => {
    const { fn } = stubFetch(() => okResponse(503));
    const result = await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("never reposts feedback to a second origin after a 307 or 308 redirect", async () => {
    let redirectedDeliveries = 0;
    let reviewedDeliveries = 0;
    let redirectStatus = 307;
    const destination = createServer((request, response) => {
      redirectedDeliveries++;
      request.resume();
      response.writeHead(202, { connection: "close" });
      response.end();
    });
    const source = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        reviewedDeliveries++;
        response.writeHead(redirectStatus, {
          location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/unreviewed`,
          connection: "close",
        });
        response.end();
      });
    });
    try {
      await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
      await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
      const env = { "0SEC_FEEDBACK_URL": `https://127.0.0.1:${(source.address() as AddressInfo).port}/reviewed` };
      const report = payload();
      // Map the initial TLS address to the HTTP-only local fixture. Native
      // fetch owns redirect handling; no response or redirect is mocked.
      const localFetch = ((url, init) => fetch(String(url).replace(/^https:/, "http:"), init)) as typeof fetch;
      for (redirectStatus of [307, 308]) {
        const result = await submitFeedback(report, env, {
          fetchImpl: localFetch,
          expectedPreview: buildSubmitPreview(report, env)!,
        });
        expect(result.ok).toBe(false);
        expect(redirectedDeliveries).toBe(0);
      }
      expect(reviewedDeliveries).toBe(2);
    } finally {
      for (const server of [source, destination]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("rejects with zero POST when the endpoint differs from the reviewed preview", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    const preview = buildSubmitPreview(payload(), HTTPS_ENV)!;
    const result = await submitFeedback(payload(), HTTPS_ENV, {
      fetchImpl: fn,
      expectedPreview: { ...preview, url: "https://evil.example.com/hook" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("changed");
    expect(calls).toHaveLength(0);
  });

  it("rejects with zero POST when the body differs from the reviewed preview", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    const preview = buildSubmitPreview(payload(), HTTPS_ENV)!;
    const result = await submitFeedback(
      payload({ message: "different body than previewed" }),
      HTTPS_ENV,
      { fetchImpl: fn, expectedPreview: preview },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("changed");
    expect(calls).toHaveLength(0);
  });

  it("rejects with zero POST when the redacted headers differ from the reviewed preview", async () => {
    const { fn, calls } = stubFetch(() => okResponse());
    const preview = buildSubmitPreview(payload(), {}, CLOUD_CREDENTIALS)!;
    // Feed a preview whose redacted headers do not match the current target
    const result = await submitFeedback(payload(), {}, {
      fetchImpl: fn,
      expectedPreview: { ...preview, headers: { "content-type": "text/plain" } },
      ...CLOUD_CREDENTIALS,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("changed");
    expect(calls).toHaveLength(0);
  });

  it("still submits when the preview matches exactly", async () => {
    const { fn, calls } = stubFetch(() => okResponse(202));
    const preview = buildSubmitPreview(payload(), HTTPS_ENV)!;
    const result = await submitFeedback(payload(), HTTPS_ENV, {
      fetchImpl: fn,
      expectedPreview: preview,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not hang when the transport never settles", async () => {
    // Deliberately ignores the abort signal, which is the case a signal-only
    // timeout would miss.
    const fn = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const result = await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it("aborts the request when it times out", async () => {
    let signal: AbortSignal | undefined;
    const fn = ((_url: unknown, init: { signal?: AbortSignal }) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn, timeoutMs: 20 });
    expect(signal?.aborted).toBe(true);
  });

  it("never retries", async () => {
    const { fn, calls } = stubFetch(() => okResponse(500));
    await submitFeedback(payload(), HTTPS_ENV, { fetchImpl: fn });
    expect(calls).toHaveLength(1);
  });

  it("does not send anything unless it is called", () => {
    // There is no background queue and no "always send" setting; the local
    // append must not touch the network on its own, even with an endpoint
    // configured in the environment.
    const home = tempHome();
    const real = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = (() => {
      hits += 1;
      return Promise.resolve(okResponse());
    }) as unknown as typeof fetch;
    try {
      appendFeedback({ message: "local only", timestamp: "t" }, home);
    } finally {
      globalThis.fetch = real;
    }
    expect(hits).toBe(0);
  });

  it("leaves the local record intact when submission fails", async () => {
    const home = tempHome();
    const local = appendFeedback({ message: "kept", timestamp: "t" }, home);
    const { fn } = stubFetch(() => {
      throw new Error("network down");
    });
    const result = await submitFeedback(payload({ message: "kept" }), HTTPS_ENV, { fetchImpl: fn });
    expect(result.ok).toBe(false);
    expect(readFileSync(local.path, "utf8")).toContain("kept");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic auto-report
// ---------------------------------------------------------------------------

function diagInfo(overrides: Partial<DiagnosticInfo> = {}): DiagnosticInfo {
  return {
    kind: "tool",
    version: "0.14.0",
    platform: "linux",
    arch: "x64",
    runtime: "node",
    runtimeVersion: "v20.11.0",
    toolName: undefined,
    error: undefined,
    timestamp: "2026-09-11T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildDiagnosticFeedback", () => {
  it("reports the finite category and release without private error or tool context", () => {
    const secret = "private-target-and-credential";
    const result = buildDiagnosticFeedback(diagInfo({
      toolName: secret,
      error: new TypeError(secret),
      version: `0.14.0-${secret}`,
      runtimeVersion: `v24.3.0-${secret}`,
    }));
    expect(result.version).toBe("0.14.0");
    expect(result.message).toContain("Error: TypeError");
    expect(result.message).toContain("linux/x64 on node 24.3.0");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.model).toBeUndefined();
    expect(result.mode).toBeUndefined();
  });

  it("does not accept inherited object names or malformed metadata as classifiers", () => {
    for (const unsafe of ["constructor", "__proto__", "toString", "secret".repeat(200)]) {
      const result = buildDiagnosticFeedback(diagInfo({
        platform: unsafe, arch: unsafe, runtime: unsafe,
        runtimeVersion: unsafe, version: unsafe, timestamp: unsafe,
      }));
      expect(result.version).toBe("unknown");
      expect(result.message).toContain("unknown/unknown on unknown unknown");
      expect(JSON.stringify(result)).not.toContain(unsafe);
      expect(Number.isFinite(Date.parse(result.timestamp))).toBe(true);
      expect(Buffer.byteLength(result.message)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_BYTES);
    }
  });

  it("bounds numeric metadata and survives an uninspectable error", () => {
    const result = buildDiagnosticFeedback(diagInfo({
      version: "999999.999999.999999",
      runtimeVersion: "999999.999999.999999",
      error: new Proxy({}, { getPrototypeOf() { throw new Error("private"); } }),
    }));
    expect(result.message).toContain("Error: unknown");
    expect(result.message).not.toContain("private");
    expect(Buffer.byteLength(result.message)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_BYTES);
  });

  it("classifies string/tool failures into a finite mode instead of 'unknown', leaking no raw text", () => {
    const cases: [unknown, string][] = [
      ["exited 1: /home/dev/secret/target scan failed", "Error: nonzero-exit"],
      ["ENOENT: no such file /etc/private/target.conf", "Error: not-found"],
      ["connect ETIMEDOUT 10.0.0.5:443", "Error: timeout"],
      ["fetch failed: ECONNREFUSED https://target.internal", "Error: network"],
      ["permission denied opening /root/.ssh/id_rsa", "Error: permission"],
      ["429 Too Many Requests", "Error: rate-limit"],
      ["unexpected token < in JSON at position 0", "Error: parse"],
      ["stream completed without final response", "Error: stream-incomplete"],
      ["something totally unrecognised happened", "Error: tool-error"],
      [new Error("exited 2: nmap crashed"), "Error: Error:nonzero-exit"],
    ];
    for (const [error, expected] of cases) {
      const result = buildDiagnosticFeedback(diagInfo({ error, kind: "tool" }));
      expect(result.message).toContain(expected);
      // No raw path/host/text from the input leaks into the finite wire body.
      for (const secret of ["/home/dev/secret", "/etc/private", "10.0.0.5", "target.internal", "/root/.ssh", "nmap"]) {
        expect(result.message).not.toContain(secret);
      }
      expect(Buffer.byteLength(result.message)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
// Operator-facing local detail (never transmitted)
// ---------------------------------------------------------------------------

describe("diagnosticErrorText", () => {
  it("returns the real message for a string error instead of a category", () => {
    expect(diagnosticErrorText("self_extend build failed: exited 1: gcc: fatal error")).toBe(
      "self_extend build failed: exited 1: gcc: fatal error",
    );
  });

  it("uses a thrown Error's message, falling back to its name when empty", () => {
    expect(diagnosticErrorText(new TypeError("bad arg"))).toBe("bad arg");
    expect(diagnosticErrorText(new TypeError(""))).toBe("TypeError");
  });

  it("returns empty string only when there is genuinely nothing", () => {
    expect(diagnosticErrorText(undefined)).toBe("");
    expect(diagnosticErrorText(null)).toBe("");
    expect(diagnosticErrorText("   ")).toBe("");
    expect(diagnosticErrorText({})).toBe("");
  });

  it("survives a hostile proxy", () => {
    const hostile = new Proxy({}, { get() { throw new Error("private"); } });
    expect(() => diagnosticErrorText(hostile)).not.toThrow();
  });
});

describe("buildDiagnosticReview", () => {
  it("shows the real error message locally while keeping the wire body coarse", () => {
    const real = "self_extend build failed: exited 2: undefined reference to `foo`";
    const { payload, localDetail } = buildDiagnosticReview(diagInfo({
      toolName: "self_extend",
      error: real,
    }));
    // Operator sees the full detail...
    expect(localDetail).toContain(real);
    expect(localDetail).toContain("Tool: self_extend");
    expect(localDetail).not.toContain("Error: unknown");
    // ...but the transmit-safe payload stays a finite CATEGORY (the failure
    // mode, "nonzero-exit"), never "unknown" and never the raw message.
    expect(payload.message).toContain("Error: nonzero-exit");
    expect(payload.message).not.toContain("Error: unknown");
    expect(JSON.stringify(payload)).not.toContain(real);
    expect(JSON.stringify(payload)).not.toContain("foo");
  });

  it("is byte-identical on the wire to buildDiagnosticFeedback", () => {
    const info = diagInfo({ toolName: "http_request", error: "url is required" });
    expect(buildDiagnosticReview(info).payload).toEqual(buildDiagnosticFeedback(info));
  });

  it("never shows a bare 'unknown' when a real message exists", () => {
    const { localDetail } = buildDiagnosticReview(diagInfo({ error: "url is required" }));
    expect(localDetail).toBe("Error: url is required");
  });

  it("falls back to an honest named line when there is truly no message", () => {
    const { localDetail } = buildDiagnosticReview(diagInfo({ kind: "tool", error: undefined }));
    expect(localDetail).toBe("Error: tool failed without an error message");
    expect(localDetail).not.toContain("unknown");
  });

  it("appends separately-carried exit output but not when already folded in", () => {
    const withSeparate = buildDiagnosticReview(diagInfo({
      error: "command failed",
      exitOutput: "exited 1: permission denied",
    }));
    expect(withSeparate.localDetail).toContain("command failed");
    expect(withSeparate.localDetail).toContain("exited 1: permission denied");

    const alreadyFolded = buildDiagnosticReview(diagInfo({
      error: "command failed (exited 1: permission denied)",
      exitOutput: "exited 1: permission denied",
    }));
    // The exit summary appears once (already inside the error), not twice.
    expect(alreadyFolded.localDetail.match(/permission denied/g)).toHaveLength(1);
  });

  it("bounds the local detail length", () => {
    const { localDetail } = buildDiagnosticReview(diagInfo({ error: "x".repeat(MAX_LOCAL_DETAIL_CHARS * 2) }));
    expect(localDetail.length).toBeLessThanOrEqual(MAX_LOCAL_DETAIL_CHARS);
  });

  it("exposes a local-only notice for the UI to display", () => {
    expect(LOCAL_DETAIL_NOTICE.toLowerCase()).toContain("not transmitted");
  });
});
