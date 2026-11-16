import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("page placeholders expose a single loading status and keep cached skills visible",async()=>{
 const dashboard=resolve(root,"packages/web"),directory=await mkdtemp(resolve(dashboard,".page-skeleton-test-"));
 try {
  const output=resolve(directory,"fixture.mjs");
  await build({stdin:{resolveDir:dashboard,loader:"tsx",contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{LoadingState}from'./src/components/state-panel';import{MemoryRouter}from'react-router-dom';import{SkillsLibrary}from'./src/components/skills-library';export const loading=props=>renderToStaticMarkup(React.createElement(LoadingState,props));export const skills=props=>renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(SkillsLibrary,{onSelect(){},onCreate(){},...props})));`},outfile:output,bundle:true,platform:"node",format:"esm",packages:"external",jsx:"automatic",loader:{".css":"empty"},alias:{"@":resolve(dashboard,"src")},logLevel:"silent"});
  const {loading,skills}=await import(pathToFileURL(output).href);
  for (const variant of ["list","cards"]) {
   const html=loading({label:"Loading memory…",variant});
   assert.match(html,/data-slot="skeleton-panel"/);assert.match(html,/role="status"/);assert.match(html,/aria-busy="true"/);
   assert.match(html,/class="sr-only">Loading memory…/);assert.match(html,/data-slot="skeleton"/);assert.doesNotMatch(html,/animate-spin|lucide-loader/);
   assert.match(html,/delay-\[250ms\]/);assert.match(html,/starting:opacity-0/);assert.match(html,/animate-skeleton-pulse/);
   assert.equal((html.match(/animate-skeleton-pulse/g)||[]).length,1);assert.doesNotMatch(html,/bg-\(image|gradient/);
  }
  for (const variant of ["detail","form"]) assert.equal(loading({label:"Loading memory…",variant}),"");
  const cached=skills({loading:true,skills:[{id:"cached",name:"Cached skill",description:"Ready to use",scope:"personal",fileCount:1,writable:true,revision:"v1",source:"local"}]});
  assert.match(cached,/href="\/skills\?skill=cached"[^>]*>Cached skill<\/a>/);assert.doesNotMatch(cached,/data-slot="skeleton-panel"/);
  const empty=skills({loading:true,skills:[]});assert.match(empty,/data-slot="skeleton-panel"/);assert.doesNotMatch(empty,/No installed skills/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
