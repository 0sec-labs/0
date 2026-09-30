---
title: Browser console
description: Work with the local security console in your browser.
---

The browser console replaces the Electron desktop app. It shares the terminal console’s local engine, private settings, saved conversations, scope controls, and approval decisions.

## Live development

From a source checkout with dependencies installed, run:

```bash
npm run dev
```

This builds the local engine, starts Vite, and opens [the browser console](http://127.0.0.1:48123/console). Frontend edits reload immediately. Restart the development command after backend changes so the engine is rebuilt. Stop it with Ctrl+C.

## Browser setup

Choose **Start guided setup** to connect a provider, select a model, set project boundaries, choose presentation settings, and review optional sharing preferences. Provider credentials remain on the local server. Existing saved choices are retained when you skip a step.

Create a conversation or resume saved work from the conversation list. Use the workspace controls for provider connections, models, settings, plugins, diagnostics, project checks, and bounded workflow plans. The conversation view retains tool results, usage, approvals, worker activity, and canonical exports.

## Local server

A built CLI also serves the browser workspace:

```bash
0 web
```

The server binds loopback only and authenticates API requests using a per-process token delivered with the page. Keep the server running while using the browser. Closing a tab does not stop active sessions. Use the visible cancel controls to stop work.

The terminal console remains available as an optional interface. No Electron application is required.
