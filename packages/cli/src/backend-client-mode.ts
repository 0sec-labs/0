import { BackendIdSchema } from "@0/shared";

/** Explicit remote transport selection never grants local code or target execution. */
export function remoteBackendClientId(args: readonly string[]): string | undefined {
  if (!(["workflow", "runs", "sessions", "mcp-server"] as readonly string[]).includes(args[0] ?? "")) return undefined;
  const engineUrls: Array<string | undefined> = [];
  const tokenEnvs: Array<string | undefined> = [];
  const selections: Array<string | undefined> = [];
  const valueFlags = new Set(["--template", "--revision", "--target", "--workspace", "--scope", "--model", "--inputs", "--time-cap", "--cost-cap", "--db-path", "--format", "--backends-config", "--tools", "--scan-id", "--timeout", "--rate-limit", "--engagement-profile", "--session", "--config", "--response", "--after", "--branch-from-entry"]);
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") break;
    if (argument === "--engine-url") { engineUrls.push(args[++index]); continue; }
    if (argument.startsWith("--engine-url=")) { engineUrls.push(argument.slice(13)); continue; }
    if (argument === "--engine-token-env") { tokenEnvs.push(args[++index]); continue; }
    if (argument.startsWith("--engine-token-env=")) { tokenEnvs.push(argument.slice(19)); continue; }
    if (argument === "--backend") { selections.push(args[++index]); continue; }
    if (argument.startsWith("--backend=")) { selections.push(argument.slice(10)); continue; }
    if (valueFlags.has(argument)) index++;
  }
  if (engineUrls.length || tokenEnvs.length) {
    if (selections.length || engineUrls.length !== 1 || tokenEnvs.length !== 1) throw new Error("Select either one --backend or one --engine-url with --engine-token-env.");
    if (!engineUrls[0] || engineUrls[0].length > 4096 || !tokenEnvs[0] || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnvs[0])) throw new Error("Invalid direct engine attachment options.");
    const url = new URL(engineUrls[0]);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("Engine URL must be credential-free HTTPS or loopback HTTP, without query or fragment.");
    return "attached-engine";
  }
  if (!selections.length) return undefined;
  if (selections.length !== 1) throw new Error("Select exactly one registered remote backend.");
  const selected = BackendIdSchema.parse(selections[0]);
  if (selected === "local") throw new Error("--backend local is not a remote selection. Omit --backend to preserve configured local execution.");
  return selected;
}
