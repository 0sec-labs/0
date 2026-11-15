import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosticFeedback, type DiagnosticInfo } from "./feedback.js";
import {
  MAX_PENDING_REPORTS, deletePendingReport, discardPendingReports, handleDiagnosticReport, listPendingReports,
  pendingDirectory, readPendingReport, savePendingReport, type DiagnosticPolicy,
} from "./pending-diagnostics.js";

const DSN = "https://abc123@o0.ingest.de.sentry.io/1";
const SECRET = "sk-FAKEFAKEFAKEFAKEFAKE1234567890";
const HOST = "internal-client-db.corp.example";
const PATH_LEAK = "/Users/alice/clients/acme/scan-output.txt";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "zero-pending-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

function crashError(): TypeError {
  const error = new TypeError(`connect ECONNREFUSED ${HOST}: token=${SECRET} while reading ${PATH_LEAK}`);
  error.stack = `TypeError: ${error.message}\n    at run (/home/ci/work/0/packages/cli/dist/index.js:10:20)\n    at x (${PATH_LEAK}:3:4)`;
  return error;
}
const info = (extra: Partial<DiagnosticInfo> = {}): DiagnosticInfo => ({
  kind: "runtime", surface: "cli", version: "1.2.3", platform: "darwin", arch: "arm64", runtime: "node", runtimeVersion: "24.1.0",
  error: crashError(), command: "scan web", ...extra,
});
const run = (policy: DiagnosticPolicy, env: Record<string, string | undefined>, submit = vi.fn(async () => ({ ok: true }))) =>
  ({ submit, result: handleDiagnosticReport(info(), { policy: () => policy, env, homeDir: home, submit: submit as never }) });
const files = () => (existsSync(pendingDirectory(home)) ? readdirSync(pendingDirectory(home)) : []);

describe("handleDiagnosticReport consent model", () => {
  it("off drops everything: nothing sent, nothing stored", async () => {
    const { submit, result } = run("off", { ZERO_SENTRY_DSN: DSN });
    expect(await result).toBe("dropped");
    expect(submit).not.toHaveBeenCalled();
    expect(files()).toEqual([]);
  });

  it("ask stores a 0600 pending report and never transmits", async () => {
    const { submit, result } = run("ask", { ZERO_SENTRY_DSN: DSN });
    expect(await result).toBe("pending");
    expect(submit).not.toHaveBeenCalled();
    const [name] = files();
    expect(statSync(join(pendingDirectory(home), name!)).mode & 0o777).toBe(0o600);
    expect(statSync(pendingDirectory(home)).mode & 0o777).toBe(0o700);
    expect(listPendingReports(home)).toMatchObject([{ surface: "cli", category: "TypeError" }]);
  });

  it("automatic submits once, with only finite fields", async () => {
    const submit = vi.fn(async () => ({ ok: true }));
    expect(await handleDiagnosticReport(info(), { policy: () => "automatic", env: { ZERO_SENTRY_DSN: DSN }, homeDir: home, submit: submit as never })).toBe("submitted");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(files()).toEqual([]);
    const [payload, , options] = submit.mock.calls[0] as unknown as [{ message: string }, unknown, { timeoutMs: number; allowCloud: boolean }];
    expect(options.timeoutMs).toBeLessThanOrEqual(2000);
    expect(options.allowCloud).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(new RegExp(`${SECRET}|${HOST}|alice|acme|scan-output`));
  });

  it.each(["ZERO_OFFLINE", "ZERO_NO_TELEMETRY", "DO_NOT_TRACK"])("%s blocks send and persistence in every mode", async (name) => {
    for (const policy of ["ask", "automatic"] as const) {
      const { submit, result } = run(policy, { ZERO_SENTRY_DSN: DSN, [name]: "1" });
      expect(await result).toBe("dropped");
      expect(submit).not.toHaveBeenCalled();
    }
    expect(files()).toEqual([]);
  });

  it("without a destination nothing is stored for sending", async () => {
    expect(await run("ask", { ZERO_SENTRY_DSN: "" }).result).toBe("dropped");
    expect(await run("ask", { ZERO_SENTRY_DSN: "http://abc123@localhost/1" }).result).toBe("dropped");
    expect(files()).toEqual([]);
  });

  it("a failing transport never throws", async () => {
    const submit = vi.fn(async () => { throw new Error(`boom ${SECRET}`); });
    expect(await handleDiagnosticReport(info(), { policy: () => "automatic", env: { ZERO_SENTRY_DSN: DSN }, homeDir: home, submit: submit as never })).toBe("failed");
  });
});

