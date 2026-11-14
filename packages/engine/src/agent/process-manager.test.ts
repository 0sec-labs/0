import { describe, expect, it, vi } from "vitest";

import { RingLog, matchReady, ProcessManager } from "./process-manager.js";

describe("RingLog", () => {
  it("advances filtered polling over inspected rows even when nothing matches", () => {
    const log = new RingLog();
    log.append("booting\nstill booting\n");
    const first = log.read(0, { grep: /ready/ });
    expect(first).toEqual({ lines: [], cursor: 2 });
    log.append("ready\nbackground noise\n");
    const next = log.read(first.cursor, { grep: /ready/ });
    expect(next.lines.map(line => line.text)).toEqual(["ready"]);
    expect(next.cursor).toBe(4);
    expect(log.read(next.cursor, { grep: /ready/ })).toEqual({ lines: [], cursor: 4 });
  });

  it("does not skip unread matches when filtered polling is paginated", () => {
    const log = new RingLog();
    log.append("hit 1\nnoise\nhit 2\nnoise\nhit 3\nnoise\n");
    const first = log.read(0, { grep: /hit/, limit: 2 });
    expect(first.lines.map(line => line.text)).toEqual(["hit 1", "hit 2"]);
    expect(first.cursor).toBe(3);
    const second = log.read(first.cursor, { grep: /hit/, limit: 2 });
    expect(second.lines.map(line => line.text)).toEqual(["hit 3"]);
    expect(second.cursor).toBe(6);
  });

  it("retains a deliverable page when a positive fractional limit is rounded down", () => {
    const log = new RingLog();
    log.append("one\ntwo\n");
    const first = log.read(0, { limit: 0.5 });
    expect(first.lines.map(line => line.text)).toEqual(["one"]);
    expect(log.read(first.cursor).lines.map(line => line.text)).toEqual(["two"]);
  });

  it("appends, splits on newlines, and reads from a cursor", () => {
    const log = new RingLog();
    log.append("line one\nline two\n");
    log.append("line three");
    const all = log.read(0);
    expect(all.lines.map((l) => l.text)).toEqual(["line one", "line two", "line three"]);
    // Resume after the returned cursor → nothing new.
    expect(log.read(all.cursor).lines).toHaveLength(0);
  });

  it("returns only lines after the cursor (incremental follow)", () => {
    const log = new RingLog();
    log.append("a\nb\n");
    const first = log.read(0);
    log.append("c\n");
    const next = log.read(first.cursor);
    expect(next.lines.map((l) => l.text)).toEqual(["c"]);
  });

  it("filters by grep and caps at limit", () => {
    const log = new RingLog();
    log.append("error: boom\ninfo: ok\nerror: again\n");
    const errs = log.read(0, { grep: /^error:/ });
    expect(errs.lines.map((l) => l.text)).toEqual(["error: boom", "error: again"]);
    expect(log.read(0, { limit: 1 }).lines).toHaveLength(1);
  });

  it("evicts oldest lines past maxLines but keeps cursors monotonic", () => {
    const log = new RingLog(3);
    for (const c of ["1", "2", "3", "4", "5"]) log.append(c);
    const out = log.read(0);
    // Only the last 3 retained.
    expect(out.lines.map((l) => l.text)).toEqual(["3", "4", "5"]);
    // Cursor space still reflects all 5 appended.
    expect(log.head).toBe(5);
  });

  it("preserves interior and consecutive blank lines across LF and CRLF chunks", () => {
    const log = new RingLog();
    log.append("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello World\r\n");
    expect(log.read(0).lines.map((l) => l.text)).toEqual([
      "HTTP/1.1 200 OK",
      "Content-Type: text/plain",
      "",
      "Hello World",
    ]);

    const multiBlank = new RingLog();
    multiBlank.append("alpha\n\n\nbeta\n");
    expect(multiBlank.read(0).lines.map((l) => l.text)).toEqual(["alpha", "", "", "beta"]);
  });

  it("drops only the trailing newline delimiter and preserves chunk content without trailing newline", () => {
    const withTrailing = new RingLog();
    withTrailing.append("one\ntwo\n");
    expect(withTrailing.read(0).lines.map((l) => l.text)).toEqual(["one", "two"]);

    const withoutTrailing = new RingLog();
    withoutTrailing.append("one\ntwo");
    expect(withoutTrailing.read(0).lines.map((l) => l.text)).toEqual(["one", "two"]);
  });

  it("handles empty chunks and newline-only chunks according to line semantics", () => {
    const emptyLog = new RingLog();
    emptyLog.append("");
    expect(emptyLog.read(0).lines).toHaveLength(0);
    expect(emptyLog.head).toBe(0);

    const lfLog = new RingLog();
    lfLog.append("\n");
    expect(lfLog.read(0).lines.map((l) => l.text)).toEqual([""]);
    expect(lfLog.head).toBe(1);

    const crlfLog = new RingLog();
    crlfLog.append("\r\n");
    expect(crlfLog.read(0).lines.map((l) => l.text)).toEqual([""]);
    expect(crlfLog.head).toBe(1);

    const multiLfLog = new RingLog();
    multiLfLog.append("\n\n");
    expect(multiLfLog.read(0).lines.map((l) => l.text)).toEqual(["", ""]);
    expect(multiLfLog.head).toBe(2);
  });

  it("preserves sequential appends containing blank lines and maintains cursor continuity", () => {
    const log = new RingLog();
    log.append("first\n");
    log.append("\n");
    log.append("second\n");

    const all = log.read(0);
    expect(all.lines.map((l) => l.text)).toEqual(["first", "", "second"]);
    expect(all.lines.map((l) => l.cursor)).toEqual([1, 2, 3]);
    expect(all.cursor).toBe(3);
    expect(log.head).toBe(3);

    // Reading after cursor 1 resumes at the blank line
    const fromFirst = log.read(1);
    expect(fromFirst.lines.map((l) => l.text)).toEqual(["", "second"]);
    expect(fromFirst.lines.map((l) => l.cursor)).toEqual([2, 3]);

    // Reading after cursor 2 resumes at the line following the blank line
    const fromBlank = log.read(2);
    expect(fromBlank.lines.map((l) => l.text)).toEqual(["second"]);
    expect(fromBlank.lines.map((l) => l.cursor)).toEqual([3]);

    // Reading after cursor 3 returns nothing new
    expect(log.read(3).lines).toHaveLength(0);
  });

  it("preserves a blank line immediately preceding the terminal newline", () => {
    const log = new RingLog();
    log.append("alpha\n\n");
    const read = log.read(0);
    expect(read.lines.map((l) => l.text)).toEqual(["alpha", ""]);
    expect(read.lines.map((l) => l.cursor)).toEqual([1, 2]);
    expect(read.cursor).toBe(2);
    expect(log.head).toBe(2);
  });
});

