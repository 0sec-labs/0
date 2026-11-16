/**
 * Environment for a process an extension starts (scripts, MCP stdio servers). Built from scratch, not filtered
 * from the parent: a small base set plus exactly the names the extension DECLARED and the operator APPROVED.
 * Model provider keys are never passed unless declared and approved. Loader variables are never passed.
 */
export const LOADER_ENV = /^(PATH|HOME|SHELL|IFS|PS4|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|NODE_PATH|NODE_OPTIONS|GIT_[A-Z0-9_]*|SHELLOPTS|BASHOPTS|BASH_ENV|ENV|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|(HTTPS?|ALL|NO)_PROXY)$/i;
/**
 * ALLOW pattern for a variable name an extension may declare (MCP env, script env, connector env). A name must be
 * upper-case and end in a word that marks a credential or a setting; the denylist above still applies on top, but the
 * allowlist is what protects against the next dangerous variable nobody listed.
 */
export const SAFE_ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|URL|URI|HOST|PORT|ID|USER|USERNAME|EMAIL|ENDPOINT|REGION|PROJECT|ORG|ORGANIZATION|WORKSPACE|DOMAIN|ACCOUNT|TENANT|DATABASE|DB|NAME|VERSION|PROFILE|CHANNEL|TEAM|CERT)$/;
export const isSafeExtensionEnvName = (name: string): boolean => name.length <= 64 && SAFE_ENV_NAME.test(name) && !LOADER_ENV.test(name);
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
