import type { ShimmedDatabase } from "../wasm-shim.js";
import type { osecDB } from "../database.js";
import { Repository, type OsecDrizzle } from "./base.js";
import { TriageMemoryRepository } from "./triage-memory-repository.js";
import { CaseGraphRepository } from "./case-graph-repository.js";
import { CaseWorkRepository } from "./case-work-repository.js";
import { ScanRepository } from "./scan-repository.js";
import { TargetRepository } from "./target-repository.js";
import { FindingRepository } from "./finding-repository.js";
import { VerificationRepository } from "./verification-repository.js";
import { PipelineRepository } from "./pipeline-repository.js";
import { WorkerRepository } from "./worker-repository.js";
import { TrustRepository } from "./trust-repository.js";

export type { OsecDrizzle };
export { Repository };

export interface Repositories {
  triageMemories: TriageMemoryRepository;
  caseGraph: CaseGraphRepository;
  caseWork: CaseWorkRepository;
  scans: ScanRepository;
  targets: TargetRepository;
  findings: FindingRepository;
  verification: VerificationRepository;
  pipeline: PipelineRepository;
  workers: WorkerRepository;
  trust: TrustRepository;
}

/** Build every aggregate repository over one open database connection. */
export function createRepositories(sqlite: ShimmedDatabase, db: OsecDrizzle, owner: osecDB): Repositories {
  const repos = {} as Repositories;
  Object.assign(repos, {
    triageMemories: new TriageMemoryRepository(sqlite, db, repos, owner),
    caseGraph: new CaseGraphRepository(sqlite, db, repos, owner),
    caseWork: new CaseWorkRepository(sqlite, db, repos, owner),
    scans: new ScanRepository(sqlite, db, repos, owner),
    targets: new TargetRepository(sqlite, db, repos, owner),
    findings: new FindingRepository(sqlite, db, repos, owner),
    verification: new VerificationRepository(sqlite, db, repos, owner),
    pipeline: new PipelineRepository(sqlite, db, repos, owner),
    workers: new WorkerRepository(sqlite, db, repos, owner),
    trust: new TrustRepository(sqlite, db, repos, owner),
  });
  return repos;
}
