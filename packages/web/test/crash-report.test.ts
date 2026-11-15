import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCrashReporter, crashCategory, crashReportBody, installWindowCrashListeners, scrubFrames } from "../src/lib/crash-report.js";
import { AppErrorBoundary, CrashFallback } from "../src/components/app-error-boundary.js";

const stack = (message: string) => `TypeError: ${message}
    at render (https://localhost:4173/assets/index-Ab12_c.js?v=secret-token:10:20)
    at Object.x (http://127.0.0.1:9/assets/vendor.js:3:4)
    at file (/Users/alice/clients/acme/src/app.tsx:1:1)
    at me (assets/chunk-1.js:7:8)`;
const failure = (message = "Cannot read secret-host.example") => { const error = new TypeError(message); error.stack = stack(message); return error; };

describe("scrubbing", () => {
  test("keeps only built asset locations: no origins, queries or absolute paths", () => {
    expect(scrubFrames(stack("m"))).toEqual(["assets/index-Ab12_c.js:10:20", "assets/vendor.js:3:4", "assets/chunk-1.js:7:8"]);
  });
  test("body has a closed category, scrubbed frames and no message text", () => {
    const body = crashReportBody(failure("password=hunter2 on db.corp.example"));
    expect(body).toEqual({ name: "TypeError", frames: ["assets/index-Ab12_c.js:10:20", "assets/vendor.js:3:4", "assets/chunk-1.js:7:8"], surface: "web" });
    expect(JSON.stringify(body)).not.toMatch(/hunter2|corp\.example|alice|secret-token|localhost/);
  });
  test("categories derive only from the error class name", () => {
    class Custom extends Error { override name = "Acme-Internal-ClientError"; }
    expect(crashCategory(new RangeError("x"))).toBe("RangeError");
    expect(crashCategory(new Custom("x"))).toBe("Error");
    expect(crashCategory("a string with host.example")).toBe("unknown");
    expect(crashCategory(null)).toBe("unknown");
  });
  test("frame list is bounded", () => {
    const long = Array.from({ length: 100 }, (_, n) => `at f (assets/a.js:${n + 1}:1)`).join("\n");
    expect(scrubFrames(`E\n${long}`)).toHaveLength(16);
  });
});

describe("burst de-duplication", () => {
  test("one report per category+top frame per minute, max five per session", () => {
    let clock = 0;
    const post = vi.fn(async () => ({}));
    const report = createCrashReporter({ post, now: () => clock });
    for (let n = 0; n < 10; n++) report(failure());
    expect(post).toHaveBeenCalledTimes(1);
    clock = 61_000;
    report(failure());
    expect(post).toHaveBeenCalledTimes(2);
    for (const name of [RangeError, SyntaxError, ReferenceError, URIError, EvalError]) { const e = new name("x"); e.stack = `x\nat f (assets/${name.name}.js:1:1)`; report(e); }
    expect(post).toHaveBeenCalledTimes(5);
  });
  test("a failing transport never throws", () => {
    const report = createCrashReporter({ post: () => { throw new Error("offline"); } });
    expect(() => report(failure())).not.toThrow();
    const rejecting = createCrashReporter({ post: () => Promise.reject(new Error("offline")) });
    expect(() => rejecting(failure())).not.toThrow();
  });
  test("window error and unhandledrejection listeners feed the same reporter", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const target = { addEventListener: (t: string, l: (e: unknown) => void) => listeners.set(t, l), removeEventListener: (t: string) => listeners.delete(t) };
    const post = vi.fn(async () => ({}));
    const off = installWindowCrashListeners(target, createCrashReporter({ post }));
    listeners.get("error")!({ error: failure() });
    listeners.get("unhandledrejection")!({ reason: failure() });
    listeners.get("unhandledrejection")!({ reason: "plain" });
    expect(post).toHaveBeenCalledTimes(2);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe("error boundary", () => {
  test("fallback shows a Reload button and a generic sentence only", () => {
    const html = renderToStaticMarkup(createElement(CrashFallback, { onReload: () => {} }));
    expect(html).toContain("Reload");
    expect(html).toContain("Something went wrong");
  });
  test("a failure reports once and renders the fallback without the message", () => {
    const onError = vi.fn();
    const error = failure("db password=hunter2 at client.corp.example");
    const boundary = new AppErrorBoundary({ onError, children: createElement("p", null, "app") });
    expect(renderToStaticMarkup(boundary.render() as never)).toContain("app");
    boundary.state = AppErrorBoundary.getDerivedStateFromError();
    boundary.componentDidCatch(error, { componentStack: "" });
    expect(onError).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain("Reload");
    expect(html).not.toMatch(/hunter2|corp\.example|Cannot read|alice/);
  });
  test("a throwing reporter cannot break the fallback", () => {
    const boundary = new AppErrorBoundary({ onError: () => { throw new Error("x"); }, children: null });
    expect(() => boundary.componentDidCatch(new Error("y"), { componentStack: "" })).not.toThrow();
  });
});
