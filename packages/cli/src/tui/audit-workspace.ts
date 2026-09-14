import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { homeStateDir } from "@0sec/shared";
import { appendTuiEvent } from "./tui-crash.js";
import type { ConsoleSession } from "@0sec/core";
import type { ChatScreenOptions, ChatScreenProps } from "./chat-screen.js";
import type { ConnectionRecovery } from "./connection-recovery.js";

export type AuditStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "stopped" | "stopping";
export interface AuditSummary {
  id: string;
  title: string;
  /** Current work, separate from the recognizable audit title. */
  activity?: string;
  status: AuditStatus;
  unread: boolean;
}
export type AuditTurnOutcome = "completed" | "failed" | "stopped" | "waiting";
export interface AuditActivity {
  waiting?: boolean;
  stopping?: boolean;
  workers?: number;
  outcome?: AuditTurnOutcome;
  title?: string;
  activity?: string;
}
type NextOptions = Pick<ChatScreenOptions, "model" | "providerId" | "agentModels" | "singleModel">;

export interface AuditRecord extends AuditSummary {
  readonly options: ChatScreenOptions | undefined;
  readonly sourceSessionId: string | undefined;
  /** Used only by MessagingRuntime; never an authentication or process HOME. */
  readonly messagingHomeDir: string;
  session: ConsoleSession | null;
  busy: boolean;
  waiting: boolean;
  stopping: boolean;
  workers: number;
  outcome: AuditTurnOutcome | undefined;
  nextOptions: NextOptions;
  recovery?: ConnectionRecovery;
  closeRequested: boolean;
  readonly submit: NonNullable<ChatScreenProps["submitHandle"]>;
  readonly stagePrompt: NonNullable<ChatScreenProps["stagePromptHandle"]>;
  readonly reconnect: NonNullable<ChatScreenProps["reconnectHandle"]>;
  readonly herd: NonNullable<ChatScreenProps["herdHandle"]>;
  readonly runtimeInfo: ChatScreenProps["runtimeInfoHandle"];
  readonly closeHandle: { current: (() => Promise<void>) | null };
  readonly onSessionChange: (session: ConsoleSession | null) => void;
  readonly onWorkingChange: (busy: boolean) => void;
  readonly onActivity: (activity: AuditActivity) => void;
  readonly onNextOptions: (selection: NextOptions) => void;
  /**
   * Live-apply a selection to this audit's RUNNING runtime when it has one,
   * reconfiguring in place at a turn boundary (no session teardown). Returns
   * false when no live session owns the runtime yet, so the caller keeps the
   * stage-for-next-audit fallback.
   */
  readonly applySelection: (selection: NextOptions) => boolean;
  closing: Promise<void> | undefined;
}

/** Owns audit identities and resources. Selection never changes runtime lifetime. */
export class AuditWorkspace {
  readonly protectedSessionIds = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #records: AuditRecord[] = [];
  #selectedId: string | undefined;
  #sequence = 0;

  constructor(initialOptions?: ChatScreenOptions) {
    this.create(initialOptions);
  }

  get records(): readonly AuditRecord[] { return this.#records; }
  get selectedId(): string | undefined { return this.#selectedId; }
  get selected(): AuditRecord | undefined { return this.get(this.#selectedId); }
  get(id: string | undefined): AuditRecord | undefined {
    return this.#records.find((record) => record.id === id);
  }
  findSession(id: string): AuditRecord | undefined {
    return this.#records.find((record) => record.session?.scanId === id || record.sourceSessionId === id);
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #emit(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch {
        // A subscriber cannot change resource ownership or starve other views.
      }
    }
  }
  #refreshStatus(record: AuditRecord): void {
    record.status = record.closing || record.stopping ? "stopping"
      : record.waiting ? "waiting"
      : record.busy || record.workers > 0 ? "running"
      : record.outcome ?? "idle";
  }
  #markUnread(record: AuditRecord): void {
    if (record.id !== this.#selectedId) record.unread = true;
  }
  #releaseProtection(id: string | undefined): void {
    if (id && !this.findSession(id)) this.protectedSessionIds.delete(id);
  }

  create(options?: ChatScreenOptions, sourceSessionId?: string, select = true): AuditRecord {
    const id = randomUUID();
    const record: AuditRecord = {
      closeRequested: false,
      id,
      title: options?.target || `Audit ${++this.#sequence}`,
      status: "idle",
      unread: false,
      options,
      sourceSessionId,
      messagingHomeDir: join(homeStateDir(), "audit-messaging", id),
      session: null,
      busy: false,
      waiting: false,
      stopping: false,
      workers: 0,
      outcome: undefined,
      nextOptions: {},
      submit: { current: null },
      stagePrompt: { current: null },
      reconnect: { current: null },
      herd: { current: null },
      runtimeInfo: { current: null },
      closeHandle: { current: null },
      closing: undefined,
      onSessionChange: (session) => this.#bindSession(id, session),
      onWorkingChange: (busy) => this.#setBusy(id, busy),
      onActivity: (activity) => this.update(id, activity),
      onNextOptions: (selection) => this.stageOptions(id, selection),
      applySelection: (selection) => this.#applyLiveSelection(id, selection),
    };
    this.#records = [...this.#records, record];
    if (sourceSessionId) this.protectedSessionIds.add(sourceSessionId);
    if (select) this.#selectedId = id;
    this.#emit();
    return record;
  }

