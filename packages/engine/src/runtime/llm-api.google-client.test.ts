import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime, __resetGeminiCodeAssistAuthStateForTests } from "./llm-api.js";
const scopes = {ZERO_GEMINI_OAUTH_REFRESH_TOKEN:"fixture-refresh",ZERO_LLM_FALLBACK:"",ZERO_FORCE_PROVIDER:"",ZERO_SKIP_PROVIDER_BANNER:"1"};
const runtime=(metadata:Record<string,string>={})=>new LlmApiRuntime({type:"api",timeout:1000,provider:"google",model:"gemini-2.5-pro",env:{...scopes,...metadata}});
const invoke=(r:LlmApiRuntime)=>r.executeNative("instructions",[{role:"user",content:[{type:"text",text:"hello"}]}],[]);
beforeEach(()=>__resetGeminiCodeAssistAuthStateForTests());afterEach(()=>{vi.unstubAllGlobals();__resetGeminiCodeAssistAuthStateForTests();});
describe("Google credential-bound OAuth clients",()=>{
  it("refreshes each client independently without borrowing the legacy secret or identity",async()=>{
    const posts:URLSearchParams[]=[];const agents:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(url,init)=>{
      if(String(url)==="https://oauth2.googleapis.com/token"){posts.push(new URLSearchParams(String(init?.body)));return Response.json({access_token:"fixture-access",expires_in:3600});}
      if(String(url).endsWith(":loadCodeAssist"))return Response.json({cloudaicompanionProject:"fixture-project"});
      if(String(url).endsWith(":generateContent")){agents.push((init?.headers as Record<string,string>)["User-Agent"]!);return Response.json({response:{candidates:[{content:{parts:[{text:"done"}]},finishReason:"STOP"}]}});}
      throw Error("unexpected fixture request");
    }));
    for(const r of [runtime(),runtime({ZERO_GEMINI_OAUTH_CLIENT_ID:"own-public"}),runtime({ZERO_GEMINI_OAUTH_CLIENT_ID:"own-confidential",ZERO_GEMINI_OAUTH_CLIENT_SECRET:"own-secret"})])expect((await invoke(r)).error).toBeUndefined();
    expect(posts).toHaveLength(3);expect(posts[0]?.get("client_id")).not.toBe("own-public");expect(posts[0]?.has("client_secret")).toBe(true);
    expect(posts[1]?.get("client_id")).toBe("own-public");expect(posts[1]?.has("client_secret")).toBe(false);
    expect(posts[2]?.get("client_secret")).toBe("own-secret");expect(agents[0]).toMatch(/^GeminiCLI\//);expect(agents.slice(1).every(v=>v.startsWith("0/"))).toBe(true);
  });
  it("redacts refresh error bodies while retaining safe invalid-grant guidance",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:"invalid_grant",error_description:"fixture-refresh own-secret echoed"},{status:400})));
    const result=await invoke(runtime({ZERO_GEMINI_OAUTH_CLIENT_ID:"own",ZERO_GEMINI_OAUTH_CLIENT_SECRET:"own-secret"}));
    expect(result.error).toContain("invalid_grant");expect(result.error).not.toContain("fixture-refresh");expect(result.error).not.toContain("own-secret");
  });
});
