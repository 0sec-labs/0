import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("../",import.meta.url));
test("host opening waits for a fresh handshake and never reuses the prior route's API",async()=>{
  const directory=await mkdtemp("/tmp/0-host-readiness-");
  try{
    const output=resolve(directory,"fixture.mjs");
    await build({entryPoints:[resolve(root,"packages/dashboard/src/console/chat-host-readiness.ts")],outfile:output,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
    const {chatHostReadiness:phase,descriptorForRoute}=await import(pathToFileURL(output).href);
    const pending={registryReady:true,registered:true,fetchedAfterMount:false,fetching:true,hasData:false,hasError:false};
    assert.equal(phase(pending),"connecting");
    assert.equal(phase({...pending,hasError:true}),"connecting","a cached error is not this pane's connection result");
    assert.equal(phase({...pending,hasData:true}),"connecting","cached success still waits for the initial fresh check");
    assert.equal(phase({...pending,registryReady:false,registered:false}),"connecting","registry bootstrap cannot claim a host was removed");
    assert.equal(phase({...pending,fetchedAfterMount:true,fetching:false,hasError:true}),"failed","completed failed handshakes leave the loading state");
    assert.equal(phase({...pending,fetchedAfterMount:true,hasError:true}),"connecting","an explicit retry shows progress instead of the old failure");
    assert.equal(phase({...pending,fetchedAfterMount:true,fetching:false,hasData:true}),"ready");
    assert.equal(phase({...pending,fetchedAfterMount:true,fetching:false,hasData:true,hasError:true}),"ready","background connection trouble preserves the validated chat and its draft");
    assert.equal(phase({...pending,registered:false,fetching:false}),"unregistered");
    const local={id:"local"};
    assert.equal(descriptorForRoute("devbox",local),null,"route updates cannot mount a remote session against a local client for one frame");
    const remote={id:"devbox"};assert.equal(descriptorForRoute("devbox",remote),remote);
    assert.equal(descriptorForRoute("devbox",null),null);
  }finally{await rm(directory,{recursive:true,force:true});}
});
