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
