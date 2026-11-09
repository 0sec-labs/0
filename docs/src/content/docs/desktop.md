---
title: Browser console
description: Work with the local security console in your browser.
---

The browser console replaces the Electron app and interactive terminal UI.
Run `0 web` to open it. See [Console](/console/) for setup, saved conversations,
model connections and agent controls.

## Live development

From a source checkout with dependencies installed, run:

```bash
npm run dev
```

This builds the engine and UI, then starts Vite and backend build watchers.
Open [the browser console](http://127.0.0.1:48123/console). Frontend edits reload;
backend rebuilds restart the engine automatically. Stop development with Ctrl+C.