describe("report contents", () => {
  it("never contains message text, hostnames, paths or secrets, on disk or on the wire", async () => {
    await run("ask", { ZERO_SENTRY_DSN: DSN }).result;
    const raw = readFileSync(join(pendingDirectory(home), files()[0]!), "utf8");
    const wire = buildDiagnosticFeedback(info());
    for (const text of [raw, JSON.stringify(wire)]) expect(text).not.toMatch(new RegExp(`${SECRET}|${HOST}|alice|acme|scan-output|ECONNREFUSED|/home/ci`));
    const stored = readPendingReport(listPendingReports(home)[0]!.id, home)!;
    expect(stored.payload.diagnostic).toMatchObject({ surface: "cli", command: "scan web", category: "TypeError" });
    expect(stored.payload.diagnostic!.frames).toEqual([{ filename: "app:///packages/cli/dist/index.js", lineno: 10, colno: 20 }]);
  });

  it("rejects free-text commands and categories", () => {
    const payload = buildDiagnosticFeedback(info({ command: `scan ${HOST}`, category: `Error ${SECRET}`, error: undefined }));
    expect(payload.diagnostic!.command).toBeUndefined();
    expect(payload.diagnostic!.category).toBe("unknown");
  });

  it("only accepts closed frame shapes", () => {
    const payload = buildDiagnosticFeedback(info({ surface: "web", error: undefined, category: "Error", frames: [
      { filename: "app:///assets/index-abc.js", lineno: 4, colno: 5 },
      { filename: `app:///${PATH_LEAK}`, lineno: 1, colno: 1 },
      { filename: "https://evil.example/assets/x.js", lineno: 1, colno: 1 },
      { filename: "app:///assets/../../etc/passwd.js", lineno: 1, colno: 1 },
      { filename: "app:///assets/x.js", lineno: -1, colno: 1 },
    ] }));
    expect(payload.diagnostic!.frames).toEqual([{ filename: "app:///assets/index-abc.js", lineno: 4, colno: 5 }]);
  });
});

describe("pending lifecycle", () => {
  const save = (n: number) => savePendingReport(buildDiagnosticFeedback(info()), { homeDir: home, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n)) });

  it("bounds the count and evicts the oldest", () => {
    const first = (() => { save(0); return listPendingReports(home)[0]!.id; })();
    for (let n = 1; n < MAX_PENDING_REPORTS + 3; n++) expect(save(n)).toBe(true);
    const list = listPendingReports(home);
    expect(list).toHaveLength(MAX_PENDING_REPORTS);
    expect(list.map((entry) => entry.id)).not.toContain(first);
    expect(list[0]!.createdAt < list[list.length - 1]!.createdAt).toBe(true);
  });

  it("reads, deletes and discards; malformed ids are inert", () => {
    save(0); save(1);
    const [a, b] = listPendingReports(home);
    expect(readPendingReport(a!.id, home)!.summary).toEqual(a);
    for (const bad of ["../../etc/passwd", "..%2f..", "%zz", "", "A".repeat(32), "a".repeat(31), null, [a!.id], {}]) {
      expect(readPendingReport(bad, home)).toBeNull();
      expect(deletePendingReport(bad, home)).toBe(false);
    }
    expect(deletePendingReport(a!.id, home)).toBe(true);
    expect(deletePendingReport(a!.id, home)).toBe(false);
    expect(discardPendingReports(home)).toBe(1);
    expect(listPendingReports(home)).toEqual([]);
    expect(readPendingReport(b!.id, home)).toBeNull();
  });

  it("ignores oversize, corrupt and mismatched files and re-validates tampered fields", () => {
    save(0);
    const id = listPendingReports(home)[0]!.id;
    const dir = pendingDirectory(home);
    writeFileSync(join(dir, `${"b".repeat(32)}.json`), "x".repeat(20_000));
    writeFileSync(join(dir, `${"c".repeat(32)}.json`), "{not json");
    writeFileSync(join(dir, `${"d".repeat(32)}.json`), JSON.stringify({ version: 1, id: "e".repeat(32), createdAt: new Date().toISOString(), info: {} }));
    const record = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    record.info.category = `leak ${SECRET}`; record.info.command = HOST; record.info.platform = HOST;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(record));
    const list = listPendingReports(home);
    expect(list).toHaveLength(1);
    const body = JSON.stringify(readPendingReport(id, home)!.payload);
    expect(list[0]!.category).toBe("unknown");
    expect(body).not.toMatch(new RegExp(`${SECRET}|${HOST}`));
  });

  it("refuses to persist a report that exceeds the size bound", () => {
    const payload = buildDiagnosticFeedback(info());
    payload.diagnostic!.frames = Array.from({ length: 32 }, () => ({ filename: `app:///packages/cli/dist/${"a".repeat(180)}.js`, lineno: 1, colno: 1 }));
    expect(savePendingReport(payload, { homeDir: home })).toBe(false);
    expect(files()).toEqual([]);
  });
});
