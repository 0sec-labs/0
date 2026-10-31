import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(new URL("../packages/dashboard/package.json", import.meta.url));
const { QueryClient, isCancelledError } = require("@tanstack/react-query");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("chat snapshots render warm, resume event cursors, resync mutations and isolate host/accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "0-console-snapshots-"));
  const cache = new QueryClient();
  const slots = []; let cursor = 0; let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useMemo = (fn, deps) => {
    const [memo, set] = useState(() => ({ deps, value: fn() }));
    if (same(memo.deps, deps)) return memo.value;
    const next = { deps, value: fn() }; set(next); return next.value;
  };
  const useEffect = (effect, deps) => {
    const [entry] = useState(() => ({ deps: undefined, cleanup: undefined }));
    if (!same(entry.deps, deps)) effects.push(() => { entry.cleanup?.(); entry.deps = deps; entry.cleanup = effect(); });
  };
  const commit = () => { const pending = effects; effects = []; for (const effect of pending) effect(); };
  const snapshot = (id, at = 1) => ({ session: { id, status: "ready" }, cursor: at, events: [], messages: [], workers: [], queuedMessages: [], pendingDecisions: [], lastOutcome: null });
  const reads = []; const events = [];
  const team = { enabled: true, user: { workspaceId: "workspace", userId: "alice", role: "owner" } };
  const api = {
    client: { backendId: "local" },
    getConsoleSnapshot: async id => { reads.push([api.client.backendId, team.user.userId, id]); return snapshot(id, 99); },
    getConsoleEvents: async (id, after) => { events.push([id, after]); return { events: [], cursor: after }; },
    listConsoleSessions: async () => [], listSavedConsoleSessions: async () => [],
  };
  globalThis.__snapshotCacheTest = { useState, useRef, useMemo, useEffect, cache, team, api, isCancelledError };
  let originalNow = Date.now;
  try {
    const output = join(directory, "hook.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../packages/dashboard/src/console/use-console-workspace.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [{ name: "snapshot-hook-boundaries", setup(build) {
      const sources = {
        react: 'const h=globalThis.__snapshotCacheTest; export const {useState,useRef,useMemo,useEffect}=h;',
        "@tanstack/react-query": 'const h=globalThis.__snapshotCacheTest; export const isCancelledError=h.isCancelledError; export const useQueryClient=()=>h.cache; export const useQuery=o=>({isSuccess:true,isFetching:false,data:o.queryKey[0]==="console-snapshot"?h.cache.getQueryData(o.queryKey):[]});',
        "@/api": 'export const useBackendApi=()=>globalThis.__snapshotCacheTest.api; export const localControlFetch=(...args)=>{const fn=globalThis.__snapshotCacheTest.api.localControlFetch; if(!fn)throw new Error("Unexpected relay request"); return fn(...args);};',
        "@/components/team-access": 'export const useTeamAccess=()=>globalThis.__snapshotCacheTest.team;',
        "@/lib/use-persistent-state": 'import {useState} from "react"; export const usePersistentState=(_key,value)=>useState(value);',
      };
      build.onResolve({ filter: /^(react|@tanstack\/react-query|@\/api|@\/components\/team-access|@\/lib\/use-persistent-state)$/ }, args => ({ path: args.path, namespace: "test-boundary" }));
      build.onLoad({ filter: /.*/, namespace: "test-boundary" }, args => ({ contents: sources[args.path], loader: "js" }));
    } }] });
    const { useConsoleWorkspace, consoleSnapshotKey } = await import(pathToFileURL(output).href);
    const key = (id, host = "local", user = "alice") => consoleSnapshotKey(host, id, "workspace", user);
    const render = id => { cursor = 0; effects = []; return useConsoleWorkspace(id, null); };
    cache.setQueryData(key("first"), snapshot("first", 7));
    cache.setQueryData(key("second"), snapshot("second", 13));
    let workspace = render("first");
    assert.equal(workspace.snapshot.cursor, 7, "cached content is available before effects or network");
    assert.equal(workspace.loading, false);
    commit(); await tick();
    assert.deepEqual(events[0], ["first", 7], "warm polling resumes the cached cursor");
    assert.equal(reads.length, 0, "warm open does not download the transcript again");
    workspace = render("second");
    assert.equal(workspace.snapshot.cursor, 13, "switching views synchronously uses the target's snapshot");
    commit(); await tick();
    assert.deepEqual(events.at(-1), ["second", 13]);
    let now = originalNow(); Date.now = () => now;
    now += 2000;
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(reads.length, 0, "the old 1.8-second full transcript polling is gone");
    now += 16_000;
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(reads.length, 1, "periodic full resync still runs despite fresh event cache writes");
    workspace = render("second"); workspace.refresh();
    render("second"); commit(); await tick(); await tick();
    assert.equal(reads.length, 2, "explicit mutations force authoritative refresh immediately");
    team.user = { ...team.user, userId: "bob" };
    workspace = render("second");
    assert.equal(workspace.snapshot, null, "same session ID never exposes another account's cached content");
    assert.equal(workspace.loading, true); commit(); await tick();
    api.client.backendId = "remote";
    workspace = render("second");
    assert.equal(workspace.snapshot, null, "same session ID never exposes another host's cached content");
    commit(); await tick();
    assert.notDeepEqual(key("second"), key("second", "remote"));
    assert.notDeepEqual(key("second"), key("second", "local", "bob"));
    team.user = { ...team.user, userId: "alice" }; api.client.backendId = "local";
    let completePrefetch; let coldReads = 0;
    api.getConsoleSnapshot = async id => { coldReads++; return new Promise(resolve => { completePrefetch = () => resolve(snapshot(id, 23)); }); };
    const prefetch = cache.fetchQuery({ queryKey: key("third"), queryFn: () => api.getConsoleSnapshot("third"), staleTime: 1000 });
    workspace = render("third"); commit(); await tick();
    assert.equal(coldReads, 1, "opening while history prefetch is pending joins the same request");
    completePrefetch(); await prefetch; await tick();
    workspace = render("third");
    assert.equal(workspace.snapshot.cursor, 23);
    assert.equal(workspace.loading, false);
    api.client.backendId = "remote";
    const relayError = "ChatGPT (Codex backend) transport failure [unknown]: Provider relay grant expired. Reconnect the local model source.";
    const relaySnapshot = { ...snapshot("relay-chat", 10), runtime: { modelSource:"local", providerId:"chatgpt-codex", model:"test-model", agentModels:{}, singleModel:false, autoRoute:false }, events:[{type:"error",sequence:10,message:relayError}] };
    cache.setQueryData(key("relay-chat", "remote"), relaySnapshot);
    workspace = render("relay-chat");
    assert.equal(workspace.connectionRecovery, undefined, "relay lease failures never start account sign-in recovery");
    assert.equal(workspace.modelSourceRecovery.healthy, false);
    await workspace.perform(async () => { throw new Error(relayError); });
    workspace = render("relay-chat");
    const reconnects = [];
    api.localControlFetch = async (path, request) => { reconnects.push({path,body:JSON.parse(request.body)}); return Response.json({session:{...relaySnapshot.session,runtime:relaySnapshot.runtime}}); };
    assert.equal(await workspace.reconnectModelSource(), true);
    workspace = render("relay-chat");
    assert.equal(workspace.modelSourceRecovery.healthy, true, "clearing action error does not revive recovered transcript warning");
    assert.equal(reconnects[0].path, "/api/console/remote-sessions/relay-chat/configuration");
    assert.equal(reconnects[0].body.backendId, "remote");
    assert.equal(reconnects[0].body.runtime.model, "test-model", "reconnect preserves selected model");
    cache.setQueryData(key("relay-chat", "remote"), {...relaySnapshot,events:[{type:"error",sequence:11,message:relayError}],cursor:11});
    workspace = render("relay-chat");
    assert.equal(workspace.modelSourceRecovery.healthy, false, "a later failure remains visible after a successful reconnect");
  } finally {
    for (const slot of slots) if (slot && typeof slot.cleanup === "function") slot.cleanup();
    cache.clear(); Date.now = originalNow; delete globalThis.__snapshotCacheTest;
    await rm(directory, { recursive: true, force: true });
  }
});
