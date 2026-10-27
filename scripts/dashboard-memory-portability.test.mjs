import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("memory portability reviews before import, keeps lessons disabled, and never uploads an unreadable file", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".memory-portability-test-"));
  let server, browser;
  try {
    const stub = resolve(directory, "stub.ts");
    await writeFile(stub, `
      const client={backendId:'local'};
      export const useTeamAccess=()=>({enabled:new URLSearchParams(location.search).has('viewer'),user:new URLSearchParams(location.search).has('viewer')?{role:'viewer',workspaceId:'team',userId:'viewer'}:undefined});
      window.memoryCalls=[];
      export const useBackendApi=()=>({client,webFetchJson:async(path,options)=>{
        window.memoryCalls.push({path,body:options?.body&&JSON.parse(options.body)});
        if(path.endsWith('/export'))return {format:'zero-memory',version:1,exportedAt:'2026-10-25T00:00:00Z',knowledge:[]};
        if(path.endsWith('/preview'))return {preview:{digest:'reviewed-digest',total:1,importable:1,duplicates:0,projects:['project-a'],knowledge:[{id:'note-a',projectId:'project-a',summary:'Verify tenant ownership before returning records.',sourceCount:1,duplicate:false}],warnings:[]}};
        if(path.endsWith('/import'))return {result:{imported:1,duplicates:0,disabled:true}};
        throw new Error('Unexpected request '+path);
      }});
    `);
    const bundle = await build({ stdin: { contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MemoryPortability} from './src/components/memory-portability';
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryPortability/></QueryClientProvider>);
    `, resolveDir: dashboard, loader: "tsx" }, bundle: true, platform: "browser", format: "esm", jsx: "automatic", write: false, loader: { ".css": "empty" }, alias: { "@/api": stub, "@/components/team-access": stub, "@": resolve(dashboard, "src") }, logLevel: "silent" });
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") { response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(bundle.outputFiles[0].contents); }
      else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<div id="root"></div><script type="module" src="/fixture.js"></script>'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export lessons", exact: true }).click();
    assert.match((await download).suggestedFilename(), /^zero-memory-\d{4}-\d{2}-\d{2}\.json$/);
    await page.getByRole("button", { name: "Import lessons", exact: true }).click();
    await page.getByLabel("Memory export JSON file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("not JSON") });
    await page.getByRole("alert").filter({ hasText: "isn’t valid JSON" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Review import", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.memoryCalls.some(call => call.path.includes("/import"))), false);
    const archive = { format: "zero-memory", version: 1, knowledge: [{ id: "note-a", projectId: "project-a", summary: "Verify tenant ownership before returning records." }] };
    await page.getByLabel("Memory export JSON file").setInputFiles({ name: "memories.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
    await page.getByText("This file is selected locally.", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.memoryCalls.some(call => call.path.includes("/import"))), false, "selecting a local file never uploads it");
    await page.getByRole("button", { name: "Review import", exact: true }).click();
    await page.getByRole("heading", { name: "Review imported lessons" }).waitFor();
    assert.equal(await page.evaluate(() => window.memoryCalls.filter(call => call.path.endsWith("/preview")).length), 1);
    assert.equal(await page.evaluate(() => window.memoryCalls.filter(call => call.path.endsWith("/import")).length), 0, "review cannot save lessons");
    await page.getByRole("button", { name: "Import 1 lesson", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "1 lesson imported. Imported lessons are not in use." }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.memoryCalls.find(call => call.path.endsWith("/import")).body), { archive, digest: "reviewed-digest" });
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.goto(`${url}?viewer=1`);
    assert.equal(await page.getByRole("button", { name: "Import lessons", exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(directory, { recursive: true, force: true }); }
});
