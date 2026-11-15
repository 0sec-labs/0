/** Browser check: sidebar thread-row actions are mounted (not faded) on hover and focus, reachable by keyboard. Geometry (no layout shift) needs the real stylesheet and is covered by the preview audit. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
const dashboard = fileURLToPath(new URL("../packages/web/", import.meta.url));

test("thread row actions mount on hover and focus", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".row-actions-test-"));
  let server, browser;
  try {
    const stub = resolve(directory, "stub.tsx");
    await writeFile(stub, `import {useState} from "react";
      const host={id:"local",name:"My Mac",status:"connected",platform:{os:"darwin"}};
      export const useBackendSelection=()=>({backendId:"local",backends:[host]});
      export const useTeamAccess=()=>({enabled:false});
      export const usePersistentState=(_key,value)=>useState(value);
      export const CHAT_DRAG_MIME="application/x-chat";
      export const consoleSnapshotKey=(host,id)=>["console-snapshot",host,id];
      export const createChatOnExecutionHost=async()=>({id:"created"});
      const live=["alpha","beta"].map(id=>({id,title:id,target:"",status:"ready",messageCount:2,updatedAt:"2026-10-25T10:00:00Z",createdAt:"2026-10-25T10:00:00Z"}));
      const api={client:{backendId:"local",dispose(){}},listConsoleSessions:()=>Promise.resolve(live),listSavedConsoleSessions:()=>Promise.resolve([]),getConsoleSnapshot:async id=>({session:live.find(s=>s.id===id)})};
      export const useBackendApi=()=>api;
      export const createBackendApi=()=>api;
      export const localControlFetch=()=>Promise.resolve(Response.json({}));
    `);
    const bundle = await build({ stdin: { contents: `
      import React from "react"; import {createRoot} from "react-dom/client";
      import {BrowserRouter} from "react-router-dom";
      import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
      import {HostSidebarChatHistory} from "./src/components/host-sidebar-chat-history";
      createRoot(document.getElementById("root")).render(<BrowserRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><div style={{width:240}}><button id="before">before</button><HostSidebarChatHistory onSelect={()=>{}} onCreate={()=>{}} onPendingChatChange={()=>{}} isPendingChatCurrent={()=>false}/></div></QueryClientProvider></BrowserRouter>);
    `, resolveDir: dashboard, loader: "tsx" }, outfile: resolve(directory, "fixture.js"), write: false, bundle: true, platform: "browser", format: "esm", jsx: "automatic", loader: { ".css": "empty", ".svg": "dataurl" }, alias: { "@/api": stub, "@/backend-context": stub, "@/components/team-access": stub, "@/lib/use-persistent-state": stub, "@/console/use-console-workspace": stub, "@/console/dock-workspace": stub, "@/console/model-source": stub, "@": resolve(dashboard, "src") }, logLevel: "silent" });
    server = createServer((request, response) => { if (request.url === "/fixture.js") { response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(bundle.outputFiles[0].contents); } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<div id="root"></div><script type="module" src="/fixture.js"></script>'); } });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 600, height: 500 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const rows = page.locator('[role=list] > [role=listitem]');
    await rows.first().waitFor();
    const actions = page.locator('[data-slot=sidebar-thread-actions]');
    assert.equal(await actions.count(), 0, "actions are not mounted at rest");
    await rows.nth(1).hover();
    await actions.first().waitFor({ timeout: 2000 });
    assert.equal(await actions.count(), 1, "only the hovered row mounts actions");
    assert.equal(await actions.first().evaluate(el => el.closest("[role=listitem]") === el.parentElement), true, "actions belong to the hovered row");
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector("[data-slot=sidebar-thread-actions]"), null, { timeout: 2000 });
    await page.locator("#before").focus();
    await page.keyboard.press("Tab"); // thread list sort/search buttons, then rows
    for (let i = 0; i < 8 && !(await actions.count()); i++) await page.keyboard.press("Tab");
    assert.equal(await actions.count(), 1, "keyboard focus mounts the row actions");
    await page.keyboard.press("Tab");
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^Delete /, "the action button is reachable by keyboard");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[role=listitem]")?.querySelector("a")?.getAttribute("href")), "/chats/beta", "focus moves on to the next row");
  } finally {
    await browser?.close();
    server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
