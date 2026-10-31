import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSiwcConnection, listSiwcModels, siwcHeaders, type SiwcConnection } from "./siwc-connection.js";
import { LlmApiRuntime } from "./llm-api.js";
const connection = (): SiwcConnection => ({ accountId: "subject-fixture", clientId: "oaiapp_fixture", hostId: "urn:uuid:fixture", resolveCredentials: vi.fn(async () => ({ accessToken: "fixture-bearer", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"] })) });
const catalog = () => Response.json({models:[{slug:"fixture-model",display_name:"Fixture",visibility:"list"},{slug:"m",display_name:"M",visibility:"list"}]});
const reply = (event = "response.completed") => new Response(`data: ${JSON.stringify({type: event, response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage: {input_tokens: 4, output_tokens: 1} }})}\n\n`, {headers:{"content-type":"text/event-stream"}});
afterEach(() => vi.unstubAllGlobals());
describe("SIWC connection", () => {
  it("requires an issued registration and captures immutable account binding", () => {
    expect(() => captureSiwcConnection({...connection(), clientId: "dynamic_agent_client"})).toThrow(/issued client/);
    const original = connection(); const captured = captureSiwcConnection(original);
    Object.assign(original, {accountId:"other", clientId:"other"});
    expect(captured.accountId).toBe("subject-fixture"); expect(captured.clientId).toBe("oaiapp_fixture");
  });
  it("requires both granted plan scopes before returning a bearer", async () => {
    for (const scopes of [[], ["resource.invoke"], ["chatgpt.tokens.use.direct"]]) {
      await expect(siwcHeaders({...connection(), resolveCredentials: async () => ({accessToken:"secret", scopes})})).rejects.toThrow(/permission/);
    }
  });
  it("preserves visible catalog ordering and uses the selected connection", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({models:[{slug:"z",display_name:"Z",visibility:"list"},{slug:"hidden",display_name:"Hidden",visibility:"hide"},{slug:"a",display_name:"A",visibility:"list"}]}));
    expect(await listSiwcModels(connection(),fetcher)).toEqual([{slug:"z",display_name:"Z"},{slug:"a",display_name:"A"}]);
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/models",expect.objectContaining({headers:expect.objectContaining({Authorization:"Bearer fixture-bearer"}),redirect:"error"}));
  });
  it("does not leak provider error bodies or accept API-key catalog shape", async () => {
    await expect(listSiwcModels(connection(),async () => new Response("secret",{status:403}))).rejects.toThrow("HTTP 403");
    await expect(listSiwcModels(connection(),async () => Response.json({data:[]}))).rejects.toThrow(/Invalid/);
  });
  it("does not resolve credentials after cancellation", async () => {
    const c = connection(); const abort = new AbortController();abort.abort();
    await expect(siwcHeaders(c,abort.signal)).rejects.toThrow();expect(c.resolveCredentials).not.toHaveBeenCalled();
  });
  it("uses public Responses with refreshed scoped bearer for roots and forks", async () => {
    const c=connection(); const fetcher=vi.fn<typeof fetch>(async (url) => String(url).endsWith("/models") ? catalog() : reply());vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"fixture-model",siwcConnection:c,env:{OPENAI_BASE_URL:"https://wrong.invalid",OPENAI_API_KEY:"wrong"}});
    expect(await runtime.isAvailable()).toBe(true);expect(runtime.resolvedProvider()).toBe("chatgpt-plan");expect(runtime.accessibleProviders()).toEqual(["chatgpt-plan"]);
    const child=await runtime.forkForSubagent(1000);
    for (const r of [runtime,child]) {const result=await r.execute("hello");expect(result.error).toBeUndefined();expect(result.output).toBe("done");}
    expect(c.resolveCredentials).toHaveBeenCalledTimes(4);
    for (const [url,init] of fetcher.mock.calls.filter(([url])=>String(url).endsWith("/responses"))) {
      expect(url).toBe("https://api.openai.com/v1/responses");expect(init?.headers).toMatchObject({Authorization:"Bearer fixture-bearer"});
      expect(init?.headers).not.toHaveProperty("ChatGPT-Account-Id");expect(JSON.parse(String(init?.body))).toMatchObject({model:"fixture-model",store:false,stream:true});
    }
    expect(child.connectionIdentity()).toBe(runtime.connectionIdentity());
  });
  it("uses instructions and namespaced local functions without unsupported output caps", async () => {
    const fetcher=vi.fn<typeof fetch>(async(url)=>String(url).endsWith("/models") ? catalog() : reply());vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m",siwcConnection:connection()});
    expect(runtime.outputTokenLimit).toBeUndefined();
    await runtime.executeNative("trusted instructions",[{role:"user",content:[{type:"text",text:"hello"}]}],[{name:"read_file",description:"Read",input_schema:{type:"object"}}]);
    const body=JSON.parse(String(fetcher.mock.calls.find(([url])=>String(url).endsWith("/responses"))?.[1]?.body));
    expect(body.instructions).toBe("trusted instructions");expect(body.input).not.toContainEqual(expect.objectContaining({role:"system"}));expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.tools).toEqual([{type:"namespace",name:"zero",description:expect.any(String),tools:[expect.objectContaining({type:"function",name:"read_file"})]}]);
  });
  it("fails closed before inference when plan permission is missing", async () => {
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m",siwcConnection:{...connection(),resolveCredentials:async()=>({accessToken:"fixture",scopes:["openid"]})}});
    expect((await runtime.execute("hello")).error).toMatch(/permission is not enabled/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never treats Codex-style response.done as completed plan inference", async () => {
    vi.stubGlobal("fetch",vi.fn<typeof fetch>(async(url)=>String(url).endsWith("/models") ? catalog() : reply("response.done")));
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m",siwcConnection:connection()});
    const result=await runtime.execute("hello");expect(result.exitCode).toBe(1);expect(result.error).toBeDefined();
  });
  it("fails when a plan-sharing usage error arrives after streamed text", async () => {
    const events=[{type:"response.output_text.delta",delta:"partial"},{type:"response.failed",response:{status:"failed",error:{code:"subscription_sharing_usage_limit_exceeded",message:"limit"}}}];
    const fetcher=vi.fn<typeof fetch>(async(url)=>String(url).endsWith("/models") ? catalog() : new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}}));
    vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m",siwcConnection:connection()});
    const result=await runtime.execute("hello");expect(result.exitCode).toBe(1);expect(result.error).toContain("subscription_sharing_usage_limit_exceeded");expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("aborts a host resolver which ignores cancellation", async () => {
    const abort=new AbortController();
    const pending=siwcHeaders({...connection(),resolveCredentials:()=>new Promise(()=>{})},abort.signal);
    abort.abort(new Error("cancelled fixture"));await expect(pending).rejects.toThrow("cancelled fixture");
  });
  it("enforces account catalog membership before root, reconfigured or forked inference", async () => {
    const fetcher=vi.fn<typeof fetch>(async(url)=>String(url).endsWith("/models") ? catalog() : reply());vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"absent",agentModels:{review:"also-absent"},siwcConnection:connection()});
    expect(await runtime.availableModelCatalog()).toEqual([{id:"fixture-model",source:"catalog"},{id:"m",source:"catalog"}]);
    expect((await runtime.execute("hello")).error).toContain("available catalog");
    runtime.reconfigure({model:"still-absent"});expect((await runtime.execute("hello")).error).toContain("available catalog");
    const child=await runtime.forkForSubagent(1000,{role:"review"});expect((await child.execute("hello")).error).toContain("available catalog");
    expect(fetcher.mock.calls.every(([url])=>String(url).endsWith("/models"))).toBe(true);
  });
  it("switches API-key runtime to an explicit plan binding without retargeting its account", async () => {
    const fetcher=vi.fn<typeof fetch>(async(url)=>String(url).endsWith("/models") ? catalog() : reply());vi.stubGlobal("fetch",fetcher);
    const runtime=new LlmApiRuntime({type:"api",timeout:1000,provider:"openai",model:"m",apiKey:"old-key",env:{ZERO_SKIP_PROVIDER_BANNER:"1"}});
    runtime.reconfigure({provider:"chatgpt-plan",model:"m",siwcConnection:connection()});
    expect((await runtime.execute("hello")).error).toBeUndefined();
    expect(()=>runtime.reconfigure({siwcConnection:{...connection(),accountId:"different"}})).toThrow(/new chat runtime/);
    expect(fetcher.mock.calls.every(([,init])=>(init?.headers as Record<string,string>).Authorization==="Bearer fixture-bearer")).toBe(true);
  });
  it("refuses implicit API-key auth or missing selected model", () => {
    expect(()=>new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m"})).toThrow(/verified connection/);
    expect(()=>new LlmApiRuntime({type:"api",timeout:1000,provider:"chatgpt-plan",model:"m",siwcConnection:connection(),apiKey:"wrong"})).toThrow(/API keys/);
  });
});
