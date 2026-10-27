import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("local model ownership and remote execution never route credentials or browser grants to a host",async()=>{
  const directory=await mkdtemp("/tmp/0-model-source-");
  try{
    const mock=resolve(directory,"api.ts"),output=resolve(directory,"fixture.mjs");
    await writeFile(mock,`export const calls=[];export let fail=false;export const setFail=value=>fail=value;export async function localControlFetch(path,init){calls.push({path,method:init.method,body:JSON.parse(init.body)});return Response.json(fail?{error:'Select a local ChatGPT account first.'}:{session:{id:'new-session'}},{status:fail?409:200});}`);
    await build({stdin:{contents:`export * from '${resolve(root,"packages/dashboard/src/console/model-source.ts")}';export {calls,setFail} from '${mock}';`,resolveDir:directory,loader:"ts"},outfile:output,bundle:true,platform:"node",format:"esm",alias:{"@/api":mock},logLevel:"silent"});
    const module=await import(pathToFileURL(output).href);
    assert.equal(module.modelCatalogOwner("bench",{modelSource:"local"}),"local");
    assert.equal(module.modelCatalogOwner("bench",{modelSource:"host"}),"bench");
    assert.equal(module.modelCatalogOwner("bench",null),"bench","legacy host-owned model selection remains explicit");
    const configuration={title:"Remote work",runtime:{providerId:"chatgpt-codex",model:"chosen-model"}};
    await module.createChatOnExecutionHost("bench",configuration);
    assert.deepEqual(module.calls[0],{path:"/api/console/remote-sessions",method:"POST",body:{backendId:"bench",configuration}});
    assert.doesNotMatch(JSON.stringify(module.calls),/grantId|credential|access_token|api_key/);
    await module.createChatOnExecutionHost("local",configuration);
    assert.deepEqual(module.calls[1],{path:"/api/console/sessions",method:"POST",body:configuration});
    const direct=[];
    const api={client:{backendId:"bench"},configureConsoleSession:async(id,body)=>{direct.push({id,body});return{session:{id}};}};
    await module.configureChatRuntime(api,"remote-session",{model:"next-model"},{modelSource:"local"});
    assert.deepEqual(module.calls[2],{path:"/api/console/remote-sessions/remote-session/configuration",method:"PATCH",body:{backendId:"bench",runtime:{model:"next-model"}}});
    assert.equal(direct.length,0,"the local orchestrator, rather than ambient remote auth, updates a relayed runtime");
    await module.configureChatRuntime(api,"legacy-session",{model:"host-model"},{modelSource:"host"});
    assert.deepEqual(direct,[{id:"legacy-session",body:{runtime:{model:"host-model"}}}]);
    module.setFail(true);
    await assert.rejects(module.createChatOnExecutionHost("bench",configuration),/Select a local ChatGPT account/);
    assert.equal(direct.length,1,"local grant failures never silently fall back to remote credentials");
  }finally{await rm(directory,{recursive:true,force:true});}
});
