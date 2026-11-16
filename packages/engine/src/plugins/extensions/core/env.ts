/**
 * Environment for a process an extension starts (scripts, MCP stdio servers). Built from scratch, not filtered
 * from the parent: a small base set plus exactly the names the extension DECLARED and the operator APPROVED.
 * Model provider keys are never passed unless declared and approved. Loader variables are never passed.
 */
export const LOADER_ENV = /^(LD_[A-Z_]*|DYLD_[A-Z_]*|NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS)$/;
export const BASE_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"];
const PROVIDER_KEY = /^(ANTHROPIC|OPENAI|AZURE_OPENAI|GOOGLE|GEMINI|MISTRAL|COHERE|GROQ|XAI|DEEPSEEK|OPENROUTER|TOGETHER|PERPLEXITY|HUGGINGFACE|HF|VERTEX)_[A-Z0-9_]*$|_API_KEY$/;
export const isProviderKeyName = (name: string): boolean => PROVIDER_KEY.test(name);

export interface ExtensionEnvInput {
  declared: readonly string[];
  approved: readonly string[];
  parent: Readonly<Record<string, string | undefined>>;
  extra?: Readonly<Record<string, string>>;
}

export function extensionEnv(input: ExtensionEnvInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of BASE_ENV) { const value = input.parent[name]; if (typeof value === "string") out[name] = value; }
  const approved = new Set(input.approved);
  for (const name of input.declared) {
    if (!approved.has(name) || LOADER_ENV.test(name)) continue;
    const value = input.parent[name];
    if (typeof value === "string") out[name] = value;
  }
  for (const [name, value] of Object.entries(input.extra ?? {})) if (!LOADER_ENV.test(name)) out[name] = value;
  return out;
}
