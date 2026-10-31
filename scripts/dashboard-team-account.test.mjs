import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));

test("solo footer is passive and opening the team account menu keeps the app mounted", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".team-account-test-"));
  let server;
  let browser;
  try {
    const api = resolve(directory, "api.ts");
    await writeFile(api, `export async function localControlFetch() {
      const mode = new URLSearchParams(window.location.search).get("mode");
      return Response.json(mode === "solo" ? { enabled: false, sso: false } : {
        enabled: true, sso: false, workspace: { id: "team", name: "Example team" },
        user: { workspaceId: "team", userId: "ada", displayName: "Ada Lovelace", role: mode === "viewer" ? "viewer" : "owner" }
      });
    }`);
    const bundle = await build({ stdin: { contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {MemoryRouter, useLocation} from "react-router-dom";
      import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
      import {TeamAccess, TeamAccount} from "./src/components/team-access";
      function Location() { return <output id="location">{useLocation().pathname}</output>; }
      createRoot(document.getElementById("root")).render(<MemoryRouter><QueryClientProvider client={new QueryClient()}><TeamAccess><h1>Workspace application</h1><TeamAccount rail /><Location /></TeamAccess></QueryClientProvider></MemoryRouter>);
    `, resolveDir: dashboard, loader: "tsx" }, outfile: resolve(directory, "fixture.js"), bundle: true, write: false, loader: { ".svg": "dataurl" }, platform: "browser", format: "esm", jsx: "automatic", alias: { "@/api": api, "@": resolve(dashboard, "src") }, logLevel: "silent" });
    const javascript = bundle.outputFiles[0].contents;
    server = createServer((request, response) => {
      if (request.url === "/fixture.js") { response.writeHead(200, { "Content-Type": "application/javascript" }); response.end(javascript); }
      else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<div id="root"></div><script type="module" src="/fixture.js"></script>'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?mode=solo`);
    await page.getByRole("heading", { name: "Workspace application" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Solo workspace" }).count(), 0);
    await page.getByText("Solo workspace", { exact: true }).click();
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await page.locator("#location").textContent(), "/");

    await page.goto(`${origin}/?mode=owner`);
    await page.getByRole("button", { name: "Account: Ada Lovelace" }).click();
    await page.getByRole("menuitem", { name: "Workspace settings" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "Findings API" }).count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "Sign out" }).count(), 1);
    assert.equal(await page.getByRole("heading", { name: "Workspace application" }).count(), 1);
    await page.getByRole("menuitem", { name: "Workspace settings" }).click();
    assert.equal(await page.locator("#location").textContent(), "/team");

    await page.goto(`${origin}/?mode=viewer`);
    await page.getByRole("button", { name: "Account: Ada Lovelace" }).click();
    await page.getByRole("menuitem", { name: "Workspace settings" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "Findings API" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
