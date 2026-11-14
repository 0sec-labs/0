// Raw SQL schema creation and legacy-database migrations.
import { type ShimmedDatabase } from "./wasm-shim.js";
import { and, or } from "drizzle-orm";
import * as schema from "./schema.js";


// ── Raw SQL for table creation (idempotent, used on init) ──
//
// IMPORTANT: This SQL is generated from the drizzle schema in schema.ts.
// When adding or removing columns, update schema.ts first — that is the
// single source of truth — then mirror the change here.  The migrate()
// method below handles ALTER TABLE for databases created by older versions;
// fresh installs get every column from day one via this SQL.
//
// See: https://github.com/0sec-labs/0/issues/420

export const SCHEMA_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  depth TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'api',
  mode TEXT NOT NULL DEFAULT 'probe',
  status TEXT NOT NULL DEFAULT 'running',
  startedAt TEXT NOT NULL,
  completedAt TEXT,
  durationMs INTEGER,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'unknown',
  model TEXT,
  systemPrompt TEXT,
  detectedFeatures TEXT,
  endpoints TEXT,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  scanId TEXT NOT NULL REFERENCES scans(id),
  templateId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  fingerprint TEXT,
  triageStatus TEXT NOT NULL DEFAULT 'new',
  triageNote TEXT,
  triagedAt TEXT,
  workflowStatus TEXT NOT NULL DEFAULT 'backlog',
  workflowAssignee TEXT,
  workflowUpdatedAt TEXT,
  score INTEGER,
  confidence REAL,
  cvssVector TEXT,
  cvssScore REAL,
  evidenceRequest TEXT NOT NULL,
  evidenceResponse TEXT NOT NULL,
  evidenceAnalysis TEXT,
  layerVerdicts TEXT,
  impactAssessment TEXT,
  pocSteps TEXT,
  verificationSpec TEXT,
  pocExecution TEXT,
  semanticDedupe TEXT,
  findingRank INTEGER,
  verificationResult TEXT,
  reviewAnnotation TEXT,
  sourceVerification TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attack_results (
  id TEXT PRIMARY KEY,
  scanId TEXT NOT NULL REFERENCES scans(id),
  templateId TEXT NOT NULL,
  payloadId TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  latencyMs INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  findingId TEXT NOT NULL REFERENCES findings(id),
  agentRole TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  reasoning TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_events (
  id TEXT PRIMARY KEY,
  scanId TEXT NOT NULL REFERENCES scans(id),
  source TEXT NOT NULL DEFAULT 'core',
  stage TEXT NOT NULL,
  eventType TEXT NOT NULL,
  findingId TEXT,
  agentRole TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  scanId TEXT NOT NULL REFERENCES scans(id),
  agentRole TEXT NOT NULL,
  turnCount INTEGER NOT NULL DEFAULT 0,
  messages TEXT NOT NULL DEFAULT '[]',
  toolContext TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL UNIQUE,
  targetType TEXT NOT NULL DEFAULT 'unknown',
  latestScanId TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL REFERENCES cases(id),
  findingFingerprint TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  summary TEXT,
  dependsOn TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL REFERENCES cases(id),
  findingFingerprint TEXT,
  workItemId TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  content TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS triage_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_value TEXT,
  category TEXT NOT NULL,
  pattern TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  applied_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'orchestrator',
  status TEXT NOT NULL DEFAULT 'idle',
  label TEXT NOT NULL,
  currentCaseId TEXT,
  currentWorkItemId TEXT,
  currentScanId TEXT,
  pid INTEGER,
  host TEXT,
  lastError TEXT,
  heartbeatAt TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persistent_credentials (
  id TEXT PRIMARY KEY,
  credentialKind TEXT NOT NULL,
  valueHash TEXT NOT NULL,
  valuePreview TEXT NOT NULL,
  context TEXT,
  target TEXT,
  firstScanId TEXT,
  firstFindingId TEXT,
  firstSource TEXT,
  firstTurn INTEGER,
  lastScanId TEXT,
  timesSeen INTEGER NOT NULL DEFAULT 1,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  UNIQUE(credentialKind, valueHash)
);

CREATE TABLE IF NOT EXISTS trust_graph_edges (
  id TEXT PRIMARY KEY,
  srcKind TEXT NOT NULL,
  srcId TEXT NOT NULL,
  dstKind TEXT NOT NULL,
  dstId TEXT NOT NULL,
  relation TEXT NOT NULL,
  scanId TEXT,
  findingId TEXT,
  confidence REAL,
  note TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(srcKind, srcId, dstKind, dstId, relation)
);
`;


export const SCHEMA_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_findings_scanId ON findings(scanId);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(category);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(fingerprint);
CREATE INDEX IF NOT EXISTS idx_findings_priority_latest ON findings(COALESCE(fingerprint,id),timestamp DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_findings_triageStatus ON findings(triageStatus);
CREATE INDEX IF NOT EXISTS idx_findings_workflowStatus ON findings(workflowStatus);
CREATE INDEX IF NOT EXISTS idx_attack_results_scanId ON attack_results(scanId);
CREATE INDEX IF NOT EXISTS idx_targets_url ON targets(url);
CREATE INDEX IF NOT EXISTS idx_verdicts_findingId ON verdicts(findingId);
CREATE INDEX IF NOT EXISTS idx_events_scanId ON pipeline_events(scanId);
CREATE INDEX IF NOT EXISTS idx_events_stage ON pipeline_events(stage);
CREATE INDEX IF NOT EXISTS idx_events_findingId ON pipeline_events(findingId);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON pipeline_events(timestamp, id);
CREATE INDEX IF NOT EXISTS idx_scans_startedAt ON scans(startedAt);
CREATE INDEX IF NOT EXISTS idx_sessions_scanId ON agent_sessions(scanId);
CREATE INDEX IF NOT EXISTS idx_sessions_role ON agent_sessions(agentRole);
CREATE INDEX IF NOT EXISTS idx_cases_target ON cases(target);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_work_items_caseId ON work_items(caseId);
CREATE INDEX IF NOT EXISTS idx_work_items_fingerprint ON work_items(findingFingerprint);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_caseId ON artifacts(caseId);
CREATE INDEX IF NOT EXISTS idx_artifacts_fingerprint ON artifacts(findingFingerprint);
CREATE INDEX IF NOT EXISTS idx_artifacts_workItemId ON artifacts(workItemId);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON workers(heartbeatAt);
CREATE INDEX IF NOT EXISTS idx_memories_category ON triage_memories(category, scope);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON triage_memories(scope, scope_value);
CREATE INDEX IF NOT EXISTS idx_pcred_kind_hash ON persistent_credentials(credentialKind, valueHash);
CREATE INDEX IF NOT EXISTS idx_pcred_target ON persistent_credentials(target);
CREATE INDEX IF NOT EXISTS idx_pcred_kind ON persistent_credentials(credentialKind);
CREATE INDEX IF NOT EXISTS idx_tge_src ON trust_graph_edges(srcKind, srcId);
CREATE INDEX IF NOT EXISTS idx_tge_dst ON trust_graph_edges(dstKind, dstId);
CREATE INDEX IF NOT EXISTS idx_tge_relation ON trust_graph_edges(relation);
`;

/**
 * Upgrade databases created by older 0 versions.
 *
 * SCHEMA_TABLES_SQL (above) now contains every table and every column from
 * the drizzle schema, so fresh installs need no patching. This method only
 * runs idempotent ALTER TABLEs for databases that were created before the
 * corresponding columns/tables existed. Each guard is cheap (PRAGMA
 * table_info is cached by SQLite) and the ALTERs are no-ops when the
 * column is already present, so running on a fresh DB is harmless.
 *
 * See: https://github.com/0sec-labs/0/issues/420
 */
export function migrateLegacySchema(sqlite: ShimmedDatabase): void {
  const cols = sqlite
    .prepare("PRAGMA table_info(findings)")
    .all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  // v0.1 → v0.2: add score
  if (!colNames.has("score")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN score INTEGER");
  }
  // v0.2 → v0.3: add confidence, cvssVector, cvssScore
  if (!colNames.has("confidence")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN confidence REAL");
  }
  if (!colNames.has("cvssVector")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN cvssVector TEXT");
  }
  if (!colNames.has("cvssScore")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN cvssScore REAL");
  }
  if (!colNames.has("fingerprint")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN fingerprint TEXT");
  }
  if (!colNames.has("triageStatus")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN triageStatus TEXT NOT NULL DEFAULT 'new'");
  }
  if (!colNames.has("triageNote")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN triageNote TEXT");
  }
  if (!colNames.has("triagedAt")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN triagedAt TEXT");
  }
  // The column default fills every pre-existing row with 'backlog', so the
  // status-derived backfill below must run for rows when the column is added.
  const addedWorkflowStatus = !colNames.has("workflowStatus");
  if (addedWorkflowStatus) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN workflowStatus TEXT NOT NULL DEFAULT 'backlog'");
  }
  if (!colNames.has("workflowAssignee")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN workflowAssignee TEXT");
  }
  if (!colNames.has("workflowUpdatedAt")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN workflowUpdatedAt TEXT");
  }
  // 0#112 — per-layer triage telemetry. JSON-stringified LayerVerdict[].
  if (!colNames.has("layerVerdicts")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN layerVerdicts TEXT");
  }
  if (!colNames.has("impactAssessment")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN impactAssessment TEXT");
  }
  // 0#170 — proof-of-concept step graph. JSON-stringified PocStep[].
  if (!colNames.has("pocSteps")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN pocSteps TEXT");
  }
  // 0#193 — machine-executable verification contract. JSON-stringified
  // VerificationSpec. Optional/additive: legacy findings keep working.
  if (!colNames.has("verificationSpec")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN verificationSpec TEXT");
  }
  // 0#171 — captured PoC execution report. JSON-stringified
  // PocExecutionReport written by `disclose --target-url …` when the
  // behavioural re-verify runtime ran the step graph against a live
  // target. Optional/additive.
  if (!colNames.has("pocExecution")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN pocExecution TEXT");
  }
  // Post-process metadata is optional and additive. Persisting it lets later
  // scans use only prior canonical findings as semantic-dedupe anchors.
  if (!colNames.has("semanticDedupe")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN semanticDedupe TEXT");
  }
  if (!colNames.has("findingRank")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN findingRank INTEGER");
  }
  // Deterministic-replay result + scoped source reference. Both were
  // produced by the agent and consumed by the fix / disclosure gates but
  // never had a column, so every reload reported the finding as
  // unverified and un-scoped. Optional/additive: rows written before
  // these columns existed keep NULL, which hydrates as *absent* (never
  // as an empty object that could be mistaken for a real result).
  if (!colNames.has("verificationResult")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN verificationResult TEXT");
  }
  if (!colNames.has("reviewAnnotation")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN reviewAnnotation TEXT");
  }
  // This summary is code-only source evidence, not a deterministic replay
  // result. Older rows remain NULL and hydrate without the optional field.
  if (!colNames.has("sourceVerification")) {
    sqlite.exec("ALTER TABLE findings ADD COLUMN sourceVerification TEXT");
  }
  // Backfill NULL fingerprint / triageStatus / workflowStatus for rows
  // created before those columns existed.
  sqlite.exec("UPDATE findings SET fingerprint = id WHERE fingerprint IS NULL OR fingerprint = ''");
  sqlite.exec("UPDATE findings SET triageStatus = 'new' WHERE triageStatus IS NULL OR triageStatus = ''");
  sqlite.exec(`
    UPDATE findings
    SET workflowStatus = CASE
      WHEN workflowStatus IS NOT NULL AND workflowStatus != '' AND ${addedWorkflowStatus ? 0 : 1} THEN workflowStatus
      WHEN triageStatus = 'accepted' OR status = 'reported' THEN 'done'
      WHEN triageStatus = 'suppressed' OR status = 'false-positive' THEN 'cancelled'
      WHEN status IN ('verified', 'confirmed', 'scored') THEN 'human_review'
      ELSE 'backlog'
    END
  `);
  const eventCols = sqlite
    .prepare("PRAGMA table_info(pipeline_events)")
    .all() as { name: string }[];
  if (!new Set(eventCols.map((column) => column.name)).has("source")) {
    sqlite.exec("ALTER TABLE pipeline_events ADD COLUMN source TEXT NOT NULL DEFAULT 'core'");
  }
}
