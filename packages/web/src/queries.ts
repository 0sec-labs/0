/**
 * The query-key factory. Every key is `[name, ...scope]`, exactly the arrays the app has always used, so persisted caches
 * (lib/query-persist.ts) and prefix invalidation keep working: `queryKeys.consoleSessions()` is a prefix of
 * `queryKeys.consoleSessions(backendId)`. Add new keys here, not as inline arrays.
 */
type Part = string | number | boolean | null | undefined;

const key = <const N extends string>(name: N) => <const P extends readonly Part[]>(...scope: P) => [name, ...scope] as const;

export const queryKeys = {
  // Dashboard, runs and scans
  dashboard: key("dashboard"),
  chatFindings: key("chat-findings"),
  runs: key("runs"),
  scans: key("scans"),
  scanEvents: key("scan-events"),
  scanFindings: key("scan-findings"),
  scanResume: key("scan-resume"),
  findingFamily: key("finding-family"),
  findingFixes: key("finding-fixes"),
  panelFixes: key("panel-fixes"),
  selfEditEnabled: key("self-edit-enabled"),
  browserViews: key("browser-views"),
  // Chats
  consoleSessions: key("console-sessions"),
  consoleSaved: key("console-saved"),
  consoleControlSession: key("console-control-session"),
  consoleSessionTools: key("console-session-tools"),
  consoleWorker: key("console-worker"),
  consoleConnectionHealth: key("console-connection-health"),
  consoleModelSourceHealth: key("console-model-source-health"),
  consoleSettings: key("console-settings"),
  savedTranscript: key("saved-transcript"),
  chatHomeProject: key("chat-home-project"),
  setupSession: key("setup-session"),
  // Connections, tools and settings
  consoleProviders: key("console-providers"),
  consoleModels: key("console-models"),
  consoleConnections: key("console-connections"),
  consoleConnectionUsage: key("console-connection-usage"),
  consoleTools: key("console-tools"),
  consolePlugins: key("console-plugins"),
  consoleServicePlugins: key("console-service-plugins"),
  consoleGithubPublication: key("console-github-publication"),
  consoleExecution: key("console-execution"),
  consoleProject: key("console-project"),
  consoleChecks: key("console-checks"),
  consoleDoctor: key("console-doctor"),
  consoleLearning: key("console-learning"),
  settingsUsage: key("settings-usage"),
  skills: key("skills"),
  skill: key("skill"),
  // Automations
  workflowDefinitions: key("workflow-definitions"),
  workflowVersions: key("workflow-versions"),
  suggestionVersions: key("suggestion-versions"),
  workflowTriggers: key("workflow-triggers"),
  workflowTriggerSessions: key("workflow-trigger-sessions"),
  workflowExecutions: key("workflow-executions"),
  workflowToolCatalog: key("workflow-tool-catalog"),
  consoleWorkflows: key("console-workflows"),
  consoleWorkflow: key("console-workflow"),
  // Engagements, workers and team
  engagements: key("engagements"),
  engagementRuns: key("engagement-runs"),
  engagementChatTitles: key("engagement-chat-titles"),
  engagementReport: key("engagement-report"),
  workerHosts: key("worker-hosts"),
  workerBackends: key("worker-backends"),
  managedWorkers: key("managed-workers"),
  teamSession: key("team-session"),
  teamUsers: key("team-users"),
  teamWorkspacePresence: key("team-workspace-presence"),
  // Hosts
  chatHostHandshake: key("chat-host-handshake"),
  hostSidebarConnection: key("host-sidebar-connection"),
  hostSidebarChats: key("host-sidebar-chats"),
} as const;