  select(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    if (this.#selectedId === id && !record.unread) return true;
    this.#selectedId = id;
    record.unread = false;
    this.#emit();
    return true;
  }

  #bindSession(id: string, session: ConsoleSession | null): void {
    const record = this.get(id);
    if (!record || record.closeRequested || record.session === session) return;
    const previousId = record.session?.scanId;
    record.session = session;
    if (session) this.protectedSessionIds.add(session.scanId);
    this.#releaseProtection(previousId);
    this.#emit();
  }
  #setBusy(id: string, busy: boolean): void {
    const record = this.get(id);
    if (!record || record.busy === busy) return;
    record.busy = busy;
    if (busy) record.outcome = undefined;
    this.#refreshStatus(record);
    this.#markUnread(record);
    this.#emit();
  }
  update(id: string, activity: AuditActivity): void {
    const record = this.get(id);
    if (!record) return;
    let changed = false;
    if (activity.waiting !== undefined && activity.waiting !== record.waiting) {
      record.waiting = activity.waiting;
      changed = true;
    }
    if (activity.stopping !== undefined && activity.stopping !== record.stopping) {
      record.stopping = activity.stopping;
      changed = true;
    }
    if (activity.workers !== undefined && activity.workers !== record.workers) {
      record.workers = activity.workers;
      changed = true;
    }
    if (activity.outcome !== undefined && activity.outcome !== record.outcome) {
      record.outcome = activity.outcome;
      changed = true;
    }
    if (activity.title !== undefined && activity.title !== record.title) {
      record.title = activity.title;
      changed = true;
    }
    if (activity.activity !== undefined && activity.activity !== record.activity) {
      record.activity = activity.activity;
      changed = true;
    }
    const unread = record.unread;
    this.#markUnread(record);
    this.#refreshStatus(record);
    if (changed || unread !== record.unread) this.#emit();
  }
  /** Consume setup choices once, before any ChatScreen owns this audit. */
  applyInitialChoices(id: string): boolean {
    const record = this.get(id);
    if (!record || record.session || record.closeHandle.current || record.closeRequested) return false;
    this.#records = this.#records.map((item) => item.id === id
      ? { ...item, options: { ...item.options, ...item.nextOptions }, nextOptions: {} }
      : item);
    this.#emit();
    return true;
  }

  /**
   * Reconfigure the audit's live runtime in place, when a ChatScreen has bound
   * its runtime handle. Selection never changes runtime lifetime; a busy turn
   * is handled by the handle (deferred to the turn boundary), so this stays a
   * pure dispatch. Returns false when the audit has no live runtime yet.
   */
  #applyLiveSelection(id: string, selection: NextOptions): boolean {
    const record = this.get(id);
    if (!record || record.closeRequested || !record.session) return false;
    const apply = record.runtimeInfo.current?.applySelection;
    if (!apply) return false;
    apply(selection);
    return true;
  }

  stageOptions(id: string, selection: NextOptions): void {
    const record = this.get(id);
    if (!record || record.closeRequested) return;
    record.nextOptions = {
      ...record.nextOptions,
      ...selection,
      ...(selection.agentModels ? { agentModels: { ...selection.agentModels } } : {}),
    };
    this.#emit();
  }

  close(id: string): Promise<void> {
    const record = this.get(id);
    if (!record) return Promise.resolve();
    if (record.closing) return record.closing;
    record.closeRequested = true;
    // Defer execution until closing/status are published, including synchronous
    // close callbacks. The record and its history stay protected until settled.
    record.closing = Promise.resolve().then(async () => {
      const t0 = Date.now();
      const via = record.closeHandle.current ? "closeHandle" : record.session ? "session" : "mcp";
      appendTuiEvent({ kind: "audit-close", stage: "begin", id, via });
      if (record.closeHandle.current) await record.closeHandle.current();
      else if (record.session) {
        await record.session.stopPersistentAgents();
        appendTuiEvent({ kind: "audit-close", stage: "agents-stopped", id, ms: Date.now() - t0 });
        await record.session.cleanup();
      } else {
        await record.options?.mcpHost?.closeAll();
      }
      appendTuiEvent({ kind: "audit-close", stage: "session-closed", id, via, ms: Date.now() - t0 });
      await rm(record.messagingHomeDir, { recursive: true, force: true });
      appendTuiEvent({ kind: "audit-close", stage: "done", id, ms: Date.now() - t0 });
      this.#records = this.#records.filter((entry) => entry !== record);
      this.#releaseProtection(record.sourceSessionId);
      this.#releaseProtection(record.session?.scanId);
      if (this.#selectedId === id) {
        const selected = this.#records[0];
        this.#selectedId = selected?.id;
        if (selected) selected.unread = false;
      }
      this.#emit();
    }).catch((error: unknown) => {
      record.closing = undefined;
      record.outcome = "failed";
      this.#refreshStatus(record);
      this.#emit();
      throw error;
    });
    this.#refreshStatus(record);
    this.#emit();
    return record.closing;
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(this.#records.map((record) => this.close(record.id)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "Could not close every audit");
  }
}
