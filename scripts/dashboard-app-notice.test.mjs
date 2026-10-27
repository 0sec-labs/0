import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
test("shared application notices preserve errors with opaque surfaces and accessible recovery actions", async () => {
  const dashboard = resolve(root, "packages/dashboard");
  const directory = await mkdtemp(resolve(dashboard, ".app-notice-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `import {isRequestCancellation} from './src/lib/request-cancellation';import {CancelledError} from '@tanstack/react-query';export const cancellationChecks=()=>[isRequestCancellation(new CancelledError()),isRequestCancellation(new DOMException('Navigation aborted','AbortError')),isRequestCancellation(new Error('Connection failed')),isRequestCancellation(new Error('Request cancelled by server policy'))];import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';import {AppNoticeBanner} from './src/components/app-notice';export const render=notice=>renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(AppNoticeBanner,{notice})));`, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", alias: { "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const { render, cancellationChecks } = await import(pathToFileURL(output).href);
    assert.deepEqual(cancellationChecks(), [true, true, false, false]);
    const error = render({ id: "session-error", message: "Session <missing>", onDismiss() {}, action: { label: "Manage connection", href: "/connections" } });
    assert.match(error, /role="alert"/);
    assert.match(error, /aria-atomic="true"/);
    assert.match(error, /Session &lt;missing&gt;/);
    assert.match(error, /bg-card/);
    assert.doesNotMatch(error, /bg-destructive\//);
    assert.match(error, /href="\/connections"/);
    assert.match(error, /aria-label="Dismiss notification"/);
    const status = render({ id: "resume", kind: "status", message: "Conversation resumed" });
    assert.match(status, /role="status"/);
    assert.doesNotMatch(status, /role="alert"|Dismiss notification/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
