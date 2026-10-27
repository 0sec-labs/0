import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/dashboard/package.json", import.meta.url));
const { isCancelledError } = require("@tanstack/react-query");

// Exercise the production hook's asynchronous state transitions with isolated
// network/effect boundaries. State slots retain their values across renders;
// effects are disabled so polling cannot influence a deferred send's outcome.
test("workspace sends target root/worker drafts independently and retain failed or newly edited content", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "0-workspace-drafts-"));
  const slots = []; let cursor = 0; let deferred;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const calls = []; const dispatches = [];
  globalThis.__workspaceDraftTest = { isCancelledError, useState, useRef: initial => { const [ref] = useState(() => ({ current: initial })); return ref; }, api: {
    client: { backendId: "local" },
    webFetchJson: (path, input) => { dispatches.push({ path, input }); return new Promise((resolve, reject) => { deferred = { resolve, reject }; }); },
    sendConsoleMessage: (session, input) => { calls.push({ session, input }); return new Promise((resolve, reject) => { deferred = { resolve, reject }; }); },
  } };
  try {
    const output = join(temporary, "workspace.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../packages/dashboard/src/console/use-console-workspace.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [{ name: "isolated-hook-boundaries", setup(build) {
      const sources = {
        react: 'export const useState=globalThis.__workspaceDraftTest.useState; export const useRef=globalThis.__workspaceDraftTest.useRef; export const useEffect=()=>{}; export const useMemo=fn=>fn();',
        "@tanstack/react-query": 'export const isCancelledError=globalThis.__workspaceDraftTest.isCancelledError; export const useQuery=options=>({isSuccess:true,data:options.queryKey[0]==="console-snapshot"?undefined:[],isFetching:false}); export const useQueryClient=()=>({invalidateQueries:async()=>{}});',
        "@/api": 'export const useBackendApi=()=>globalThis.__workspaceDraftTest.api; export const localControlFetch=(...args)=>{const fn=globalThis.__workspaceDraftTest.api.localControlFetch; if(!fn)throw new Error("Unexpected relay request"); return fn(...args);};',
        "@/components/team-access": 'export const useTeamAccess=()=>({enabled:false});',
        "@/lib/use-persistent-state": 'import {useState} from "react"; export const usePersistentState=(_key,initial)=>useState(initial);',
      };
      build.onResolve({ filter: /^(react|@tanstack\/react-query|@\/api|@\/components\/team-access|@\/lib\/use-persistent-state)$/ }, args => ({ path: args.path, namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
    } }] });
    const { useConsoleWorkspace, applyEvents } = await import(pathToFileURL(output).href);
    const initial = { session: { id: "session", status: "working" }, cursor: 1, events: [{ type: "user", sequence: 1, text: "original" }], messages: [], workers: [], queuedMessages: [], pendingDecisions: [], lastOutcome: null };
    const queueEvent = { type: "queued", sequence: 2, messages: [{ id: "queue", text: "follow up", createdAt: "now" }] };
    const queued = applyEvents(initial, [queueEvent], 2);
    assert.equal(queued.queuedMessages[0].text, "follow up", "queue events expose accepted sends while root is working");
    const streamed = applyEvents(queued, [queueEvent, { type: "assistant-delta", sequence: 3, text: "still working" }], 3);
    assert.deepEqual(streamed.events.map(event => event.sequence), [1, 2, 3], "overlapping event pages do not duplicate or lose incoming updates");
    assert.equal(streamed.queuedMessages[0].id, "queue", "assistant updates preserve the queue");
    const consumed = applyEvents(streamed, [{ type: "queued", sequence: 4, messages: [] }, { type: "user", sequence: 5, text: "follow up" }], 5);
    assert.deepEqual(consumed.queuedMessages, []);
    assert.equal(consumed.events.at(-1).text, "follow up", "queue consumption retains the new real user turn");
    assert.deepEqual(applyEvents(queued, [{ type: "clear", sequence: 3 }], 3).queuedMessages, [], "clearing the conversation also clears visible queued messages");
    const render = (session = "session", worker = "worker") => { cursor = 0; return useConsoleWorkspace(session, worker); };
    const image = (id, value = id) => ({ id, kind: "image", value, name: `${id}.jpg` });
    const payload = attachments => attachments.map(({kind,value,name}) => ({kind,value,name}));
    let workspace = render();
    workspace.setDraft("worker draft"); workspace.setRootDraft("root draft");
    workspace.setAttachments(() => [image("worker-image")]); workspace.setRootAttachments(() => [image("root-image")]);
    workspace = render();
    const rootSend = workspace.send({ text: workspace.rootDraft, attachments: payload(workspace.rootAttachments) });
    assert.equal(calls[0].input.workerId, undefined);
    deferred.resolve({ ok: true }); assert.equal(await rootSend, true);
    workspace = render();
    assert.equal(workspace.rootDraft, ""); assert.deepEqual(workspace.rootAttachments, []);
    assert.equal(workspace.draft, "worker draft"); assert.equal(workspace.attachments[0].id, "worker-image");

    workspace.setRootDraft("keep root"); workspace.setRootAttachments(() => [image("root-next")]);
    workspace = render();
    const failed = workspace.send({ text: workspace.draft, workerId: "worker", attachments: payload(workspace.attachments) });
    deferred.reject(new Error("offline")); assert.equal(await failed, false);
    workspace = render();
    assert.equal(workspace.draft, "worker draft"); assert.equal(workspace.attachments[0].id, "worker-image");
    assert.equal(workspace.rootDraft, "keep root"); assert.equal(workspace.rootAttachments[0].id, "root-next");

    const workerSend = workspace.send({ text: workspace.draft, workerId: "worker", attachments: payload(workspace.attachments) });
    workspace.setDraft("new worker draft"); workspace.setAttachments(previous => [...previous, image("new-image")]);
    const other = render("another-session", null); other.setDraft("another draft");
    deferred.resolve({ ok: true }); assert.equal(await workerSend, true);
    workspace = render();
    assert.equal(workspace.draft, "new worker draft"); assert.deepEqual(workspace.attachments.map(item => item.id), ["new-image"]);
    assert.equal(workspace.rootDraft, "keep root"); assert.equal(workspace.rootAttachments[0].id, "root-next");
    assert.equal(render("another-session", null).draft, "another draft");
    workspace = render();
    workspace.setRootDraft("queued follow-up"); workspace = render();
    const accepted = workspace.send({text:workspace.rootDraft,mode:"queue"});
    deferred.resolve({session:{id:"session"},queuedMessageId:"queued-accepted"});
    assert.equal(await accepted,true); workspace = render();
    assert.equal(workspace.rootDraft, "");
    assert.equal(workspace.queuedShortcutId,"queued-accepted", "only the server-confirmed newly queued message arms second Enter");
    const force = workspace.sendQueuedNow("queued-accepted");
    assert.equal(await workspace.sendQueuedNow("queued-accepted"),false, "double Enter/click cannot dispatch the same queued message twice");
    assert.equal(dispatches.length,1);
    assert.equal(dispatches[0].path,"/api/console/sessions/session/queue/queued-accepted/send");
    assert.equal(dispatches[0].input.method,"POST");
    assert.equal(dispatches[0].input.body,"{}", "dispatch promotes the existing ID without resending message content");
    deferred.resolve({session:{id:"session"}}); assert.equal(await force,true);
    assert.equal(await render().sendQueuedNow("queued-accepted"),false, "successful promotion stays deduplicated before the next poll");
    workspace=render();
    const failure=workspace.sendQueuedNow("retained-queue");
    deferred.reject(new Error("busy initializing")); assert.equal(await failure,false);
    workspace=render(); assert.match(workspace.error,/busy initializing/);
    assert.equal(workspace.queuedSendingId,null);
    const retry=workspace.sendQueuedNow("retained-queue");
    assert.equal(dispatches.length,3,"failed promotions can be retried with the same original queue ID");
    deferred.resolve({session:{id:"session"}}); assert.equal(await retry,true);

  } finally { delete globalThis.__workspaceDraftTest; await rm(temporary, { recursive: true, force: true }); }
});
