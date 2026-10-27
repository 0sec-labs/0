import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const dashboard=fileURLToPath(new URL('../packages/dashboard/',import.meta.url));
test('source context distinguishes supplied lessons, empty requests and unsupported hosts',async()=>{
  const directory=await mkdtemp(resolve(dashboard,'.source-context-test-'));
  try{
    const output=resolve(directory,'fixture.mjs');
    await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';import {SourceContext} from './src/console/source-context';export const render=context=>renderToStaticMarkup(<MemoryRouter><SourceContext context={context}/></MemoryRouter>);`,resolveDir:dashboard,loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',alias:{'@':resolve(dashboard,'src')},logLevel:'silent'});
    const {render}=await import(pathToFileURL(output).href);
    assert.equal(render(undefined),'','older hosts must not imply memory is absent');
    const pending=render({status:'not_requested',lessons:[]});
    assert.match(pending,/No model request yet/);
    assert.doesNotMatch(pending,/No saved lessons were supplied/);
    const none=render({status:'none',lessons:[]});
    assert.match(none,/No saved lessons were supplied with this request/);
    assert.match(none,/Latest model request/);
    const supplied=render({status:'supplied',lessons:[{title:'Tenant ownership',summary:'Check & verify ownership.',sourceLinks:[{path:'src/routes.ts',hash:'hash-one'}]}]});
    assert.match(supplied,/Memory supplied to model · 1/);
    assert.match(supplied,/Tenant ownership/);
    assert.match(supplied,/Check &amp; verify ownership/);
    assert.match(supplied,/src\/routes.ts/);
    assert.match(supplied,/does not show whether the model relied on it or cited it/);
    assert.match(supplied,/href="\/learning"/);
    assert.doesNotMatch(supplied,/hash-one/,'source identifiers stay out of the primary explanation');
    const stale=render({status:'none',lessons:[{title:'Old lesson',summary:'Old context',sourceLinks:[]}]});
    assert.doesNotMatch(stale,/Old lesson/,'status controls display instead of stale data');
  }finally{await rm(directory,{recursive:true,force:true});}
});
