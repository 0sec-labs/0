import { Command } from "commander";
import { LearningStore, learningProjectId } from "@0/db";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvolutionConfig, EvolutionRunResult } from "@0/core";
import { registerLearningCommand, type LearningCommandService } from "../learning.js";

let previousExitCode: typeof process.exitCode;
beforeEach(() => { previousExitCode = process.exitCode; process.exitCode = 0; });
afterEach(() => { process.exitCode = previousExitCode; });

function harness() {
  const service: LearningCommandService = {
    close: vi.fn(),
    status: vi.fn().mockResolvedValue({ candidates: [] }),
    processPending: vi.fn().mockResolvedValue({ processed: 1 }),
    mirrorEvolutionRun: vi.fn().mockResolvedValue({ candidates: ["candidate"] }),
  };
  const output: string[] = [];
  const errors: string[] = [];
  const config = { storePath: "/tmp/registry" } as EvolutionConfig;
  const result = { iterations: [], activeVersionId: "baseline", modelCostUsd: 0, evaluationCostUsd: 0 } satisfies EvolutionRunResult;
  const evolve = vi.fn().mockResolvedValue(result);
  const loadConfig = vi.fn().mockReturnValue(config);
  const program = new Command().exitOverride();
  registerLearningCommand(program, { createService: () => service, loadConfig, evolve, out: line => output.push(line), error: line => errors.push(line) });
  return { service, output, errors, config, result, evolve, loadConfig,
    invoke: (args: string[]) => program.parseAsync(["learning", ...args], { from: "user" }) };
}

describe("learning CLI", () => {
  it("normalizes real default-service path filters to captured workflow project identities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "learning-cli-project-"));
    const project = join(directory, "repo");
    mkdirSync(project);
    const projectId = learningProjectId(project);
    const databasePath = join(directory, "learning.sqlite");
    const store = new LearningStore(databasePath);
    store.recordExperience({ projectId, idempotencyKey: "workflow-path", kind: "workflow-run",
      outcome: "completed", summary: "A source workflow finished.", evidenceStrength: "operational" });
    store.recordExperience({ projectId: learningProjectId("other-project"), idempotencyKey: "workflow-other",
      kind: "workflow-run", outcome: "completed", summary: "Another workflow finished." });
    store.close();
    vi.stubEnv("ZERO_DB_PATH", databasePath);
    const output: string[] = [];
    const program = new Command().exitOverride();
    registerLearningCommand(program, { out: line => output.push(line) });
    try {
      await program.parseAsync(["learning", "status", "--project", project, "--json"], { from: "user" });
      expect(JSON.parse(output.pop()!)).toMatchObject({ events: 1, queue: { pending: 1 } });
      await program.parseAsync(["learning", "process", "--project", project, "--limit", "1", "--json"], { from: "user" });
      expect(JSON.parse(output.pop()!)).toMatchObject({ processed: 1, retried: 0 });
      await program.parseAsync(["learning", "status", "--project", projectId, "--json"], { from: "user" });
      expect(JSON.parse(output.pop()!)).toMatchObject({ events: 1, queue: { pending: 0, completed: 1 } });
      await program.parseAsync(["learning", "status", "--project", "other-project", "--json"], { from: "user" });
      expect(JSON.parse(output.pop()!)).toMatchObject({ events: 1, queue: { pending: 1, completed: 0 } });
      expect(process.exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("scopes status and pending processing to a project", async () => {
    const h = harness();
    await h.invoke(["status", "--project", "project", "--json"]);
    expect(h.service.status).toHaveBeenCalledWith("project");
    expect(h.service.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.output[0]!)).toEqual({ candidates: [] });
    await h.invoke(["process", "--project", "project", "--limit", "2", "--json"]);
    expect(h.service.processPending).toHaveBeenCalledWith({ projectId: "project", limit: 2 });
    expect(h.service.close).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid limits before processing", async () => {
    const h = harness();
    await h.invoke(["process", "--limit", "2x", "--json"]);
    expect(h.service.processPending).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(h.output[0]!).error).toMatch(/positive integer/);
  });

  it("runs the existing controller once and mirrors its actual result with output-fixture labeling", async () => {
    const h = harness();
    await h.invoke(["evolve", "--config", "config.json", "--project", "project", "--json"]);
    expect(h.loadConfig).toHaveBeenCalledWith("config.json");
    expect(h.evolve).toHaveBeenCalledTimes(1);
    expect(h.evolve).toHaveBeenCalledWith(h.config, { signal: expect.any(AbortSignal) });
    expect(h.service.mirrorEvolutionRun).toHaveBeenCalledWith("project", h.config, h.result);
    expect(JSON.parse(h.output[0]!)).toEqual({ evaluationKind: "output-fixture", result: h.result, learning: { candidates: ["candidate"] } });
    expect(process.exitCode).toBe(0);
    expect(h.service.close).toHaveBeenCalledOnce();
  });

  it("reconciles partial registry artifacts on a charged failure without retrying evolution", async () => {
    const h = harness();
    h.evolve.mockRejectedValue(new Error("provider charged; evaluation stopped"));
    await h.invoke(["evolve", "--config", "config.json", "--project", "project", "--json"]);
    expect(h.evolve).toHaveBeenCalledTimes(1);
    expect(h.service.mirrorEvolutionRun).toHaveBeenCalledWith("project", h.config);
    expect(JSON.parse(h.output[0]!).error).toBe("provider charged; evaluation stopped");
    expect(process.exitCode).toBe(2);
    expect(h.service.close).toHaveBeenCalledOnce();
  });

  it("does not run or mirror evolution when configuration validation fails", async () => {
    const h = harness();
    h.loadConfig.mockImplementation(() => { throw new Error("private configuration aliases source"); });
    await h.invoke(["evolve", "--config", "config.json", "--project", "project", "--json"]);
    expect(h.evolve).not.toHaveBeenCalled();
    expect(h.service.mirrorEvolutionRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("waits for interruption cleanup and removes listeners", async () => {
    const h = harness();
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let cleaned = false;
    h.evolve.mockImplementation(async (_config, { signal }: { signal: AbortSignal }) => {
      process.emit("SIGTERM");
      expect(signal.aborted).toBe(true);
      cleaned = true;
      throw new Error("cancelled");
    });
    await h.invoke(["evolve", "--config", "config.json", "--project", "project", "--json"]);
    expect(cleaned).toBe(true);
    expect(process.exitCode).toBe(3);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  it("reports mirror failures without rerunning a completed evolution", async () => {
    const h = harness();
    vi.mocked(h.service.mirrorEvolutionRun).mockRejectedValue(new Error("invalid registry receipt"));
    await h.invoke(["evolve", "--config", "config.json", "--project", "project", "--json"]);
    expect(h.evolve).toHaveBeenCalledTimes(1);
    expect(h.service.mirrorEvolutionRun).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(h.output[0]!).error).toBe("invalid registry receipt");
  });
});