describe("matchReady", () => {
  it("returns the preserved blank line verbatim when it satisfies the ready gate", () => {
    const log = new RingLog();
    log.append("HTTP/1.1 200 OK\r\n\r\nbody\r\n");
    expect(matchReady({ log: /^$/ }, log.read(0).lines.map(line => line.text), undefined))
      .toEqual({ ready: true, reason: "log", matchedLine: "" });
  });

  it("is ready immediately when no gate is set", () => {
    expect(matchReady({}, [], undefined).ready).toBe(true);
  });

  it("matches a log regex and returns the matched line", () => {
    const r = matchReady({ log: /Listening on/ }, ["boot...", "Listening on :8080"], undefined);
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("log");
    expect(r.matchedLine).toBe("Listening on :8080");
  });

  it("waits for a port when only a port gate is set", () => {
    expect(matchReady({ port: 8080 }, [], false).ready).toBe(false);
    expect(matchReady({ port: 8080 }, [], true).ready).toBe(true);
  });

  it("requires BOTH when log and port are given (AND semantics)", () => {
    expect(matchReady({ log: /ready/, port: 80 }, ["ready"], false).ready).toBe(false);
    expect(matchReady({ log: /ready/, port: 80 }, ["nope"], true).ready).toBe(false);
    const both = matchReady({ log: /ready/, port: 80 }, ["ready"], true);
    expect(both.ready).toBe(true);
    expect(both.reason).toBe("both");
  });
});

