import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("application notices map onto toasts and request cancellations are recognised", async () => {
  const dashboard = resolve(root, "packages/web");
  const directory = await mkdtemp(resolve(dashboard, ".app-notice-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `import {isRequestCancellation} from './src/lib/request-cancellation';import {CancelledError} from '@tanstack/react-query';export const cancellationChecks=()=>[isRequestCancellation(new CancelledError()),isRequestCancellation(new DOMException('Navigation aborted','AbortError')),isRequestCancellation(new Error('Connection failed')),isRequestCancellation(new Error('Request cancelled by server policy'))];import {noticeToToast} from './src/components/app-notice';export const toToast=noticeToToast;`, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { toToast, cancellationChecks } = await import(pathToFileURL(output).href);
    assert.deepEqual(cancellationChecks(), [true, true, false, false]);
    const error = toToast({ id: "session-error", message: "Session <missing>", onDismiss() {}, action: { label: "Manage connection", href: "/connections" } });
    assert.equal(error.id, "notice:session-error");
    assert.equal(error.kind, "error");
    assert.equal(error.title, "Session <missing>");
    assert.deepEqual(error.action, { label: "Manage connection", href: "/connections" });
    assert.equal(typeof error.onDismiss, "function");
    const status = toToast({ id: "resume", kind: "status", message: "Conversation resumed" });
    assert.equal(status.kind, "info");
    assert.equal("onDismiss" in status, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
