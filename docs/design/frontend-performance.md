# Frontend performance

Perceived speed of the web console. Numbers come from `scripts/frontend-perf.mjs`: headless Chromium 1440x900,
CDP `Performance.getMetrics`, a production build (`pnpm --filter @0/web build`) served by the built CLI, three runs each.
The thread page is a mocked 300-message transcript and the findings page a mocked 500-finding dashboard, so no data is
seeded. Run: `PLAYWRIGHT_CORE=<path to playwright-core> node scripts/frontend-perf.mjs <console url> home|thread|findings`.

## Before and after (median of three)

| Metric | Page | Before | After |
| --- | --- | --- | --- |
| First contentful paint | / | 168 ms | 160 ms |
| First contentful paint | thread | 120 ms | 116 ms |
| First contentful paint | findings | 176 ms | 168 ms |
| JS transferred (encoded) | / | 637 KB | 638 KB |
| Font files in the build | all | 13 files, 289 KB | 4 files, 171 KB |
| DOM nodes | / / thread / findings | 348 / 6744 / 532 | 349 / 6745 / 533 |
| Idle CPU, 10 s (task) | / | 3.99 % | 3.48 % |
| Idle CPU, 10 s (task) | thread | 0.29 % | 0.18 % |
| JS heap | / / thread | 20 / 52 MB | 20 / 52 MB |
| Layout plus style time at load | thread | 71 ms | 70 ms |

Differences under about 10 percent are noise on this machine; idle CPU on `/` is the animated Dither backdrop, which
belongs to the backdrop work. Nothing in this change was expected to move raw load time: the gains are perceived
(prefetch, no flicker, no font swap), and the table is here to show nothing regressed.

## What changed

- Intent prefetch (`lib/intent-prefetch.ts`, `useRoutePrefetch`): a link or a finding row held under the pointer or focused
  for 50 ms loads its route chunk, and `OperationsApp` prefetches the dashboard for the Findings link and the finding
  detail for a row. The sidebar's thread-row prefetch (`host-sidebar-chat-history.tsx`) is unchanged.
- Pending rule (`lib/pending-gate.ts`): nothing for 250 ms (`SkeletonPanel` fade delay, Suspense `DelayedFallback`), and a
  skeleton that has appeared stays at least 500 ms. `usePendingGate(query.isPending)` is applied to Memory, Agents,
  Computers, the Findings landing, and the skill catalog pages.
- Fonts (`fonts.css`): Latin and Latin Extended subsets of Inter and Geist Mono, `font-display: swap`, Inter Latin
  preloaded from `index.html`. Other scripts fall back to the system font.
- Optimistic rename (`lib/optimistic-title.ts`, `useConsoleWorkspace().rename`): the title and the shared list update at once
  and roll back if saving fails. Finding status and triage were already optimistic.

## Checked and left as it was

- Pre-paint script: theme, colour theme, accent, motion and sidebar width/open state are already applied in `index.html`.
- Hashed `/assets/` are served `public, max-age=31536000, immutable`; `index.html` is `no-store`; br and gzip are
  already negotiated (`packages/cli/src/web/dashboard-http.ts`). Preconnect and dns-prefetch do not apply: one origin.
- Entry graph: the modulepreloads are the runtime, react, query, icons, base-ui and shared chunks (about 1 MB raw);
  cytoscape, katex, dockview and mermaid are only reached by dynamic import.
- Findings list is already windowed by hand (500 findings render 532 DOM nodes), so virtua is not needed.

## Tried and not kept

- React Compiler (`babel-plugin-react-compiler`, builds and renders): the entry chunk grew from 325 KB to 383 KB raw
  (108 to 132 KB gzip) and idle script time on `/` did not move (2.3 % either way), because that idle time is the
  backdrop animation, not React renders. Revisit once the backdrop is out of the measurement.
- `content-visibility: auto` on transcript turns: DOM nodes are unchanged and layout plus style time at load stayed
  71 ms on a 300-message thread, so it was dropped. The transcript is already windowed to 60 messages by the server.

## Follow-ups

- Service worker for offline shell and asset caching.
- One multiplexed realtime socket with scoped subscriptions instead of per-view event streams.
- Archive and pin optimistic updates live in the sidebar list files, which another change owns.
