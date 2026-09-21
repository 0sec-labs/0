---
title: Desktop — development draft
description: Contributor notes for the unreleased 0 Desktop application and its local CLI sidecar.
draft: true
pagefind: false
---

**Desktop remains in development.** These contributor notes cover source builds;
public downloadable and signed releases remain unavailable.

The 0 desktop is an [Electron](https://www.electronjs.org/) application
(v42, Chromium-based) that provides a native windowed control plane for the
0 harness. Its dedicated React renderer lives in
`packages/desktop/src/renderer/`, with its own `desktop.html` build entry.
The application manages a **sidecar**: a compiled 0 CLI process that
handles all engine communication behind a security boundary.

The renderer uses web technology. On macOS, native window controls, menus, a
directory picker, and sidebar material use system fonts and light/dark
appearance. The operations dashboard is a separate view.

## Starting the desktop

### Source development

Use Node.js 24+, the repository's pinned pnpm, and Bun 1.3.14 (matching CI).
From the monorepo root, build the CLI and dashboard before launching:

```bash
pnpm install --frozen-lockfile
pnpm --filter '@0/cli...' build
pnpm --filter @0/dashboard build
pnpm --filter @0/desktop start
```

The same development commands work on macOS Apple Silicon. A compiled
platform-specific sidecar is needed for packaging, **not** for this source
launch: the development app runs the built CLI entry point through Bun.
If Bun is not on `PATH`, set `BUN_PATH` to its executable.
The development sidecar can also run through Node.js 24+:
`BUN_PATH=node pnpm --filter @0/desktop start`. Packaging still requires Bun.

The desktop resolves assets from `packages/dashboard/dist/` (development) or
`process.resourcesPath/dashboard/` (packaged), and the sidecar from
`packages/cli/dist/index.js` run through `bun` (development) or from
`resources/sidecars/0-<platform>-<arch>` (packaged).

### Environment

| Variable | Role |
|----------|------|
| `OSEC_DESKTOP_ROOT` | Monorepo root path for resolving workspace layout in development (the desktop otherwise searches upward from its main module for `pnpm-workspace.yaml`) |
| `OSEC_DESKTOP_DEBUG_PORT` | Bind Chromium DevTools to `127.0.0.1:<port>` for development builds only (integer, 1024–65535). Remote inspection reaches this port through an SSH tunnel only. |
| `BUN_PATH` | Custom `bun` binary path for the development sidecar (default: `"bun"` on `PATH`) |

### Packaging development builds

The build pipeline produces platform-specific artifacts through
[electron-builder](https://www.electron.build/). Packages bundle the Electron
runtime, dashboard UI, and sidecar binary together. The resulting application
is run from the desktop environment or launcher.

## Sidecar security boundary

The desktop separates the renderer (web UI) from engine operations through a
**sidecar**: the 0 CLI binary itself, spawned as a child process.

```
┌─────────────────────────────────────┐
│ Electron main process               │
│  ┌───────────────────────────────┐  │
│  │ BrowserWindow                 │  │
│  │  - sandbox: true              │  │
│  │  - contextIsolation: true     │  │
│  │  - nodeIntegration: false     │  │
│  │  - webviewTag: false          │  │
│  │  - webSecurity: true          │  │
│  └───────────────────────────────┘  │
│                                     │
│  IPC: external HTTPS, directory picker │
│  Menu commands: typed subscriptions   │
│  Permission: scoped clipboard write │
└────────────────────┬──────────────┘
                     │ spawn (stdio: pipe)
┌────────────────────▼──────────────┐
│ Sidecar (0 CLI binary)            │
│  - dashboard --no-open --host     │
│    127.0.0.1 --port 0             │
│  - stdout: ZERO_DASHBOARD_READY   │
│  - lifecycle: SIGTERM → SIGKILL   │
└─────────────────────────────────────┘
```

### Sidecar lifecycle

1. **Launch**: `child_process.spawn` with `shell: false`, `windowsHide: true`.
   The sidecar command and arguments are assembled in
   `createDashboardSidecarInvocation` — the renderer never contributes a
   command, an argument, or a filesystem path to this boundary.
2. **Readiness**: stdout is parsed for a JSON-ready line of the form
   `ZERO_DASHBOARD_READY {"url":"http://127.0.0.1:<port>"}`. If the sidecar
   exits before emitting this line (or after the 20-second timeout), the
   desktop shows an error dialog and exits.
3. **Graceful stop**: SIGTERM is sent first. If the process has not exited
   after 5 seconds, SIGKILL is sent. The same sequence runs on application
   quit (`before-quit`).
4. **Stderr capture**: the last 4 KB of stderr are included in the error
   message if the sidecar fails to start.

In development, the sidecar runs through the local `bun` CLI entrypoint
(`packages/cli/dist/index.js`). In packaged builds, it runs the pre-bundled
binary from `process.resourcesPath/sidecars/0-<platform>-<arch>`
(Windows uses `0-windows-<arch>.exe`).

On macOS, closing the last window leaves the application and sidecar running.
Dock activation or **New Session** recreates the window without starting another
sidecar. Explicit **Quit** stops it, including when startup is still in progress.
On Linux and Windows, closing the last window quits the application.

The desktop's live sessions belong to the running sidecar; quitting ends them.
Tabs, project shortcuts, drafts, titles, and appearance are UI preferences:
Electron persists them in its user-data directory, independently of the
sidecar's changing loopback port. Browser previews use local storage instead.
On a fresh sidecar, stale session tabs are removed; they are not a promise
that the desktop can reopen an ended conversation.

### Navigation policy

| Operation | Rule |
|-----------|------|
| **Window open** (`setWindowOpenHandler`) | External `https://` URLs open in the system browser; all others denied |
| **Navigation** (`will-navigate`) | Only URLs whose origin matches the dashboard's origin |
| **Redirect** (`will-redirect`) | Same-origin only |
| **WebView** (`will-attach-webview`) | Prevented entirely |
| **External URLs** | Only credential-free `https://` URLs accepted; embedded username/password rejected |

All navigation is validated by `hasSameOrigin` (origin-level URL comparison)
and `isExternalHttpsUrl` (protocol + no credentials).

### View zoom

Pinch zoom is fixed with `setVisualZoomLevelLimits(1, 1)`. The native **View**
menu also exposes page zoom and reset commands.

### IPC

The renderer receives a narrow, typed `window.osecDesktop` bridge:

```typescript
interface DesktopHostBridge {
  readonly platform: string;
  openExternal(url: string): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  getPreferences(): Promise<Record<string, unknown>>;
  setPreference(key: string, value: unknown): Promise<void>;
  onCommand(listener: (command: DesktopHostCommand) => void): () => void;
}

type DesktopHostCommand =
  | "new-thread"
  | "open-folder"
  | "toggle-sidebar"
  | "settings";
```

The main process accepts renderer requests only from the current window's main
frame at the trusted dashboard origin. External URLs must be credential-free
HTTPS URLs. The directory picker accepts directories only and returns `null`
on cancellation. Picking a directory sets context; it does not grant access.
Preference writes accept only namespaced `0:` UI values. They do not expose
arbitrary filesystem paths, provider credentials, or engine configuration.

Menu subscriptions return an unsubscribe function. Commands that arrive while
the conversation route is loading are retained until the renderer subscribes.
Raw `ipcRenderer`, filesystem access, and arbitrary process execution are never
exposed by the bridge.

### Permission policy

Clipboard writes are allowed only from the focused main dashboard window at
the trusted local sidecar origin, so the chat's **Copy code** button works.
Clipboard reads, camera, microphone, geolocation, notifications, and all other
Chromium permission requests remain denied.

## Window

| Property | Value |
|----------|-------|
| Default size | 1280 × 860 |
| Minimum size | 900 × 600 |
| Appearance | System light/dark; translucent native macOS sidebar, opaque conversation |
| Title | Product name |
| Show | Hidden until `ready-to-show` to avoid white flash |
| Single-instance lock | Yes — a second launch focuses or recreates the existing application's window |

## Preload

`packages/desktop/src/preload/index.ts` exposes the frozen bridge through
`contextBridge`. It is compiled as **CommonJS** by `tsconfig.preload.json`;
sandboxed Electron preloads cannot use ESM imports. The main process remains
ESM. Shared contracts are type-only imports and add no renderer runtime access.

Context isolation and sandboxing remain enabled. Native accelerators and browser
fallback shortcuts are mutually exclusive, so a keypress does not create two
sessions or toggle the sidebar twice.

| Desktop shortcut | Action |
|------------------|--------|
| Cmd/Ctrl+N | New session form |
| Cmd/Ctrl+O | Native folder picker, then a prefilled session form |
| Cmd/Ctrl+B | Toggle sidebar |
| Cmd/Ctrl+, | Settings and provider connection |
| Cmd/Ctrl+K | Search actions and all live sessions |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous workspace tab |
| Cmd/Ctrl+Shift+H | Home |
| Enter / Shift+Enter | Send / insert newline |
| Escape | Dismiss a dialog when no operation is pending |

## User workflow

1. Launch the desktop application from your OS (or `pnpm --filter @0/desktop start` in development).
2. The window opens a project-and-session workspace. Home lists recent sessions;
   the sidebar filters by project or session title. Closing a tab does not
   delete its live session; reopen it from Home or the command palette.
3. Use **New session** for a URL or path, or **Open Folder** in the native File
   menu. Select the role and autonomy mode before creating the session.
   Selecting a target is not an authorization grant. YOLO requires an explicit
   acknowledgement; an unscoped chat uses standard autonomy.
4. Responses stream progressively into the conversation, with Markdown,
   copyable code blocks, collapsible reasoning, and expandable tool activity.
   **Stop** cancels the active turn. Scrolling back preserves your position;
   **Latest** resumes following. Drafts and renamed titles stay with their session.
5. The inspector shows context, activity, and evidence. Approval cards stay in
   chat. **Settings** controls appearance; **Connection** offers ChatGPT Codex
   subscription sign-in. Configure API-key providers through CLI or environment.
   **Operations** opens the findings-and-runs dashboard.
6. The renderer has no general Node.js or Electron API. Engine work goes through
   the loopback sidecar. External documentation links open in the system browser.

### Local candidate checks

These are retained observations from a local browser candidate, **not**
qualification of the current Electron package or a supported release matrix.

The compiled dashboard browser candidate uses `ConsoleSession.harness` and its
shared catalog for live views, commands, settings, and workspace trust.
Host ESM trust requires separate acknowledgement from self-extension.

An isolated loopback fixture verified persistent chat, Unicode drafts across
Settings, explicit prompt staging, stale frame/nonce/generation/provider
rejection, revocation, and final/delta reply reconciliation. Reload added no model
calls. Empty-HOME startup retained the draft and reported missing credentials.

The browser used a backend built before the later shutdown repairs. Explicitly
delivered disposal callbacks were idempotent; callback delivery during automatic
frame removal remains best effort.

Cloud sign-in, in-renderer API-key entry, and provider/model pickers remain
unimplemented. The current renderer does wire Codex device sign-in through the
local sidecar; that is provider authentication, not a 0cloud login or hosted
execution. Hosted payment/inference, native installation, and release
qualification were not established by these candidate checks.

## Platforms and build requirements

### Configured packaging targets

| Platform | Architectures | Package artifacts |
|----------|---------------|-------------------|
| Linux | x64, arm64 | `.AppImage`, `.deb` |
| macOS (Darwin) | x64, arm64 | `.dmg`, `.zip` |
| Windows | x64, arm64 | NSIS installer, `.zip` |

These are the platforms and filenames accepted by the source packaging code,
not a claim that signed downloadable releases or runtime qualification exist
for every row. Resource preparation selects **the host's** platform and
architecture; `package:mac` or `package:win` alone is not a cross-compilation
pipeline.

### Building a package

Prerequisites: Node.js 24+, pnpm 9.15.9, Bun 1.3.14, and the native packaging
dependencies for the host OS. Run from the repository root on the target
platform/architecture.

```bash
# Build all workspace packages
pnpm install --frozen-lockfile
pnpm build

# Compile the host sidecar (this example must run on Linux x64).
# pnpm build above also builds the dashboard required by this script.
bash scripts/bun-compile.sh "" "dist-bin/0-linux-x64"

# Package the desktop (Linux example)
pnpm --filter @0/desktop package:linux
```

The sidecar binary filename pattern is `0-<platform>-<arch>` (Linux/macOS)
or `0-windows-<arch>.exe` (Windows). The example above is for a Linux x64
host: the empty first argument means **compile for the host**, not "target the
platform named in the output file." On Apple Silicon, use
`dist-bin/0-darwin-arm64` and `package:mac`; on Intel macOS use
`dist-bin/0-darwin-x64`. Windows requires a compatible shell for
`bun-compile.sh` and the matching `0-windows-<arch>.exe` output.

Although the Bun compiler accepts an explicit cross-target, desktop resource
preparation currently copies only the host-matching sidecar. Build/package on
the matching OS and architecture rather than relabeling a binary. Packages are
written under `packages/desktop/release/` with publication disabled.

The `package:*` scripts (`package:linux`, `package:mac`, `package:win`) run
`prepare-desktop-resources.mjs` before invoking electron-builder:

1. Validates that the built dashboard's `index.html` and the host-matching
   `dist-bin/0-*` sidecar exist.
2. Removes the desktop package's existing `resources/` directory.
3. Copies `packages/dashboard/dist` to `resources/dashboard` and the compiled
   sidecar to `resources/sidecars/`, marking it executable.
4. electron-builder bundles both as `extraResources` into the release package.

The resulting package contains the Electron runtime + app code (in ASAR
archive), the dashboard web UI, and the sidecar binary.

### Package metadata

- **Linux**: app ID `com.0security.osec`, category `Development`,
  `syncDesktopName: true`
- **macOS**: category `public.app-category.developer-tools`. Code signing and
  notarisation require an Apple Developer account and are not configured in the
  open-source build.
- **Windows**: both NSIS installer and `.zip` archive produced by default.

## Sidecar asset paths by build mode

| Build mode | Dashboard assets | Sidecar binary |
|------------|------------------|----------------|
| Development | `packages/dashboard/dist/` | Bun entrypoint at `packages/cli/dist/index.js` (run through `bun`) |
| Packaged (`app.isPackaged === true`) | `process.resourcesPath/dashboard/` | `process.resourcesPath/sidecars/0-<platform>-<arch>` (`0-windows-<arch>.exe` on Windows) |

Both are validated at launch — the application exits with an error dialog if
either is missing.

## Debugging

In development, set `OSEC_DESKTOP_DEBUG_PORT` to attach a Chromium DevTools
inspector bound to `127.0.0.1`:

```bash
OSEC_DESKTOP_DEBUG_PORT=9222 pnpm --filter @0/desktop start
```

Remote inspection must traverse an SSH tunnel — the debugger is never bound to
a routable address. In packaged builds (`app.isPackaged === true`), the debug
port is ignored.

## Related

- [Console](/console/) — terminal-based interactive chat
- [Commands reference](/commands/) — all CLI flags across every command
- [Configuration](/configuration/) — runtime, mode, and feature settings
- [Getting Started](/getting-started/) — install and first scan