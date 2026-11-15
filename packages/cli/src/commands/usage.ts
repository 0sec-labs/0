// `0 models usage` — spend and tokens of the open missions, as on the web Settings > Usage page.
// Only a running engine tracks open missions; without one the report is empty.
import type { Command } from "commander";
import { exitWhenDone, UsageError, expectOk, printJson, renderTable, runConsoleCommand, type ConsoleCommandDeps, type JsonOption } from "./console-support.js";

interface Row { id: string; title: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null }
const MAX_MISSIONS = 50;
const money = (value: number | null) => value === null ? "-" : `$${value.toFixed(4)}`;
const sum = (rows: Row[]) => { const priced = rows.filter(r => r.costUsd !== null); return { missions: rows.length, tokens: rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0), costUsd: priced.length ? priced.reduce((n, r) => n + r.costUsd!, 0) : null }; };

export function runUsage(options: JsonOption & { by?: string }, deps: ConsoleCommandDeps = {}) {
  return runConsoleCommand(options, deps, async (client, io) => {
    const by = options.by ?? "model";
    if (by !== "model" && by !== "mission") throw new UsageError("--by must be model or mission.");
    const list = client.mode === "attached" ? (expectOk(await client.request("GET", "/api/console/sessions")).sessions as { id: string; title?: string }[]).slice(0, MAX_MISSIONS) : [];
    const rows: Row[] = [];
    for (const session of list) {
      const result = await client.request("GET", `/api/console/sessions/${encodeURIComponent(session.id)}?window=1`);
      if (result.status >= 400) continue;
      const snapshot = result.data.snapshot;
      const usage = snapshot.usage ?? {};
      if (!((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))) continue;
      rows.push({ id: session.id, title: snapshot.title || session.title || "Untitled", model: snapshot.runtime?.model ?? "Unknown model", inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, costUsd: usage.costUnavailable ? null : usage.costUsd ?? null });
    }
    const totals = sum(rows);
    const models = [...new Set(rows.map(r => r.model))].map(model => ({ model, ...sum(rows.filter(r => r.model === model)) }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens);
    if (options.json) return printJson(io, { by, totals, ...(by === "model" ? { models } : { missions: rows }), source: client.mode === "attached" ? "running engine" : "none" });
    if (client.mode !== "attached") io.out("No running engine: open missions are only tracked by a running 0 engine (`0 dashboard`).");
    else if (!rows.length) io.out("No missions have used tokens yet.");
    else {
      io.out(by === "model"
        ? renderTable(["MODEL", "MISSIONS", "TOKENS", "COST"], models.map(g => [g.model, String(g.missions), String(g.tokens), money(g.costUsd)]))
        : renderTable(["MISSION", "TITLE", "MODEL", "TOKENS", "COST"], rows.map(r => [r.id, r.title, r.model, String(r.inputTokens + r.outputTokens), money(r.costUsd)])));
      io.out(`Total: ${totals.tokens} tokens, ${money(totals.costUsd)} across ${totals.missions} missions.`);
    }
  });
}

export function registerUsageCommand(program: Command, deps: ConsoleCommandDeps = {}): void {
  program.command("usage").description("Show spend and tokens of the open missions, by model or by mission")
    .option("--by <model|mission>", "Group by model (default) or list each mission")
    .option("--json", "Print JSON")
    .action((o: JsonOption & { by?: string }) => exitWhenDone(runUsage(o, deps)));
}
