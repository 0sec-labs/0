export type InstallKind = "binary" | "docker" | "npm" | "source";
export type UpdatePhase = "idle" | "installing" | "staged" | "restarting";
export interface UpdateStatus {
  current: string; latest: string; url: string;
  install: { kind: InstallKind; managed: boolean };
  /** The server can replace its own program and restart. */
  canApply: boolean;
  phase: UpdatePhase;
  threadsRunning: number;
  supervised: boolean;
  serverMode: boolean;
}

const KINDS: readonly InstallKind[] = ["binary", "docker", "npm", "source"];
const PHASES: readonly UpdatePhase[] = ["idle", "installing", "staged", "restarting"];

/** Normalize GET /api/console/update-status. Anything malformed or not newer yields null (no card). An older server (no install field) is treated as one this console cannot update. */
export function normalizeUpdateStatus(raw: unknown): UpdateStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.available !== true || typeof value.latest !== "string" || typeof value.current !== "string") return null;
  if (!/^\d+\.\d+\.\d+$/.test(value.latest)) return null;
  const url = typeof value.url === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases(?:\/|$)/.test(value.url) ? value.url : null;
  if (!url) return null;
  const install = value.install && typeof value.install === "object" ? value.install as Record<string, unknown> : {};
  const kind = KINDS.find(entry => entry === install.kind) ?? "binary";
  const managed = install.managed === true && kind === "binary";
  const phase = PHASES.find(entry => entry === value.phase) ?? "idle";
  return {
    current: value.current, latest: value.latest, url, install: { kind, managed },
    canApply: managed && value.canApply === true, phase,
    threadsRunning: typeof value.threadsRunning === "number" && value.threadsRunning > 0 ? Math.floor(value.threadsRunning) : 0,
    supervised: value.supervised === true, serverMode: value.serverMode === true,
  };
}

/** A dismissal covers one version; the next release shows the card again. */
export function showUpdateCard(status: UpdateStatus | null, dismissedVersion: string): status is UpdateStatus {
  return status !== null && status.latest !== dismissedVersion;
}

export const UPDATE_COMMAND = "0 doctor upgrade";
export const DOCKER_UPDATE_COMMAND = "docker pull ghcr.io/0sec-labs/0security:latest";
export const SOURCE_UPDATE_COMMAND = "git pull";
export const NPM_UPDATE_COMMAND = "npm uninstall -g 0sec-cli && curl -fsSL https://raw.githubusercontent.com/0sec-labs/0security/main/install.sh | bash";

/** What a card that cannot update itself tells the person to run, per install kind. */
export function updateCommandFor(kind: InstallKind): string {
  return kind === "docker" ? DOCKER_UPDATE_COMMAND : kind === "source" ? SOURCE_UPDATE_COMMAND : kind === "npm" ? NPM_UPDATE_COMMAND : UPDATE_COMMAND;
}

export interface UpdateCardUi {
  /** The person clicked Update and the server answered that threads are running. */
  confirmThreads: number | null;
  /** A request is in flight, or the server accepted it and is restarting. */
  working: "updating" | "restarting" | null;
  failure?: string;
}

export type UpdateCardAction =
  | { kind: "apply"; label: string }
  | { kind: "busy"; label: string }
  | { kind: "confirm"; message: string; wait: string; anyway: string }
  | { kind: "copy"; label: string; command: string; note?: string };

export interface UpdateCardView { title: string; detail: string; action: UpdateCardAction; failure?: string }

const plural = (count: number) => `${count} ${count === 1 ? "thread is" : "threads are"} running.`;

/** Everything the card shows, decided in one place so each install kind is testable without a browser. */
export function updateCardView(status: UpdateStatus, ui: UpdateCardUi): UpdateCardView {
  const staged = status.phase === "staged";
  const title = staged ? `Ready to restart · ${status.latest}` : `Update available · ${status.latest}`;
  const failure = ui.failure;
  if (!status.canApply) {
    const note = status.install.kind === "docker" ? "Docker images are replaced, not changed in place. Pull the new image and recreate the container."
      : status.install.kind === "npm" ? "Installed with npm, which is no longer updated. Move to the standalone install."
      : status.install.kind === "source" ? "Running from a source checkout. Pull, then rebuild."
      : undefined;
    return { title, detail: `You have ${status.current}`, action: { kind: "copy", label: "Copy update command", command: updateCommandFor(status.install.kind), ...(note ? { note } : {}) } };
  }
  const detail = staged ? `${status.latest} is installed. Restart to use it.` : `You have ${status.current}`;
  if (ui.working === "restarting" || status.phase === "restarting") return { title, detail, action: { kind: "busy", label: "Restarting…" }, ...(failure ? { failure } : {}) };
  if (ui.working === "updating" || status.phase === "installing") return { title, detail, action: { kind: "busy", label: "Updating…" } };
  if (ui.confirmThreads !== null) return { title, detail, action: { kind: "confirm", message: plural(ui.confirmThreads), wait: "Update after they finish", anyway: "Update anyway" } };
  return { title, detail, action: { kind: "apply", label: staged ? "Restart to finish updating" : "Update and restart" }, ...(failure ? { failure } : {}) };
}

/** Where the page remembers it asked for an update, so it can report the result after the server restarts (even after a reload). */
export const PENDING_UPDATE_KEY = "0-update-pending";
export interface PendingUpdate { version: string; startedAt: number; supervised: boolean }
export const PENDING_UPDATE_MAX_MS = 5 * 60_000;

export function parsePendingUpdate(raw: string | null, now: number): PendingUpdate | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingUpdate>;
    if (typeof value.version !== "string" || typeof value.startedAt !== "number" || now - value.startedAt > PENDING_UPDATE_MAX_MS) return null;
    return { version: value.version, startedAt: value.startedAt, supervised: value.supervised === true };
  } catch { return null; }
}

/** Reconnect check while the server restarts: done once the server reports the version we asked for (or newer). */
export function updateFinished(pending: PendingUpdate, current: string | null): boolean {
  if (!current) return false;
  const parse = (v: string) => v.split(".").map(part => Number(part) || 0);
  const a = parse(current), b = parse(pending.version);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

/** The running version from a raw update-status answer, whether or not an update is available. */
export function currentVersionOf(raw: unknown): string | null {
  const current = raw && typeof raw === "object" ? (raw as Record<string, unknown>).current : undefined;
  return typeof current === "string" && /^\d+\.\d+\.\d+/.test(current) ? current : null;
}
