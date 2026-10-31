import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

test("persistent state shares live scoped updates, isolates identities, and survives storage failure", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "0-persistent-state-"));
  const previousWindow = globalThis.window;
  const storage = new Map(); const events = new Set(); const unsubscribers = [];
  let notifications = 0; let failWrites = false;
  const context = { backend: "local", team: { enabled: false }, useSyncExternalStore(subscribe, getSnapshot) {
    unsubscribers.push(subscribe(() => notifications++)); return getSnapshot();
  } };
  globalThis.__persistentStateTest = context;
  globalThis.window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw new Error("quota exceeded"); storage.set(key, value); } },
    addEventListener: (type, callback) => { assert.equal(type, "storage"); events.add(callback); },
    removeEventListener: (type, callback) => { assert.equal(type, "storage"); events.delete(callback); },
  };
  try {
    const output = join(temporary, "persistent.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../packages/dashboard/src/lib/use-persistent-state.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [{ name: "hook-context", setup(build) {
      const sources = {
        react: 'export const useCallback=fn=>fn; export const useSyncExternalStore=(...args)=>globalThis.__persistentStateTest.useSyncExternalStore(...args);',
        "@/api": 'export const useBackendApi=()=>({client:{backendId:globalThis.__persistentStateTest.backend}});',
        "@/components/team-access": 'export const useTeamAccess=()=>globalThis.__persistentStateTest.team;',
      };
      build.onResolve({ filter: /^(react|@\/api|@\/components\/team-access)$/ }, args => ({ path: args.path, namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
    } }] });
    const { usePersistentState } = await import(pathToFileURL(output).href);
    const first = usePersistentState("drafts", {});
    const second = usePersistentState("drafts", {});
    assert.equal(events.size, 1, "live instances share one storage listener per scoped key");
    first[1](previous => ({ ...previous, root: "root draft" }));
    second[1](previous => ({ ...previous, worker: "worker draft" }));
    assert.deepEqual(usePersistentState("drafts", {})[0], { root: "root draft", worker: "worker draft" }, "second updater reads the first instance's current value");
    assert.ok(notifications >= 4, "both subscribers learn of both updates");
    const localKey = [...storage.keys()][0];

    context.backend = "remote";
    assert.deepEqual(usePersistentState("drafts", {})[0], {}, "backend switch starts from its own state");
    usePersistentState("drafts", {})[1]({ remote: "remote draft" });
    context.backend = "local";
    assert.deepEqual(usePersistentState("drafts", {})[0], { root: "root draft", worker: "worker draft" });
    context.team = { enabled: true, user: { workspaceId: "team", userId: "alice" } };
    assert.deepEqual(usePersistentState("drafts", {})[0], {}, "account sign-in does not copy anonymous drafts");
    usePersistentState("drafts", {})[1]({ private: "alice draft" });
    context.team.user = { workspaceId: "team", userId: "bob" };
    assert.deepEqual(usePersistentState("drafts", {})[0], {}, "another account has independent drafts");
    context.team.user = { workspaceId: "other-team", userId: "alice" };
    assert.deepEqual(usePersistentState("drafts", {})[0], {}, "workspace identity is part of the scope");
    context.team.user = { workspaceId: "team", userId: "alice" };
    assert.deepEqual(usePersistentState("drafts", {})[0], { private: "alice draft" });

    usePersistentState("legacy-dock", null)[1]({ width: 563 });
    assert.deepEqual(usePersistentState("durable-dock", null, { legacyKey: "legacy-dock" })[0], { width: 563 }, "durable identity migrates the scoped layout");
    context.team.user = { workspaceId: "team", userId: "bob" };
    assert.equal(usePersistentState("durable-dock", null, { legacyKey: "legacy-dock" })[0], null, "migration does not cross accounts");
    context.team.user = { workspaceId: "team", userId: "alice" };
    failWrites = true;
    usePersistentState("drafts", {})[1](previous => ({ ...previous, retained: "unsaved but usable" }));
    assert.deepEqual(usePersistentState("drafts", {})[0], { private: "alice draft", retained: "unsaved but usable" });
    failWrites = false;
    context.team = { enabled: false };
    storage.set(localKey, JSON.stringify({ external: "another tab" }));
    const before = notifications;
    for (const listener of events) listener({ key: localKey });
    assert.ok(notifications > before, "storage events notify mounted subscribers");
    assert.deepEqual(usePersistentState("drafts", {})[0], { external: "another tab" });
    assert.deepEqual(usePersistentState("different-key", {})[0], {}, "changing keys does not copy old state");
    const persistedBefore = new Map(storage);
    const listenerCount = events.size;
    const memoryFirst = usePersistentState("attachments", [], { persist: false });
    const memorySecond = usePersistentState("attachments", [], { persist: false });
    memoryFirst[1](["data:image/jpeg;base64,private"]);
    memorySecond[1](previous => [...previous, "second image"]);
    assert.deepEqual(usePersistentState("attachments", [], { persist: false })[0], ["data:image/jpeg;base64,private", "second image"]);
    assert.deepEqual(storage, persistedBefore, "image drafts never write browser storage");
    assert.equal(events.size, listenerCount, "memory drafts do not subscribe to persistent storage");
    context.backend = "remote";
    assert.deepEqual(usePersistentState("attachments", [], { persist: false })[0], [], "memory attachments are backend scoped");
    context.backend = "local";
    context.team = { enabled: true, user: { workspaceId: "team", userId: "alice" } };
    assert.deepEqual(usePersistentState("attachments", [], { persist: false })[0], [], "memory attachments are account scoped");
    context.team = { enabled: false };
    assert.equal(usePersistentState("attachments", [], { persist: false })[0].length, 2, "reopened hook recovers in-memory attachments");
    for (const unsubscribe of unsubscribers) unsubscribe();
    assert.equal(events.size, 0, "last unsubscribe releases each scoped storage listener");
  } finally { globalThis.window = previousWindow; delete globalThis.__persistentStateTest; await rm(temporary, { recursive: true, force: true }); }
});
