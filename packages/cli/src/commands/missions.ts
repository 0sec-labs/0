import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { consoleTransportOptions, openConsole, type ConsoleClient, type ConsoleTransportOptions } from "../console-client.js";
import { finishWithError, renderTable, UsageError } from "./output.js";

export interface MissionsDeps {
  open(options: ConsoleTransportOptions): Promise<ConsoleClient>;
  out(text: string): void;
  err(text: string): void;
  sleep(ms: number): Promise<void>;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}
const defaults: MissionsDeps = {
  open: options => openConsole(options),
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  readFile: path => readFileSync(path, "utf8"),
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
};

type Options = ConsoleTransportOptions & { json?: boolean; saved?: boolean; yes?: boolean };
const MODES = ["standard", "recon", "copilot", "yolo"];
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
type Json = Record<string, unknown>;
const asJson = (value: unknown): Json => (value && typeof value === "object" ? value as Json : {});

function missionId(id: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id) || id === "." || id === "..") throw new UsageError("Mission ID may contain letters, digits and _ . : - only.");
  return encodeURIComponent(id);
}
function choice(value: string | undefined, allowed: string[], flag: string): string | undefined {
  if (value !== undefined && !allowed.includes(value)) throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
  return value;
}
function requireYes(options: Options, what: string): void {
  if (!options.yes) throw new UsageError(`${what} is destructive. Re-run with --yes to confirm.`);
}
function summarize(session: Json): string {
  return [session.id, session.status, session.title ? `"${String(session.title)}"` : undefined, session.workspacePath].filter(Boolean).join("  ");
}
function lastAssistantText(snapshot: Json): string | undefined {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages as Json[] : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = (message.content as Json[]).filter(block => block.type === "text").map(block => String(block.text)).join("\n").trim();
    if (text) return text;
  }
  return undefined;
}

