import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

test("accepted queued text and images remain visible while the current response works", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "0-queue-ui-"));
  try {
    const output = join(temporary, "queue.cjs");
    await build({ stdin: { contents: 'import {createElement} from "react"; import {renderToStaticMarkup} from "react-dom/server"; import {QueuedMessages} from "./src/console/queued-messages"; export const render = props => renderToStaticMarkup(createElement(QueuedMessages, {...props, inline:true}));', resolveDir: resolve("packages/dashboard"), loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "cjs", logLevel: "silent", alias: { "@": resolve("packages/dashboard/src") }, plugins: [{name:"queue-test-boundaries",setup(build){
      build.onResolve({filter:/^@\/api$/},()=>({path:"api",namespace:"stub"}));
      build.onResolve({filter:/^\.\/inline-image$/},()=>({path:"image",namespace:"stub"}));
      build.onLoad({filter:/.*/,namespace:"stub"},args=>({contents:args.path==="api"?'export const useBackendApi=()=>({removeConsoleQueuedMessage:async()=>({ok:true})});':'import {createElement} from "react"; export const InlineImage=props=>createElement("img",props);',loader:"js",resolveDir:process.cwd()}));
    }}] });
    const {render} = await import(pathToFileURL(output).href);
    const props = {workspace:{busy:false,perform:async action=>action()},snapshot:{session:{id:"chat",status:"working"},queuedMessages:[{id:"queued-1",text:"Please check the deployment too",createdAt:"2026-10-20T00:00:00Z"},{id:"queued-2",text:"",attachments:[{kind:"image",value:"data:image/jpeg;base64,aW1hZ2U=",name:"Screenshot"}]}]}};
    const html=render(props);
    assert.match(html,/Please check the deployment too/);
    assert.match(html,/Queued · sends after the current response/);
    assert.match(html,/aria-live="polite"/);
    assert.match(html,/alt="Screenshot"/);
    assert.match(html,/Remove queued message 2/);
    assert.match(html,/Send now/);
    assert.match(html,/Interrupt the current response and send this message now/);
    assert.match(render({...props,workspace:{...props.workspace,busy:true,queuedSendingId:"queued-1"}}),/Sending…/);
    assert.equal(render({...props,snapshot:{...props.snapshot,queuedMessages:[]}}), "", "consumed queue cards disappear when the server starts their turns");
  } finally {await rm(temporary,{recursive:true,force:true});}
});
