// `0 config github` — the GitHub account used to publish fixes, as on the web Settings > Git page.
import type { Command } from "commander";
import { exitWhenDone, expectOk, printJson, readSecret, renderTable, runConsoleCommand, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

interface Account { available: boolean; connected: boolean; account: string | null; missingScopes: string[]; refreshCommand: string | null }
const describe = (a: Account) => !a.available ? "GitHub CLI (gh) is not installed." : a.connected ? `Signed in as ${a.account}.${a.missingScopes.length ? ` Missing scopes: ${a.missingScopes.join(", ")}.` : ""}` : "Not signed in. Run `0 config set github connect --key-env <VAR>`.";

export function runGithubStatus(options: JsonOption, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const { github } = expectOk(await client.request("GET", "/api/console/github")) as { github: Account };
    if (options.json) printJson(io, { github });
    else io.out(describe(github));
  });
}

export function runGithubConnect(options: JsonOption & { keyEnv?: string; stdin?: boolean }, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const token = await readSecret(options, deps, "GitHub token");
    const { github } = expectOk(await client.request("POST", "/api/console/github/connect", { token })) as { github: Account };
    if (options.json) printJson(io, { github });
    else io.out(describe(github));
  });
}

export function runGithubRepos(options: JsonOption & { search?: string; refresh?: boolean }, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const data = expectOk(await client.request("GET", `/api/console/repositories${options.refresh ? "?refresh=1" : ""}`));
    const needle = options.search?.toLowerCase();
    const repositories = (data.repositories as { nameWithOwner: string; visibility: string; defaultBranch: string }[]).filter(r => !needle || r.nameWithOwner.toLowerCase().includes(needle));
    if (options.json) return printJson(io, { ...data, repositories });
    if (!data.connected) throw new Error(data.available ? "Not signed in to GitHub. Run `0 config set github connect`." : "GitHub CLI (gh) is not installed.");
    if (data.error) throw new Error(data.error);
    io.out(repositories.length ? renderTable(["REPOSITORY", "VISIBILITY", "BRANCH"], repositories.map(r => [r.nameWithOwner, r.visibility, r.defaultBranch])) : "No matching repositories.");
  });
}

export function registerGithubCommand(program: Command, deps: ConsoleCommandDeps = {}): void {
  const github = program.command("github").description("Check or connect the GitHub account used to publish fixes");
  github.command("status").description("Show whether GitHub is signed in").option("--json", "Print JSON").action((o: JsonOption) => exitWhenDone(runGithubStatus(o, deps)));
  github.command("connect").description("Sign in with a personal access token (from an env var or stdin)")
    .option("--key-env <VAR>", "Read the token from this environment variable").option("--stdin", "Read the token from stdin").option("--json", "Print JSON")
    .action((o: JsonOption & { keyEnv?: string; stdin?: boolean }) => exitWhenDone(runGithubConnect(o, deps)));
  github.command("repos").description("List repositories the signed-in account can reach")
    .option("--search <text>", "Only names containing this text").option("--refresh", "Bypass the five-minute cache").option("--json", "Print JSON")
    .action((o: JsonOption & { search?: string; refresh?: boolean }) => exitWhenDone(runGithubRepos(o, deps)));
}
