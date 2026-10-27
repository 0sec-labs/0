import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("page placeholders expose a single loading status and keep cached skills visible",async()=>{
 const dashboard=resolve(root,"packages/dashboard"),directory=await mkdtemp(resolve(dashboard,".page-skeleton-test-"));
 try {
  const output=resolve(directory,"fixture.mjs");
  await build({stdin:{resolveDir:dashboard,loader:"tsx",contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{LoadingState}from'./src/components/state-panel';import{SkillsLibrary}from'./src/components/skills-library';export const loading=props=>renderToStaticMarkup(React.createElement(LoadingState,props));export const skills=props=>renderToStaticMarkup(React.createElement(SkillsLibrary,{onSelect(){},onCreate(){},...props}));`},outfile:output,bundle:true,platform:"node",format:"esm",packages:"external",jsx:"automatic",loader:{".css":"empty"},alias:{"@":resolve(dashboard,"src")},logLevel:"silent"});
  const {loading,skills}=await import(pathToFileURL(output).href);
  for (const variant of ["list","cards","detail","form"]) {
   const html=loading({label:"Loading lessons…",variant});
   assert.match(html,/role="status"/);assert.match(html,/aria-label="Loading lessons…"/);assert.match(html,/aria-busy="true"/);
   assert.match(html,/class="sr-only">Loading lessons…/);assert.match(html,/data-slot="skeleton"/);assert.doesNotMatch(html,/animate-spin|lucide-loader/);
  }
  const cached=skills({loading:true,skills:[{id:"cached",name:"Cached skill",description:"Ready to use",scope:"personal",fileCount:1,writable:true,revision:"v1",source:"local"}]});
  assert.match(cached,/Open skill Cached skill/);assert.doesNotMatch(cached,/data-slot="page-skeleton"/);
  const empty=skills({loading:true,skills:[]});assert.match(empty,/data-slot="page-skeleton"/);assert.doesNotMatch(empty,/No installed skills/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
