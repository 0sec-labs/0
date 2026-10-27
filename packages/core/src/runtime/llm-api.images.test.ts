import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmApiRuntime } from "./llm-api.js";
import type { NativeMessage } from "./types.js";

const image = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };
const messages: NativeMessage[] = [{ role: "user", content: [{ type: "text", text: "Describe this" }, image] }];
afterEach(() => { vi.unstubAllGlobals(); });
function runtime(provider: string, wireApi: string): LlmApiRuntime {
  const result = new LlmApiRuntime({ type: "api", timeout: 5000, apiKey: "fixture", model: "gpt-4o" });
  Object.assign(result, { provider, wireApi, apiKey: "fixture", baseUrl: "https://fixture.invalid" });
  return result;
}
describe("native image provider transport", () => {
  it("sends image_url parts to chat completions", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: "image" }, finish_reason: "stop" }] })); }));
    await runtime("openai", "chat_completions").executeNative("System", messages, []);
    expect(body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } });
  });
  it("sends native base64 image sources to Anthropic", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: "text", text: "image" }], stop_reason: "end_turn" })); }));
    await runtime("anthropic", "messages").executeNative("System", messages, []);
    expect(body.messages[0].content.find((block: any) => block.type === "image")).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: image.data } });
  });
  it("sends inlineData parts to Gemini", () => {
    const rt = runtime("google", "generate_content") as any;
    expect(rt.googleContents(messages)[0].parts).toContainEqual({ inlineData: { mimeType: "image/png", data: image.data } });
  });
  it("sends input_image parts to the Responses API", async () => {
    let body: any;
    const stream = 'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"image"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { body = JSON.parse(init.body); return new Response(stream, { headers: { "content-type": "text/event-stream" } }); }));
    await runtime("openai", "responses").executeNative("System", messages, []);
    expect(body.input.flatMap((message: any) => message.content ?? [])).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${image.data}` });
  });
});
