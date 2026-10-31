import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));
test("folder browsing uses the selected host, preserves manual drafts, and configures only after selection", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".folder-browser-test-"));
  let server, browser;
  try {
    const stub = resolve(directory, "api.tsx");
    await writeFile(stub, `import React,{createContext,useContext} from "react";
      import {BackendClient} from "../src/lib/backend-client";
      export const Context=createContext(null);
      export const useBackendApi=()=>useContext(Context);
      export function api(host){
        const client=new BackendClient(host,async(url,init)=>{
          const body=JSON.parse(init.body);window.requests.push({url,body});
          init.signal.addEventListener("abort",()=>window.aborted++);
          if(url.endsWith("/choose-directory")){
            if(window.deferNative){window.deferNative=false;return new Promise(resolve=>{window.finishNative=()=>resolve(Response.json({supported:true,path:"/late-native"}));});}
            if(window.nativeError)return Response.json({error:"picker unavailable"},{status:503});
            return Response.json(window.nativeResult||{supported:true,path:"/native/project"});
          }
          const current=body.path||"/home/host"; const result={path:current,homePath:"/home/host",parentPath:current==="/"?null:current.slice(0,current.lastIndexOf("/"))||"/",entries:[{name:"project",path:"/srv/project"}],truncated:false};
          if(window.deferNext){window.deferNext=false;return new Promise(resolve=>{window.finishDeferred=()=>resolve(Response.json({...result,path:"/late-response"}));});}
          return Response.json(result);
        });
        return{client,webFetchJson:async(path,init)=>{const response=await client.request(path,init);const body=await response.json();if(!response.ok)throw new Error(body.error);return body;},configureConsoleSession:async(id,value)=>{window.configured.push({id,...value});return{session:{id}};}};
      }
    `);
    const output = await build({ stdin: { contents: `import React,{useEffect,useMemo,useState} from "react";import{createRoot}from"react-dom/client";
      import{FilePathPicker}from"./src/console/file-path-picker";import{Context,api}from"${stub}";
      window.requests=[];window.configured=[];window.aborted=0;
      function App(){const[host,setHost]=useState("remote-fixture");window.changeHost=setHost;const value=useMemo(()=>api(host),[host]);useEffect(()=>()=>value.client.dispose(),[value]);return <Context.Provider value={value}><FilePathPicker workspace={{busy:false,perform:async action=>action()}} sessionId="chat" cwd="/srv" disabled={false} workspaceDisabled={false}/></Context.Provider>}
      createRoot(document.getElementById("root")).render(<App/>);`, resolveDir: dashboard, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", write: false, jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent", plugins: [{ name: "backend-fixture", setup(api) { api.onResolve({ filter: /^@\/api$/ }, () => ({ path: stub })); } }] });
    server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(`<div id="root"></div><script>${output.outputFiles[0].text}</script>`); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const open = () => page.getByRole("button", { name: "Change workspace: /srv", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Workspace folder path" });
    await open();
    assert.equal(await page.getByRole("list", { name: "Folders", exact: true }).count(), 0, "initial open never starts a directory request");
    assert.deepEqual(await page.evaluate(() => window.requests), []);
    await page.getByRole("button", { name: "Browse folders", exact: true }).click();
    await page.getByRole("button", { name: "project", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("input").value === "/srv/project");
    await page.getByRole("button", { name: "Up", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("input").value === "/srv");
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("input").value === "/home/host");
    assert.equal(await page.getByRole("button", { name: "Home", exact: true }).isDisabled(), true);
    await input.fill("/"); await page.getByRole("button", { name: "Open path", exact: true }).click();
    await page.waitForFunction(() => window.requests.at(-1).body.path === "/" && !document.querySelector('[aria-label="Loading folders"]'));
    assert.equal(await page.getByRole("button", { name: "Up", exact: true }).isDisabled(), true);
    await input.fill("/srv/project"); await page.getByRole("button", { name: "Open path", exact: true }).click();
    await page.waitForFunction(() => window.requests.at(-1).body.path === "/srv/project" && !document.querySelector('[aria-label="Loading folders"]'));
    assert.deepEqual(await page.evaluate(() => window.configured), [], "browsing grants no scope or session configuration");
    assert.ok((await page.evaluate(() => window.requests)).every(request => request.url === "/api/backends/remote-fixture/proxy/api/console/project/directories"));
    await page.getByRole("button", { name: "Use folder", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.configured), [{ id: "chat", workspacePath: "/srv/project" }]);
    await open(); await input.fill("/manual/repo"); await page.getByRole("button", { name: "Use folder", exact: true }).click();
    assert.equal(await page.evaluate(() => window.configured.at(-1).workspacePath), "/manual/repo");
    await page.evaluate(() => window.deferNext = true); await open();
    await page.getByRole("button", { name: "Browse folders", exact: true }).click();
    await page.waitForFunction(() => typeof window.finishDeferred === "function"); await input.fill("/manual/draft");
    await page.evaluate(() => window.finishDeferred());
    await page.getByRole("button", { name: "project", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "/manual/draft", "late listings do not overwrite a newly typed path");
    await page.evaluate(() => window.deferNext = true); await page.getByRole("button", { name: "Open path", exact: true }).click();
    const before = await page.evaluate(() => window.aborted); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(value => window.aborted > value, before); await page.evaluate(() => window.finishDeferred());
    assert.equal(await page.getByRole("textbox", { name: "Workspace folder path" }).count(), 0);
    await open(); await page.evaluate(() => window.changeHost("other-host"));
    await page.waitForFunction(() => !document.querySelector("input"));
    assert.equal(await page.evaluate(() => window.configured.length), 2);

    await page.evaluate(() => window.changeHost("local")); await open();
    const choose = () => page.getByRole("button", { name: "Choose folder…", exact: true }).click();
    assert.equal(await page.getByRole("list", { name: "Folders", exact: true }).count(), 0);
    await choose(); await page.waitForFunction(() => document.querySelector("input").value === "/native/project");
    assert.equal(await page.evaluate(() => window.requests.at(-1).url), "/api/console/project/choose-directory");
    assert.equal(await page.evaluate(() => window.configured.length), 2, "native selection only updates the preview");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await open(); await input.fill("/keep-this"); await page.evaluate(() => window.nativeResult = { supported: true, path: null });
    await choose(); await page.getByRole("button", { name: "Choose folder…", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "/keep-this", "native cancellation is a no-op");
    assert.equal(await page.getByRole("list", { name: "Folders", exact: true }).count(), 0);
    await page.evaluate(() => window.nativeResult = { supported: false, path: null }); await choose();
    await page.getByText("The folder picker isn't available on this host. Browse folders below or enter a path.").waitFor();
    await page.getByRole("list", { name: "Folders", exact: true }).waitFor();
    await page.evaluate(() => window.nativeError = true); await choose();
    await page.getByText("Couldn't open the folder picker. Browse folders below or enter a path.").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.evaluate(() => { window.nativeError = false; window.deferNative = true; }); await open(); await choose();
    const opening = page.getByRole("button", { name: "Opening folder picker…", exact: true });
    assert.equal(await opening.isDisabled(), true); assert.equal(await opening.getAttribute("aria-busy"), "true");
    const pendingCalls = await page.evaluate(() => window.requests.filter(request => request.url.endsWith("/choose-directory")).length);
    await opening.evaluate(button => button.click());
    assert.equal(await page.evaluate(() => window.requests.filter(request => request.url.endsWith("/choose-directory")).length), pendingCalls);
    const beforeNativeClose = await page.evaluate(() => window.aborted); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(value => window.aborted > value, beforeNativeClose); await page.evaluate(() => window.finishNative());
    await open(); assert.equal(await input.inputValue(), "/srv", "closed native result cannot overwrite a reopened picker");
    await page.evaluate(() => window.deferNative = true); await choose(); await page.evaluate(() => window.changeHost("other-host"));
    await page.waitForFunction(() => !document.querySelector("input")); await page.evaluate(() => window.finishNative()); await open();
    await page.getByRole("button", { name: "Browse folders", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Choose folder…", exact: true }).count(), 0);
    assert.equal(await input.inputValue(), "/srv"); assert.equal(await page.evaluate(() => window.configured.length), 2);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});
