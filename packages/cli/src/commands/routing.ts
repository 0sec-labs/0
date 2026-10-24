import { readFileSync, writeFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import { LlmApiRuntime, parseRoutingQualificationPlan, qualifyTaskRouting, taskRoutingFixtureRuntime, createLocalOllamaRoutingRuntime } from "@0/core";

export function readRoutingJson(path: string): unknown {
  if (statSync(path).size > 2_000_000) throw new Error("routing input exceeds 2 MB limit");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function registerRoutingCommand(program: Command): void {
  program.command("routing-qualify")
    .description("Explicit offline synthetic task-routing qualification; fixture/local modes make no external API calls")
    .requiredOption("--plan <file>", "Reviewed qualification plan JSON with models and shared limits")
    .requiredOption("--out <file>", "Report JSON destination")
    .option("--allow-provider-calls", "Authorize API calls only for a model-api plan and its declared limits", false)
    .option("--regress-model <model>", "Fixture-only negative control: corrupt this model's validation state")
    .action(async opts => {
      const plan = parseRoutingQualificationPlan(readRoutingJson(opts.plan));
      if (plan.mode === "model-api" && !opts.allowProviderCalls) throw new Error("model-api qualification requires explicit --allow-provider-calls; no provider request sent");
      if (plan.mode !== "fixture" && opts.regressModel) throw new Error("negative control injection is fixture-only");
      const localRuntime = plan.mode === "local-model" ? createLocalOllamaRoutingRuntime(plan) : undefined;
      const runtime = localRuntime ?? (plan.mode === "fixture" ? taskRoutingFixtureRuntime(plan.models, opts.regressModel) : new LlmApiRuntime({ type: "api", timeout: plan.timeCapMs, model: plan.models[0], agentModels: Object.fromEntries(plan.models.map((model, index) => [`candidate-${index}`, model])) }));
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("operator cancelled qualification"));
      process.once("SIGINT", cancel);
      try {
        const report = await qualifyTaskRouting({ plan, runtime, signal: controller.signal });
        if (localRuntime) { const observation = await localRuntime.observation(); report.localRuntime = observation; report.externalApiFeeUsd = observation.externalApiFeeUsd; }
        writeFileSync(opts.out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
        console.log(`${report.mode}: ${report.status}; ${report.totalCalls} calls; estimated USD ${report.estimatedUsd ?? "unknown"}; external API fee ${report.externalApiFeeUsd ?? "unknown"}; compute cost unknown; actual provider charge unknown; report ${opts.out}`);
        if (report.status !== "completed-for-review") process.exitCode = 1;
      } finally { process.removeListener("SIGINT", cancel); }
    });
}
