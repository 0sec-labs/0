import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/dashboard/", import.meta.url));

test("settings render every category through one divided surface with shared row geometry", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".settings-layout-test-"));
  try {
    const queries = resolve(directory, "queries.ts");
    await writeFile(queries, `
      const definitions = [
        {key:'updatePolicy',kind:'enum',label:'Updates',choices:['off','notify','automatic'],operatorOnly:true},
        {key:'busyInputMode',kind:'enum',label:'Messages',choices:['steer','queue']},
        {key:'allowModelSelfExtension',kind:'boolean',label:'Tools'},
        {key:'analyticsLevel',kind:'enum',label:'Metrics',choices:['off','basic']}
      ];
      export const useQuery = ({queryKey}) => ({isPending:false,isSuccess:true,error:null,refetch(){},data:queryKey[0]==='console-execution' ? {profile:'local',configured:true,runtimeReady:true,imageApproved:true} : {definitions,settings:{updatePolicy:'notify',busyInputMode:'queue',allowModelSelfExtension:false,analyticsLevel:'off'}}});
      export const useQueryClient = () => ({setQueryData(){},clear(){}});
      export const useMutation = () => ({isPending:false,error:null,mutate(){},reset(){}});
    `);
    const api = resolve(directory, "api.ts");
    await writeFile(api, `export const useBackendApi=()=>({client:{backendId:'local'},webFetchJson:()=>{throw new Error('Unexpected request during render')}});`);
    const team = resolve(directory, "team.ts");
    await writeFile(team, `export const useTeamAccess=()=>({enabled:false,sso:false});`);
    const controls = resolve(directory, "controls.tsx");
    await writeFile(controls, `import React from 'react';
      export const Select=props=><button data-slot="select-trigger" className={props.className} aria-label={props['aria-label']}>{props.options?.find(option=>option.value===props.value)?.label}</button>;
      export const Switch=props=><button role="switch" aria-label={props['aria-label']} aria-checked={props.checked}/>;
      export const Disclosure=props=><details><summary>{props.summary}</summary>{props.children}</details>;
    `);
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {MemoryRouter} from 'react-router-dom';
      import {SettingsControl} from './src/components/console-control/settings-control';
      import {TextField,SubmitButton} from './src/components/console-control/control-ui';
      export const html=renderToStaticMarkup(<MemoryRouter><SettingsControl/></MemoryRouter>);
      export const formHtml=renderToStaticMarkup(<form><p id="endpoint-policy">Use a trusted endpoint.</p><TextField id="endpoint" label="Endpoint" hint="HTTPS only" aria-describedby="endpoint-policy"/><SubmitButton pending>Connect</SubmitButton></form>);
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic", external: ["react", "react-dom", "react-dom/server", "react-router-dom"], banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' }, alias: {
      "@": resolve(dashboard, "src"), "@/api": api, "@/components/team-access": team,
      "@tanstack/react-query": queries,
      "@/components/ui/select": controls, "@/components/ui/switch": controls, "@/components/ui/disclosure": controls,
    }, logLevel: "silent" });
    const { html, formHtml } = await import(pathToFileURL(output).href);
    assert.match(formHtml, /<label[^>]*for="endpoint"/);
    assert.match(formHtml, /<input[^>]*id="endpoint"[^>]*aria-describedby="endpoint-policy endpoint-hint"/);
    assert.match(formHtml, /<p[^>]*id="endpoint-hint"[^>]*>HTTPS only/);
    assert.match(formHtml, /<button[^>]*aria-busy="true"[^>]*disabled=""/);
    const groups = [...html.matchAll(/<section\b[^>]*data-slot="settings-section"[^>]*>([\s\S]*?)<\/section>/g)];
    assert.equal(groups.length, 6, "updates, appearance, conversation, agents, privacy and reset use the same section");
    for (const [, group] of groups) {
      assert.equal((group.match(/data-slot="card"/g) ?? []).length, 1, "one card per group, never nested row cards");
      assert.match(group, /data-slot="card-content"[^>]*divide-y/);
      assert.match(group, /<h2\b/);
    }
    assert.equal((html.match(/data-slot="settings-row"/g) ?? []).length, 7);
    assert.equal((html.match(/data-slot="settings-row-control"/g) ?? []).length, 7);
    assert.match(html, /aria-label="Web appearance"/);
    assert.match(html, /role="switch" aria-label="Reduce motion"/);
    assert.match(html, /Trusted code still requires workspace approval/);
    assert.match(html, /Environment opt-outs take priority/);
    assert.equal((html.match(/Saved in this browser\./g) ?? []).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