export function registerMissionsCommand(program: Command, deps: MissionsDeps = defaults): void {
  const missions = program.command("missions").description("Start, steer, stop and manage missions on the running engine");
  const transport = (command: Command) => consoleTransportOptions(command).option("--json", "Print the engine response as JSON");
  type Handler = (client: ConsoleClient, options: Options, args: string[]) => Promise<void>;
  type Validate = (options: Options, args: string[]) => void;
  const guarded = (handler: Handler, validate: Validate = () => {}) => ({ handler, validate });
  const action = (command: Command, { handler, validate }: { handler: Handler; validate: Validate }) =>
    command.action(async (...received: unknown[]) => {
      const options = received[received.length - 2] as Options;
      const args = received.slice(0, -2).filter((value): value is string => typeof value === "string");
      let client: ConsoleClient | undefined;
      try {
        validate(options, args); // usage errors exit 2 before any connection is opened
        client = await deps.open(options);
        await handler(client, options, args);
      } catch (error) { finishWithError(error, deps, options.json); }
      finally { client?.dispose(); }
    });
  const print = (options: Options, value: unknown, text: string) => deps.out(options.json ? JSON.stringify(value, null, 2) : text);
  const sessionPrint = (options: Options, value: unknown) => print(options, value, summarize(asJson(asJson(value).session)));

  action(transport(missions.command("list").description("List live missions").option("--saved", "List retained mission snapshots instead")),
    guarded(async (client, options) => {
      const value = asJson(await client.request("GET", options.saved ? "/api/console/saved" : "/api/console/sessions"));
      const rows = (Array.isArray(value.sessions) ? value.sessions : []) as Json[];
      print(options, value, rows.length ? renderTable(rows, [
        { header: "ID", value: row => row.id as string, max: 40 }, { header: "STATUS", value: row => row.status as string },
        { header: "TITLE", value: row => (row.title ?? row.preview ?? row.summary) as string },
      ]) : "No missions.");
    }));

  action(transport(missions.command("start <prompt>").description("Create a mission, send the first prompt and print its ID")
    .option("--model <model>", "Model for this mission").option("--effort <level>", `Reasoning effort: ${EFFORTS.join(", ")}`)
    .option("--mode <mode>", `Autonomy mode: ${MODES.join(", ")}`).option("--folder <path>", "Folder the mission works in")
    .option("--target <target>", "Authorized target").option("--scope <path>", "Scope policy JSON file")
    .option("--title <title>", "Mission title").option("--wait", "Wait for the turn to finish and print the reply")
    .option("--timeout <seconds>", "Maximum seconds to wait with --wait", "600")),
    guarded(async (client, options, [prompt]) => {
      const flags = options as Options & { model?: string; effort?: string; mode?: string; folder?: string; target?: string; scope?: string; title?: string; wait?: boolean; timeout: string };
      const runtime = { ...(flags.model ? { model: flags.model } : {}), ...(flags.effort ? { reasoningEffort: flags.effort } : {}) };
      const config = {
        ...(Object.keys(runtime).length ? { runtime } : {}), ...(flags.mode ? { autonomyMode: flags.mode } : {}),
        ...(flags.target ? { target: flags.target } : {}), ...(flags.title ? { title: flags.title } : {}),
        ...(flags.scope ? { scope: JSON.parse(deps.readFile(flags.scope)) as unknown } : {}),
      };
      const created = asJson(asJson(await client.request("POST", "/api/console/sessions", config)).session);
      const id = String(created.id);
      try {
        if (flags.folder) await client.request("PATCH", `/api/console/sessions/${missionId(id)}/configuration`, { workspacePath: flags.folder });
        await client.request("POST", `/api/console/sessions/${missionId(id)}/messages`, { text: prompt });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} (mission ${id} was created; remove it with \`0 missions delete ${id} --yes\`)`);
      }
      if (!flags.wait) { print(options, { session: created }, id); return; }
      const deadline = Date.now() + Number(flags.timeout) * 1000;
      for (;;) {
        await deps.sleep(1000);
        const snapshot = asJson(asJson(await client.request("GET", `/api/console/sessions/${missionId(id)}`)).snapshot);
        const session = asJson(snapshot.session);
        const reply = lastAssistantText(snapshot);
        const finished = ["failed", "closed", "waiting"].includes(String(session.status)) || (session.status === "ready" && reply !== undefined);
        if (finished) {
          print(options, { session, ...(reply ? { reply } : {}) }, `${summarize(session)}${reply ? `\n\n${reply}` : ""}`);
          if (session.status === "failed") process.exitCode = 1;
          return;
        }
        if (Date.now() > deadline) throw new Error(`Timed out after ${flags.timeout}s; mission ${id} is still ${String(session.status)}.`);
      }
    }, (options, [prompt]) => {
      const flags = options as Options & { effort?: string; mode?: string; timeout?: string };
      if (!prompt?.trim()) throw new UsageError("Supply a prompt.");
      choice(flags.mode, MODES, "--mode"); choice(flags.effort, EFFORTS, "--effort");
      const seconds = Number(flags.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout must be a positive number of seconds.");
    }));

  action(transport(missions.command("stop <id>").description("Cancel a mission's active work").option("--force", "Force stop owned execution that did not drain")),
    guarded(async (client, options, [id]) => sessionPrint(options, await client.request("POST", `/api/console/sessions/${missionId(id!)}/${(options as { force?: boolean }).force ? "force-stop" : "cancel"}`, {})),
      (_options, [id]) => { missionId(id!); }));

  action(transport(missions.command("retry <id>").description("Re-run the last turn of a mission")),
    guarded(async (client, options, [id]) => sessionPrint(options, await client.request("POST", `/api/console/sessions/${missionId(id!)}/retry`, {})),
      (_options, [id]) => { missionId(id!); }));

  action(transport(missions.command("set <id>").description("Change a mission's model, effort, mode or folder")
    .option("--model <model>", "Model").option("--effort <level>", `Reasoning effort: ${EFFORTS.join(", ")}`)
    .option("--mode <mode>", `Autonomy mode: ${MODES.join(", ")}`).option("--folder <path>", "Folder the mission works in")),
    guarded(async (client, options, [id]) => {
      const flags = options as Options & { model?: string; effort?: string; mode?: string; folder?: string };
      const runtime = { ...(flags.model ? { model: flags.model } : {}), ...(flags.effort ? { reasoningEffort: flags.effort } : {}) };
      const body = { ...(Object.keys(runtime).length ? { runtime } : {}), ...(flags.mode ? { autonomyMode: flags.mode } : {}), ...(flags.folder ? { workspacePath: flags.folder } : {}) };
      sessionPrint(options, await client.request("PATCH", `/api/console/sessions/${missionId(id!)}/configuration`, body));
    }, (options, [id]) => {
      const flags = options as Options & { model?: string; effort?: string; mode?: string; folder?: string };
      missionId(id!);
      if (!flags.model && !flags.effort && !flags.mode && !flags.folder) throw new UsageError("Choose at least one of --model, --effort, --mode, --folder.");
      choice(flags.mode, MODES, "--mode"); choice(flags.effort, EFFORTS, "--effort");
    }));

  action(transport(missions.command("rename <id> [title]").description("Rename a mission, or regenerate its title").option("--regenerate", "Generate a new title from the conversation")),
    guarded(async (client, options, [id, title]) => {
      const regenerate = (options as { regenerate?: boolean }).regenerate;
      const value = regenerate
        ? await client.request("POST", `/api/console/sessions/${missionId(id!)}/title/regenerate`, {})
        : await client.request("PATCH", `/api/console/sessions/${missionId(id!)}/configuration`, { title });
      sessionPrint(options, value);
    }, (options, [id, title]) => {
      missionId(id!);
      if (Boolean((options as { regenerate?: boolean }).regenerate) === Boolean(title)) throw new UsageError("Supply either a new title or --regenerate.");
    }));

  action(transport(missions.command("clear <id>").description("Erase a mission's conversation but keep the mission").option("--yes", "Confirm the destructive action")),
    guarded(async (client, options, [id]) => sessionPrint(options, await client.request("POST", `/api/console/sessions/${missionId(id!)}/clear`, {})),
      (options, [id]) => { missionId(id!); requireYes(options, "Clearing a mission"); }));

  action(transport(missions.command("close <id>").description("Stop and close a live mission; its saved copy is kept")),
    guarded(async (client, options, [id]) => print(options, await client.request("DELETE", `/api/console/sessions/${missionId(id!)}`), `Closed ${id}`),
      (_options, [id]) => { missionId(id!); }));

  action(transport(missions.command("archive <id>").description("Archive a mission").option("--saved", "The ID is a retained snapshot, not a live mission")),
    guarded(async (client, options, [id]) => sessionPrint(options, await client.request("POST", `/api/console/${options.saved ? "saved" : "sessions"}/${missionId(id!)}/archive`, {})),
      (_options, [id]) => { missionId(id!); }));

  action(transport(missions.command("delete <id>").description("Permanently delete a mission").option("--saved", "The ID is a retained snapshot, not a live mission").option("--yes", "Confirm the destructive action")),
    guarded(async (client, options, [id]) => {
      const value = options.saved
        ? await client.request("DELETE", `/api/console/saved/${missionId(id!)}`)
        : await client.request("POST", `/api/console/sessions/${missionId(id!)}/delete`, {});
      print(options, value, `Deleted ${id}`);
    }, (options, [id]) => { missionId(id!); requireYes(options, "Deleting a mission"); }));

  action(transport(missions.command("export <id>").description("Export a mission transcript")
    .option("--saved", "The ID is a retained snapshot, not a live mission").option("--format <format>", "json or md", "json").option("-o, --output <file>", "Write to a file instead of stdout")),
    guarded(async (client, options, [id]) => {
      const flags = options as Options & { format: string; output?: string };
      const value = asJson(await client.request("GET", `/api/console/${options.saved ? "saved" : "sessions"}/${missionId(id!)}/export`));
      const text = flags.format === "md" ? String(value.text ?? "") : JSON.stringify(value, null, 2);
      if (flags.output) { deps.writeFile(flags.output, `${text}\n`); deps.err(`Wrote ${flags.output}`); } else deps.out(text);
    }, (options, [id]) => { missionId(id!); choice((options as { format?: string }).format, ["json", "md"], "--format"); }));
}
