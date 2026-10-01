import { BackendIdSchema } from "@0/shared";

/** Explicit remote transport selection never grants local code or target execution. */
export function remoteBackendClientId(args: readonly string[]): string | undefined {
  if (!(["workflow", "runs", "mcp-server"] as readonly string[]).includes(args[0] ?? "")) return undefined;
  const selections: Array<string | undefined> = [];
  const valueFlags = new Set(["--template", "--revision", "--target", "--workspace", "--scope", "--model", "--inputs", "--time-cap", "--cost-cap", "--db-path", "--format", "--backends-config", "--tools", "--scan-id", "--timeout", "--rate-limit", "--engagement-profile"]);
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") break;
    if (argument === "--backend") { selections.push(args[++index]); continue; }
    if (argument.startsWith("--backend=")) { selections.push(argument.slice(10)); continue; }
    if (valueFlags.has(argument)) index++;
  }
  if (!selections.length) return undefined;
  if (selections.length !== 1) throw new Error("Select exactly one registered remote backend.");
  const selected = BackendIdSchema.parse(selections[0]);
  if (selected === "local") throw new Error("--backend local is not a remote selection. Omit --backend to preserve configured local execution.");
  return selected;
}