describe("ProcessManager", () => {
  it.each([undefined, { MONITOR_LABEL: "explicit-safe-value", POC_API_KEY: "synthetic-override" }])("isolates child environments with overrides %j", async (env) => {
    vi.stubEnv("POC_ANTHROPIC_API_KEY", "synthetic-provider");
    vi.stubEnv("POC_ZERO_CLOUD_TOKEN", "synthetic-cloud");
    vi.stubEnv("POC_AWS_SECRET_ACCESS_KEY", "synthetic-aws");
    vi.stubEnv("POC_UNLISTED_VALUE", "synthetic-unlisted");
    const pm = new ProcessManager();
    try {
      const proc = pm.start({
        name: "environment-probe",
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({
          inherited: ["POC_ANTHROPIC_API_KEY", "POC_ZERO_CLOUD_TOKEN", "POC_AWS_SECRET_ACCESS_KEY", "POC_UNLISTED_VALUE", "POC_API_KEY"].filter(key => process.env[key] !== undefined),
          pathPresent: typeof process.env.PATH === "string",
          label: process.env.MONITOR_LABEL ?? null
        }))`],
        env,
      });
      await vi.waitFor(() => expect(proc.status).toBe("exited"));
      const captured = JSON.parse(proc.log.read(0).lines.map(line => line.text).join("\n"));
      expect(captured).toEqual({ inherited: [], pathPresent: true, label: env?.MONITOR_LABEL ?? null });
    } finally {
      pm.killAll();
      vi.unstubAllEnvs();
    }
  });

  it("starts, captures output, lists with pid+status, and stops", async () => {
    const pm = new ProcessManager();
    const proc = pm.start({
      name: "echoer",
      command: process.execPath, // node
      args: ["-e", "console.log('hello from child'); setInterval(()=>{}, 1000)"],
    });
    expect(proc.status).toBe("running");
    expect(typeof proc.pid).toBe("number");
    expect(pm.isRunning("echoer")).toBe(true);
    expect(pm.list().map((p) => p.name)).toContain("echoer");

    // Give the child a moment to emit stdout.
    await new Promise((r) => setTimeout(r, 300));
    const out = proc.log.read(0);
    expect(out.lines.some((l) => l.text.includes("hello from child"))).toBe(true);

    expect(pm.stop("echoer", "KILL")).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(pm.isRunning("echoer")).toBe(false);
  });

  it("refuses a duplicate running name and keeps a dead process listed", async () => {
    const pm = new ProcessManager();
    pm.start({ name: "quick", command: process.execPath, args: ["-e", "process.exit(0)"] });
    await new Promise((r) => setTimeout(r, 200));
    // Exited process stays listed for post-mortem.
    expect(pm.get("quick")?.status).toBe("exited");
    // Reusing the name is allowed once it's not running.
    expect(() => pm.start({ name: "quick", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] })).not.toThrow();
    expect(pm.isRunning("quick")).toBe(true);
    pm.killAll();
  });

  it("delivers text to child stdin via send() and reports received data", async () => {
    const pm = new ProcessManager();
    try {
      const proc = pm.start({
        name: "echo-listener",
        command: process.execPath,
        args: [
          "-e",
          "console.log('READY'); process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { console.log('RECV:' + chunk.trim()); }); setInterval(() => {}, 1000);",
        ],
      });
      expect(proc.status).toBe("running");

      // Synchronize deterministically on child readiness before sending input
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for child READY")), 3000);
        const check = () => {
          if (proc.log.read(0).lines.some((l) => l.text === "READY")) {
            clearTimeout(timer);
            proc.child.stdout?.off("data", check);
            resolve();
          }
        };
        proc.child.stdout?.on("data", check);
        check();
      });

      const sent = pm.send("echo-listener", "hello-stdin\n");
      expect(sent).toBe(true);

      // Synchronize deterministically on child echoing received stdin payload
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for child RECV")), 3000);
        const check = () => {
          if (proc.log.read(0).lines.some((l) => l.text === "RECV:hello-stdin")) {
            clearTimeout(timer);
            proc.child.stdout?.off("data", check);
            resolve();
          }
        };
        proc.child.stdout?.on("data", check);
        check();
      });

      const out = proc.log.read(0);
      expect(out.lines.some((l) => l.text === "RECV:hello-stdin")).toBe(true);
    } finally {
      pm.killAll();
    }
  });

  it("survives a live child closing stdin and records the asynchronous write failure", async () => {
    const pm = new ProcessManager();
    const proc = pm.start({
      name: "closed-stdin",
      command: process.execPath,
      args: ["-e", "require('node:fs').closeSync(0); console.log('READY'); setInterval(() => {}, 1000);"],
    });
    try {
      await vi.waitFor(() => expect(proc.log.read(0).lines.some(line => line.text === "READY")).toBe(true));
      expect(pm.send(proc.name, "hello\n")).toBe(true);
      await vi.waitFor(() => expect(proc.log.read(0).lines.some(line => /\[stdin error\].*EPIPE/.test(line.text))).toBe(true));
      expect(pm.isRunning(proc.name)).toBe(true);
      expect(pm.send(proc.name, "again\n")).toBe(false);
    } finally {
      const stopped = new Promise(resolve => proc.child.once("exit", resolve));
      pm.killAll();
      await stopped;
    }
  });

  it("returns false from send() when process is unknown or stopped", async () => {
    const pm = new ProcessManager();
    expect(pm.send("nonexistent", "hello")).toBe(false);

    const proc = pm.start({
      name: "quick-exit",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await new Promise((resolve) => proc.child.once("exit", resolve));
    expect(pm.send("quick-exit", "hello")).toBe(false);
    pm.killAll();
  });
});
