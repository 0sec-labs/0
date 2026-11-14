import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dashboard=fileURLToPath(new URL('../packages/web/',import.meta.url));
test('force-stop control requires an explicit owned capability and delayed cancellation phase',async()=>{
 const directory=await mkdtemp(resolve(dashboard,'.force-stop-test-'));
 try{
  const output=resolve(directory,'fixture.mjs');
  await build({stdin:{contents:`import React from 'react';import{renderToStaticMarkup}from'react-dom/server';import{ForceStopControl}from'./src/console/force-stop-control';export const render=props=>renderToStaticMarkup(<ForceStopControl {...props} onForceStop={()=>{}}/>);`,resolveDir:dashboard,loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
  const {render}=await import(pathToFileURL(output).href);
  const props={canWrite:true,busy:false};
  assert.equal(render(props),'');
  for(const phase of ['draining','force_stopping'])assert.equal(render({...props,cancellation:{phase,forceStopAvailable:true}}),'');
  for(const phase of ['timed_out','unconfirmed']){
   assert.equal(render({...props,cancellation:{phase}}),'','elapsed time does not imply force-stop support');
   assert.equal(render({...props,cancellation:{phase,forceStopAvailable:false}}),'');
   const cancellation={phase,forceStopAvailable:true};
   const allowed=render({...props,cancellation});assert.match(allowed,/>Force stop<\/button>/);assert.doesNotMatch(allowed,/ disabled(?:=|>)/);
   assert.match(render({...props,cancellation,canWrite:false}),/ disabled(?:=|>)/,'viewers cannot invoke force-stop');
   assert.match(render({...props,cancellation,busy:true}),/ disabled(?:=|>)/,'pending mutation disables repeated requests');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
