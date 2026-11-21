import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAi, generateSbom } from "./index.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const folder = (files: Record<string, string>) => { const dir = mkdtempSync(join(tmpdir(), "0-aibom-")); dirs.push(dir); for (const [path, content] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), content); } return dir; };
const prop = (component: { properties: Array<{ name: string; value: string }> }, name: string) => component.properties.find(item => item.name === name)?.value;

describe("AI inventory", () => {
  const dir = () => folder({
    "app/model.py": 'from transformers import AutoModel, pipeline\nm = AutoModel.from_pretrained("bert-base-uncased")\nt = pipeline("sentiment-analysis", model="distilbert/distilbert-base-uncased-finetuned-sst-2-english")\nds = load_dataset("imdb")\nhf_hub_download(repo_id="org/weights", filename="x")\n',
    "app/chat.ts": 'const r = await client.chat.completions.create({ model: "gpt-4o-mini", messages });\nconst c = { model: "claude-sonnet-4-6" };\nconst notAModel = { model: "my-custom-thing" };\n',
    "weights/a.safetensors": "x", "weights/b.pt": "x", "weights/c.gguf": "x",
    ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "some-mcp-server", "/home/me"] }, pinned: { command: "npx", args: ["-y", "other@1.2.3"] }, remote: { url: "https://mcp.example.com/sse" } } }),
    "node_modules/x/ignored.py": 'AutoModel.from_pretrained("ignored/model")',
  });
  it("lists models, datasets, hosted model ids, model files and MCP servers, each with where it was seen", () => {
    const found = detectAi(dir());
    const refs = found.map(component => component["bom-ref"]);
    expect(refs).toEqual(expect.arrayContaining(["hub-model:bert-base-uncased", "hub-model:distilbert/distilbert-base-uncased-finetuned-sst-2-english", "dataset:imdb", "hub-model:org/weights", "hosted-model:gpt-4o-mini", "hosted-model:claude-sonnet-4-6", "ml-file:weights/a.safetensors", "ml-file:weights/b.pt", "ml-file:weights/c.gguf", "mcp:.mcp.json:files", "mcp:.mcp.json:pinned", "mcp:.mcp.json:remote"]));
    expect(refs.some(ref => ref.includes("ignored") || ref.includes("my-custom-thing"))).toBe(false);
    const bert = found.find(component => component.name === "bert-base-uncased")!;
    expect(bert.type).toBe("machine-learning-model");
    expect(prop(bert, "0:source")).toBe("app/model.py:2");
    expect(found.find(component => component.name === "imdb")!.type).toBe("data");
    expect(prop(found.find(component => component.name === "gpt-4o-mini")!, "0:provider")).toBe("openai");
  });
  it("flags pickle-based model files and unpinned MCP launchers, and nothing else", () => {
    const found = detectAi(dir());
    const by = (ref: string) => found.find(component => component["bom-ref"] === ref)!;
    expect(prop(by("ml-file:weights/b.pt"), "0:risk")).toContain("pickle");
    expect(prop(by("ml-file:weights/a.safetensors"), "0:risk")).toBeUndefined();
    expect(prop(by("mcp:.mcp.json:files"), "0:risk")).toContain("pinned");
    expect(prop(by("mcp:.mcp.json:pinned"), "0:risk")).toBeUndefined();
    expect(prop(by("mcp:.mcp.json:remote"), "0:url")).toBe("https://mcp.example.com/sse");
  });
  it("is part of the SBOM only when asked for, and the same folder gives the same document", () => {
    const where = dir();
    expect(generateSbom(where, { toolVersion: "0" }).bom.components).toEqual([]);
    const one = generateSbom(where, { toolVersion: "0", ai: true, now: new Date(0) }); const two = generateSbom(where, { toolVersion: "0", ai: true, now: new Date(0) });
    expect(one.bom.components.length).toBeGreaterThan(8);
    expect(JSON.stringify(one.bom)).toBe(JSON.stringify(two.bom));
  });
});
