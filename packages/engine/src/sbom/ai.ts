/**
 * An inventory of the AI in a folder: models, datasets, hosted model ids and MCP servers, found by reading files as
 * text. Nothing is downloaded, imported or executed, and a reference the patterns do not recognise is simply missed,
 * so this lists what it saw and does not claim to be complete.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export interface AiComponent {
  type: "machine-learning-model" | "data" | "service";
  "bom-ref": string;
  name: string;
  properties: Array<{ name: string; value: string }>;
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage"]);
const CODE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".ipynb"]);
const MODEL_FILES: Record<string, { format: string; pickle: boolean }> = {
  ".gguf": { format: "gguf", pickle: false }, ".safetensors": { format: "safetensors", pickle: false }, ".onnx": { format: "onnx", pickle: false },
  ".tflite": { format: "tflite", pickle: false }, ".mlmodel": { format: "coreml", pickle: false }, ".h5": { format: "keras-h5", pickle: false },
  ".pt": { format: "pytorch", pickle: true }, ".pth": { format: "pytorch", pickle: true }, ".ckpt": { format: "checkpoint", pickle: true },
  ".pkl": { format: "pickle", pickle: true }, ".joblib": { format: "joblib", pickle: true },
};
const MCP_CONFIGS = new Set(["mcp.json", ".mcp.json", "claude_desktop_config.json", "mcp_config.json"]);
const MAX_FILES = 8000;
const MAX_TEXT_BYTES = 1024 * 1024;
const HOSTED = /(?:^|[^\w.-])(?:model|model_name|modelName|model_id|modelId)\s*[:=]\s*["']((?:gpt-|o[134](?:-|["'])|chatgpt-|claude-|gemini-|gemma|llama|mistral|mixtral|codestral|deepseek-|qwen|grok-|command-|text-embedding-|sonar)[\w.:/-]{0,60})["']/g;
const HUB: Array<{ pattern: RegExp; type: AiComponent["type"]; how: string }> = [
  { pattern: /\.from_pretrained\(\s*["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "from_pretrained" },
  { pattern: /pipeline\([^)]*\bmodel\s*=\s*["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "pipeline model" },
  { pattern: /hf_hub_download\([^)]*\brepo_id\s*=\s*["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "hf_hub_download" },
  { pattern: /snapshot_download\(\s*(?:repo_id\s*=\s*)?["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "snapshot_download" },
  { pattern: /SentenceTransformer\(\s*["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "SentenceTransformer" },
  { pattern: /pipeline\(\s*["'][\w-]+["']\s*,\s*["']([^"'\s]{2,120})["']/g, type: "machine-learning-model", how: "transformers.js pipeline" },
  { pattern: /load_dataset\(\s*["']([^"'\s]{2,120})["']/g, type: "data", how: "load_dataset" },
];
const provider = (id: string): string => /^(gpt-|o[134]|chatgpt-|text-embedding-)/.test(id) ? "openai" : id.startsWith("claude-") ? "anthropic" : /^(gemini-|gemma)/.test(id) ? "google" : /^(llama)/.test(id) ? "meta" : /^(mistral|mixtral|codestral)/.test(id) ? "mistral" : id.startsWith("deepseek-") ? "deepseek" : id.startsWith("qwen") ? "alibaba" : id.startsWith("grok-") ? "xai" : id.startsWith("command-") ? "cohere" : "unspecified";
const clean = (value: string, max = 200): string => value.replace(/[^\x20-\x7e]/g, "").slice(0, max);
const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

function listFiles(folder: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= MAX_FILES) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name);
      let info; try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) { if (depth < 8 && !SKIP.has(name) && (!name.startsWith(".") || name === ".cursor" || name === ".vscode")) walk(path, depth + 1); continue; }
      found.push(path);
      if (found.length >= MAX_FILES) return;
    }
  };
  walk(folder, 0);
  return found;
}

export function detectAi(folder: string): AiComponent[] {
  const components = new Map<string, AiComponent>();
  const add = (component: AiComponent): void => {
    const existing = components.get(component["bom-ref"]);
    if (!existing) components.set(component["bom-ref"], component);
    else for (const property of component.properties) if (!existing.properties.some(item => item.name === property.name && item.value === property.value)) existing.properties.push(property);
  };
  for (const path of listFiles(folder)) {
    const rel = relative(folder, path).replace(/\\/g, "/");
    const name = path.split(/[\\/]/).pop()!;
    const extension = extname(name).toLowerCase();
    const model = MODEL_FILES[extension];
    if (model) {
      add({ type: "machine-learning-model", "bom-ref": `ml-file:${rel}`, name: name, properties: [{ name: "0:source", value: rel }, { name: "0:found-by", value: "model file" }, { name: "0:format", value: model.format }, ...(model.pickle ? [{ name: "0:risk", value: "pickle-based format: loading can run code" }] : [])] });
      continue;
    }
    if (MCP_CONFIGS.has(name) || ((rel.startsWith(".cursor/") || rel.startsWith(".vscode/")) && name === "mcp.json")) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const servers = (config.mcpServers ?? config.servers) as Record<string, { command?: unknown; args?: unknown; url?: unknown }> | undefined;
        for (const [serverName, server] of Object.entries(servers && typeof servers === "object" ? servers : {})) {
          const args = Array.isArray(server?.args) ? server.args.map(String) : [];
          const command = [typeof server?.command === "string" ? server.command : "", ...args].join(" ").trim();
          const unpinned = /\bnpx\b.*(?:^|\s)-y\b|\buvx\b|@latest\b|:latest\b/.test(command) && !/@\d+\.\d+\.\d+/.test(command);
          add({ type: "service", "bom-ref": `mcp:${rel}:${clean(serverName, 80)}`, name: `mcp:${clean(serverName, 80)}`, properties: [{ name: "0:source", value: rel }, { name: "0:found-by", value: "MCP configuration" }, ...(command ? [{ name: "0:launch", value: clean(command) }] : []), ...(typeof server?.url === "string" ? [{ name: "0:url", value: clean(server.url) }] : []), ...(unpinned ? [{ name: "0:risk", value: "launched without a pinned version" }] : [])] });
        }
      } catch { /* not valid JSON: no servers listed */ }
      continue;
    }
    if (!CODE.has(extension)) continue;
    let info; try { info = statSync(path); } catch { continue; }
    if (info.size > MAX_TEXT_BYTES) continue;
    let source: string;
    try { source = readFileSync(path, "utf8"); } catch { continue; }
    for (const hub of HUB) {
      for (const match of source.matchAll(hub.pattern)) {
        const id = clean(match[1]!);
        add({ type: hub.type, "bom-ref": `${hub.type === "data" ? "dataset" : "hub-model"}:${id}`, name: id, properties: [{ name: "0:source", value: `${rel}:${lineOf(source, match.index ?? 0)}` }, { name: "0:found-by", value: hub.how }] });
      }
    }
    for (const match of source.matchAll(HOSTED)) {
      const id = clean(match[1]!);
      add({ type: "machine-learning-model", "bom-ref": `hosted-model:${id}`, name: id, properties: [{ name: "0:source", value: `${rel}:${lineOf(source, match.index ?? 0)}` }, { name: "0:found-by", value: "hosted model id" }, { name: "0:provider", value: provider(id) }] });
    }
  }
  return [...components.values()].sort((a, b) => (a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0));
}
