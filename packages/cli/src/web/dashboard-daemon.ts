// Managed orchestrator daemon lifecycle controlled from the web console.
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { type DBWorkerRow } from "./dashboard-summaries.js";

type ManagedDaemonState = {
  child: ChildProcess;
  label: string;
};

let managedDaemon: ManagedDaemonState | null = null;

export function resolveCliEntrypoint(): string {
  return resolve(process.argv[1] ?? join(process.cwd(), "dist", "index.js"));
}

export function startManagedDaemon(args: {
  dbPath?: string;
  label: string;
  pollIntervalMs?: number;
}): { pid: number | null; label: string } {
  if (managedDaemon?.child.exitCode === null && !managedDaemon.child.killed) {
    return { pid: managedDaemon.child.pid ?? null, label: managedDaemon.label };
  }

  const cliEntrypoint = resolveCliEntrypoint();
  const childArgs = [
    cliEntrypoint,
    "runs",
    "orchestrate",
    "--watch",
    "--poll-interval",
    String(args.pollIntervalMs ?? 2000),
    "--label",
    args.label,
  ];

  if (args.dbPath) {
    childArgs.push("--db-path", args.dbPath);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: "ignore",
  });

  child.unref();
  managedDaemon = { child, label: args.label };
  child.once("exit", () => {
    if (managedDaemon?.child.pid === child.pid) {
      managedDaemon = null;
    }
  });

  return { pid: child.pid ?? null, label: args.label };
}

export function isLiveLocalPid(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ESRCH") return false;
    return true;
  }
}

export function stopDaemonWorkers(
  osecDb: typeof import("@0/engine/storage").osecDB,
  dbPath: string | undefined,
): number {
  const db = new osecDb(dbPath);

  try {
    const workers = db.listWorkers(100) as DBWorkerRow[];
    let stopped = 0;

    for (const worker of workers) {
      const heartbeatFresh = Date.now() - Date.parse(worker.heartbeatAt) < 20_000;
      if (worker.status === "stopped" || !heartbeatFresh) continue;

      if (worker.pid) {
        try {
          process.kill(worker.pid, "SIGTERM");
          stopped += 1;
        } catch {
          // Ignore already-exited or inaccessible processes.
        }
      }

      db.upsertWorker({
        id: worker.id,
        role: "orchestrator",
        status: "stopped",
        label: worker.label,
        currentCaseId: null,
        currentWorkItemId: null,
        currentScanId: null,
        pid: worker.pid ?? null,
        host: worker.host ?? null,
        lastError: worker.lastError?.trim() || "Stopped from dashboard control.",
      });
    }

    if (managedDaemon?.child.pid) {
      try {
        managedDaemon.child.kill("SIGTERM");
      } catch {
        // Ignore if already gone.
      }
      managedDaemon = null;
    }
    return stopped;
  } finally {
    db.close();
  }
}
