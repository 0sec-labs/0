import { spawnSync } from "node:child_process";
import { maybeLoadCodexAuth } from "../codex-auth.js";
import {
  startCodexDeviceAuth,
  type CodexDeviceAuthSession,
  type CodexDeviceAuthUpdate,
  type StartCodexDeviceAuthOptions,
} from "../tui/codex-device-auth.js";
import type { DesktopCodexAuthStatus } from "@0/shared";

export interface CodexAuthControllerOptions {
  start?: (options: StartCodexDeviceAuthOptions) => CodexDeviceAuthSession;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  probe?: (env: NodeJS.ProcessEnv) => boolean;
}

export interface WebAuthStatus extends DesktopCodexAuthStatus {
  verificationUrl: string | null;
  userCode: string | null;
  available: boolean;
}

export function webAuthStatus(status: DesktopCodexAuthStatus, available = true): WebAuthStatus {
  const text = status.lines.join("\n");
  const candidate = text.match(/https:\/\/[^\s<>"\x1b]+/)?.[0]?.replace(/[),.;]+$/, "");
  let verificationUrl: string | null = null;
  if (candidate) {
    try {
      const url = new URL(candidate);
      const allowedHost = [
        "auth.openai.com", "x.ai", "kimi.com", "github.com", "openrouter.ai", "accounts.google.com",
      ].includes(url.hostname) || url.hostname.endsWith(".kimi.com") || url.hostname.endsWith(".x.ai");
      const containsCredential = ["access_token", "refresh_token", "id_token", "api_key"].some((key) => url.searchParams.has(key));
      if (!url.username && !url.password && allowedHost && !containsCredential) verificationUrl = url.href;
    } catch { /* Untrusted provider output is never an arbitrary navigation destination. */ }
  }
  const userCode = text.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0]
    ?? text.match(/(?:code[:\s]+)([A-Z0-9]{4,12})\b/i)?.[1] ?? null;
  return { ...status, lines: [...status.lines], verificationUrl, userCode, available };
}

/**
 * Daemon-owned adapter for Codex's official device OAuth flow. The browser
 * renderer sees phase/status text only; the Codex CLI writes and 0 reads the
 * auth file inside the daemon process, so OAuth tokens never cross this API.
 */
export class CodexAuthController {
  readonly #start: (options: StartCodexDeviceAuthOptions) => CodexDeviceAuthSession;
  readonly #env: NodeJS.ProcessEnv;
  readonly #homeDir: string | undefined;
  readonly #probe: (env: NodeJS.ProcessEnv) => boolean;
  #status: DesktopCodexAuthStatus = { phase: "idle", message: "ChatGPT Codex is not connected.", lines: [] };
  #session: CodexDeviceAuthSession | null = null;

  constructor(options: CodexAuthControllerOptions = {}) {
    this.#start = options.start ?? startCodexDeviceAuth;
    this.#env = { ...(options.env ?? process.env) };
    this.#homeDir = options.homeDir;
    this.#probe = options.probe ?? ((env) => {
      const result = spawnSync("codex", ["--version"], { env, stdio: "ignore", timeout: 5_000 });
      return !result.error && result.status === 0;
    });
  }

  status(): WebAuthStatus {
    if (this.#status.phase === "running") return webAuthStatus(this.#status);
    const env = { ...this.#env };
    maybeLoadCodexAuth({ env, home: this.#homeDir, force: true });
    const connected = Boolean(env.ZERO_CHATGPT_ACCESS_TOKEN?.trim() || env.ZERO_CHATGPT_OAUTH_REFRESH_TOKEN?.trim());
    const available = this.#probe(env);
    if (connected) return webAuthStatus({
      phase: "connected", message: "ChatGPT Codex subscription credentials are configured.", lines: [],
    }, available);
    if (!available) return webAuthStatus({
      phase: "unavailable",
      message: "Official Codex sign-in is unavailable because the Codex executable is not installed or cannot run. You can connect a supported API provider in this browser instead.",
      lines: [],
    }, false);
    return webAuthStatus(this.#status, true);
  }

  start(): WebAuthStatus {
    if (this.#status.phase === "running") return this.status();
    this.#session = this.#start({
      env: this.#env,
      homeDir: this.#homeDir,
      probe: this.#probe,
      openBrowser: () => undefined,
      onUpdate: (update) => this.#apply(update),
      onConnected: () => undefined,
    });
    return webAuthStatus(this.#status, this.#status.phase !== "unavailable");
  }

  cancel(): WebAuthStatus {
    this.#session?.cancel();
    return this.status();
  }

  #apply(update: CodexDeviceAuthUpdate): void {
    this.#status = {
      phase: update.phase,
      message: update.phase === "unavailable"
        ? "Official Codex browser sign-in is unavailable. Connect a supported API provider in this browser instead."
        : update.message,
      lines: [...update.lines],
    };
    if (update.phase !== "running") this.#session = null;
  }
}
