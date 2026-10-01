import type { Command } from "commander";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { EvolutionConfig, EvolutionDependencies, EvolutionRunResult } from "@0/core";
import { loadEvolutionConfigFile, runEvolution } from "@0/core";

/** All evaluation and lifecycle authority stays in the core service/registry. */
export interface LearningCommandService {
  close?(): void;
  status(projectId?: string): unknown | Promise<unknown>;
  processPending(options: { projectId?: string; limit?: number }): unknown | Promise<unknown>;
  mirrorEvolutionRun(projectId: string, config: EvolutionConfig, result?: EvolutionRunResult): unknown | Promise<unknown>;
}

export interface LearningCommandDependencies {
  createService?: () => LearningCommandService | Promise<LearningCommandService>;
  loadConfig?: typeof loadEvolutionConfigFile;
  evolve?: (config: EvolutionConfig, dependencies?: EvolutionDependencies) => Promise<EvolutionRunResult>;
  out?: (line: string) => void;
  error?: (line: string) => void;
}

async function defaultService(): Promise<LearningCommandService> {
  const { LearningService, HuntMemoryStore } = await import("@0/core");
  const { LearningStore, learningProjectId } = await import("@0/db");
  const store = new LearningStore();
  const service = new LearningService(store);
  const project = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value) ? value : learningProjectId(value);
  return {
    status: projectId => service.status(projectId === undefined ? undefined : project(projectId)),
    processPending: options => {
      const selected = options.projectId;
      if (selected && !/^(1|true)$/i.test(process.env["ZERO_DISABLE_HUNT_MEMORY"] ?? "")) {
        const source = selected.startsWith("source:") ? selected.slice(7) : selected;
        if (isAbsolute(source) || /^\.{1,2}\//.test(source) || source.startsWith("~/")) {
          // Explicit local project selection imports only already-retained, current notes.
          let root: string | undefined;
          try { root = realpathSync(source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : source); } catch { /* No current local source context. */ }
          if (root) service.importCodebaseNotes(project(selected), root, new HuntMemoryStore());
        }
      }
      return service.processPending({ ...options, projectId: selected === undefined ? undefined : project(selected) });
    },
    mirrorEvolutionRun: (projectId, config, result) => service.mirrorEvolutionRun(project(projectId), config, result),
    close: () => store.close(),
  };
}

export function registerLearningCommand(program: Command, deps: LearningCommandDependencies = {}): void {
  const out = deps.out ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const service = deps.createService ?? defaultService;
  const learning = program.command("learning").description("Inspect and process evidence-backed workflow learning");
  const render = (value: unknown, json?: boolean) => out(JSON.stringify(value, null, json ? 2 : undefined));
  const fail = (failure: unknown, json?: boolean, interrupted = false) => {
    const message = failure instanceof Error ? failure.message : String(failure);
    if (json) render({ error: message }, true);
    else error(`Learning failed: ${message}`);
    process.exitCode = interrupted ? 3 : 2;
  };

  learning.command("status").description("Show learning observations, candidates, and evaluations")
    .option("--project <id>", "Filter by project")
    .option("--json", "Output structured JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      let instance: LearningCommandService | undefined;
      try { instance = await service(); render(await instance.status(options.project), options.json); process.exitCode = 0; }
      catch (failure) { fail(failure, options.json); }
      finally { instance?.close?.(); }
    });

  learning.command("process").description("Process pending observations using the configured learning service")
    .option("--project <id>", "Filter by project")
    .option("--limit <number>", "Maximum observations to process", Number)
    .option("--json", "Output structured JSON")
    .action(async (options: { project?: string; limit?: number; json?: boolean }) => {
      let instance: LearningCommandService | undefined;
      try {
        if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
          throw new Error("--limit must be a positive integer");
        }
        instance = await service();
        render(await instance.processPending({ projectId: options.project, limit: options.limit }), options.json);
        process.exitCode = 0;
      } catch (failure) { fail(failure, options.json); }
      finally { instance?.close?.(); }
    });

  learning.command("evolve").description("Run evolution and retain registry-backed output-fixture evaluation provenance")
    .requiredOption("--config <path>", "Evolution config JSON file")
    .requiredOption("--project <id>", "Project associated with the evolution artifacts")
    .option("--json", "Output structured JSON")
    .action(async (options: { config: string; project: string; json?: boolean }) => {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      let config: EvolutionConfig | undefined;
      let learningService: LearningCommandService | undefined;
      let evolutionCompleted = false;
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        config = (deps.loadConfig ?? loadEvolutionConfigFile)(options.config);
        learningService = await service();
        const result = await (deps.evolve ?? runEvolution)(config, { signal: controller.signal });
        evolutionCompleted = true;
        const mirrored = await learningService.mirrorEvolutionRun(options.project, config, result);
        render({ evaluationKind: "output-fixture", result, learning: mirrored }, options.json);
        process.exitCode = controller.signal.aborted ? 3 : 0;
      } catch (failure) {
        // A failed run can already have produced charged, evaluated versions.
        // Reconcile those real registry artifacts without rerunning the model.
        if (config && learningService && !evolutionCompleted) {
          try { await learningService.mirrorEvolutionRun(options.project, config); }
          catch (mirrorFailure) { error(`Learning provenance reconciliation failed: ${mirrorFailure instanceof Error ? mirrorFailure.message : String(mirrorFailure)}`); }
        }
        fail(failure, options.json, controller.signal.aborted);
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        learningService?.close?.();
      }
    });
}
