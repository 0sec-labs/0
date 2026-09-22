import { spawn } from "node:child_process";

import { defaultOpenBrowser } from "../commands/auth.js";
import { maybeLoadCodexAuth } from "../codex-auth.js";
import { sanitizeTuiText } from "./text.js";

const MAX_VISIBLE_LINES = 8;

export type CodexDeviceAuthPhase = "running" | "connected" | "cancelled" | "failed";

export interface CodexDeviceAuthUpdate {
  phase: CodexDeviceAuthPhase;
  lines: readonly string[];
  message: string;
}

export interface CodexDeviceAuthProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnCodexDeviceAuth = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => CodexDeviceAuthProcess;

export interface StartCodexDeviceAuthOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnCodexDeviceAuth;
  /** Test seam; defaults to the platform browser opener. */
  openBrowser?: (url: string) => void | Promise<void>;
  onUpdate: (update: CodexDeviceAuthUpdate) => void;
  onConnected: () => void;
}

export interface CodexDeviceAuthSession {
  cancel(): void;
}

function defaultSpawnCodexDeviceAuth(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
): CodexDeviceAuthProcess {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    child.kill("SIGTERM");
    throw new Error("Codex device OAuth did not expose output streams.");
  }
  return child;
}

/**
 * Run Codex's official device-auth flow without ever asking the operator to
 * paste a ChatGPT API key or OAuth token into 0. The Codex CLI owns the
 * browser/device protocol and writes ~/.codex/auth.json; on success we reload
 * that file explicitly, replacing only this process's stale Codex tokens.
 */
export function startCodexDeviceAuth(options: StartCodexDeviceAuthOptions): CodexDeviceAuthSession {
  const env = options.env ?? process.env;
  const launch = options.spawn ?? defaultSpawnCodexDeviceAuth;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const lines: string[] = [];
  let pending = "";
  let settled = false;
  let cancelled = false;
  let browserOpened = false;

  const publish = (phase: CodexDeviceAuthPhase, message: string): void => {
    options.onUpdate({ phase, lines: [...lines], message });
  };
  const tryOpenBrowser = (text: string): void => {
    if (browserOpened) return;
    // Codex may emit the URL without a trailing newline, or redraw the line
    // with carriage returns. Scan each chunk before line buffering so browser
    // launch does not depend on terminal formatting.
    const rawUrl = text.match(/https:\/\/auth\.openai\.com\/codex\/device[^\s\x1b]*/)?.[0];
    if (!rawUrl) return;
    const url = rawUrl.replace(/[),.;]+$/, "");
    browserOpened = true;
    void Promise.resolve(openBrowser(url)).catch(() => {
      lines.push("Could not open a browser automatically; open the URL above.");
      if (lines.length > MAX_VISIBLE_LINES) lines.shift();
      publish("running", "Complete the ChatGPT Codex device sign-in in your browser.");
    });
  };
  const pushOutput = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    tryOpenBrowser(text);
    const raw = `${pending}${text}`;
    const parts = raw.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      const value = sanitizeTuiText(line);
      if (value.length === 0) continue;
      lines.push(value);
      if (lines.length > MAX_VISIBLE_LINES) lines.shift();
      tryOpenBrowser(value);
    }
    publish("running", "Complete the ChatGPT Codex device sign-in in your browser.");
  };
  const finish = (phase: CodexDeviceAuthPhase, message: string): void => {
    if (settled) return;
    settled = true;
    if (pending.trim().length > 0) {
      lines.push(pending.trim());
      if (lines.length > MAX_VISIBLE_LINES) lines.shift();
    }
    publish(phase, message);
  };

  let child: CodexDeviceAuthProcess;
  try {
    child = launch("codex", ["login", "--device-auth"], { env });
  } catch (error) {
    finish("failed", error instanceof Error ? error.message : String(error));
    return { cancel: () => {} };
  }

  child.stdout.on("data", pushOutput);
  child.stderr.on("data", pushOutput);
  child.on("error", (error) => {
    finish("failed", error.message);
  });
  child.on("close", (code) => {
    if (cancelled) {
      finish("cancelled", "Codex device sign-in cancelled.");
      return;
    }
    if (code !== 0) {
      finish("failed", `Codex device sign-in exited with code ${code ?? "unknown"}.`);
      return;
    }
    maybeLoadCodexAuth({ env, home: options.homeDir, force: true });
    if (!env["ZERO_CHATGPT_ACCESS_TOKEN"] && !env["ZERO_CHATGPT_OAUTH_REFRESH_TOKEN"]) {
      finish("failed", "Codex completed without a readable ChatGPT subscription credential.");
      return;
    }
    finish("connected", "ChatGPT Codex subscription connected.");
    options.onConnected();
  });
  publish("running", "Starting ChatGPT Codex device sign-in…");

  return {
    cancel: () => {
      if (settled || cancelled) return;
      cancelled = true;
      child.kill("SIGTERM");
    },
  };
}
