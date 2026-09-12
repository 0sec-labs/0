/** @jsxImportSource @opentui/react */
import { appendFileSync } from "node:fs";
import React, { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { VERSION } from "@0sec/shared";
import { useTheme } from "./theme-context.js";
import { fitTuiText, fitTuiUrl } from "./text.js";
import {
  PANEL_HORIZONTAL_CHROME,
  SHELL_HORIZONTAL_PADDING,
  getShellChromeHeight,
} from "./shell-geometry.js";
import { ShellFrame } from "./shell-frame.js";
import { useSurfaceDimensions } from "./dialog-surface.js";
import { appendFeedback, submitFeedback } from "./feedback.js";

export function appendTuiTrace(record: Record<string, unknown>): void {
  const file = process.env["0SEC_TRACE_TUI_EVENTS"] ?? process.env["0SEC_TRACE_TUI_RENDER"];
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // best-effort only
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: String(error) };
}

export function appendTuiCrash(record: Record<string, unknown>): void {
  const file = process.env["0SEC_TRACE_TUI_EVENTS"] ?? "/tmp/0sec-tui-crashes.ndjson";
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), kind: "tui-crash", ...record })}\n`, "utf8");
  } catch {
    // best-effort only
  }
}

let crashHandlersInstalled = false;

export function installTuiCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    appendTuiCrash({
      source: "uncaughtExceptionMonitor",
      origin,
      error: serializeError(error),
    });
  });

  process.on("unhandledRejection", (reason) => {
    appendTuiCrash({
      source: "unhandledRejection",
      error: serializeError(reason),
    });
  });
}

/** What a crash panel keeps about the failure: message and raw stack. */
export interface CrashInfo {
  message: string;
  stack: string;
}

/**
 * Redact credential- and secret-shaped substrings from arbitrary crash text
 * before it is shown, written to the local feedback file, or transmitted.
 *
 * This is deliberately a *scrub*, not the warn-only `scanForSecrets` policy
 * that feedback.ts applies to operator-typed prose. Crash text is machine
 * output the operator never chose to send, so redacting is safe and matches
 * the task's "sanitized — do NOT include env/secrets" requirement. It is not a
 * guarantee of completeness; it removes the shapes we can name.
 */
const CRASH_REDACTION_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  /\b(?:pass(?:word|wd)?|api[_-]?key|secret|token|credentials?|authorization)\s*[:=]\s*\S+/gi,
];

export function sanitizeCrashText(text: string | undefined): string {
  let out = text ?? "";
  for (const pattern of CRASH_REDACTION_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Sanitized, trimmed, non-empty stack frames, capped at `max` lines. */
export function crashStackLines(stack: string | undefined, max: number): string[] {
  return sanitizeCrashText(stack)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, Math.max(0, max));
}

/**
 * Assemble the feedback body for a crash: the operator's optional note, then a
 * clearly-delimited, sanitized crash report (message + short stack). Pure so
 * it is unit-testable and so preview and transmission cannot drift.
 */
export function buildCrashFeedbackMessage(note: string, crash: CrashInfo, maxStackLines = 12): string {
  const cleanMessage = sanitizeCrashText(crash.message) || "unknown TUI error";
  const stackLines = crashStackLines(crash.stack, maxStackLines);
  const parts: string[] = [];
  const trimmedNote = note.trim();
  if (trimmedNote) parts.push(trimmedNote, "");
  parts.push("--- TUI crash report ---", `error: ${cleanMessage}`);
  if (stackLines.length > 0) {
    parts.push("stack:", ...stackLines);
  }
  return parts.join("\n");
}

export type CrashView = "options" | "feedback" | "submitting" | "result";

export type CrashKeyAction =
  | { type: "restart" }
  | { type: "feedback" }
  | { type: "quit" }
  | { type: "submit" }
  | { type: "back" }
  | { type: "append"; text: string }
  | { type: "backspace" }
  | { type: "none" };

interface CrashKeyLike {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
  sequence?: string;
}

/**
 * Pure mapping from a keystroke (in a given crash-panel view) to an action.
 * Factored out of the component so the option handling is a unit test rather
 * than a manual pty exercise. In the options/result views r/f/q are commands;
 * in the feedback compose view the same letters are text and only esc/enter
 * are commands. Ctrl+C always quits.
 */
export function resolveCrashKey(view: CrashView, key: CrashKeyLike): CrashKeyAction {
  if (key.ctrl && key.name === "c") return { type: "quit" };

  if (view === "options" || view === "result") {
    if (key.name === "r") return { type: "restart" };
    if (key.name === "f") return { type: "feedback" };
    if (key.name === "q" || key.name === "escape") return { type: "quit" };
    return { type: "none" };
  }

  if (view === "feedback") {
    if (key.name === "escape") return { type: "back" };
    if (key.name === "return") return { type: "submit" };
    if (key.name === "backspace") return { type: "backspace" };
    if (key.sequence && !key.ctrl && !key.meta && key.name !== "return") {
      return { type: "append", text: key.sequence };
    }
    return { type: "none" };
  }

  // "submitting": swallow everything but the ctrl+c already handled above.
  return { type: "none" };
}

/** One-line outcome text for a crash-feedback submission attempt. */
export function describeFeedbackOutcome(
  local: { ok: boolean; path: string; error?: string },
  sent: { ok: boolean; skipped?: string; error?: string },
): { text: string; tone: "ok" | "err" } {
  if (!local.ok) {
    return { text: `Could not save feedback: ${local.error ?? "unknown error"}`, tone: "err" };
  }
  if (sent.ok) {
    return { text: `Feedback submitted and saved to ${local.path}.`, tone: "ok" };
  }
  if (sent.skipped) {
    // describeSkip text already explains "saved locally only".
    return { text: sent.error ?? `Saved locally to ${local.path}.`, tone: "ok" };
  }
  return { text: `Saved locally to ${local.path}; submit failed: ${sent.error ?? "unknown error"}`, tone: "err" };
}

export class TuiErrorBoundary extends React.Component<
  { children: React.ReactNode; onQuit?: () => void },
  { crash: CrashInfo | null; generation: number }
> {
  constructor(props: { children: React.ReactNode; onQuit?: () => void }) {
    super(props);
    this.state = { crash: null, generation: 0 };
  }

  static getDerivedStateFromError(error: Error): { crash: CrashInfo } {
    return { crash: { message: error?.message || "unknown TUI error", stack: error?.stack ?? "" } };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    appendTuiCrash({
      source: "react-error-boundary",
      error: serializeError(error),
      componentStack: info.componentStack,
    });
  }

  // Clearing the crash and bumping the generation key tears the whole child
  // subtree down and remounts it fresh — a clean in-process restart that
  // rebuilds ChatScreen, its ConsoleSession, transcript and composer from
  // scratch, so the operator lands back at a fresh prompt without relaunching
  // the process. If the failure is deterministic it simply re-crashes on the
  // next render and shows this panel again; there is no tight loop because a
  // render pass has to run in between.
  private handleRestart = (): void => {
    this.setState((state) => ({ crash: null, generation: state.generation + 1 }));
  };

  render() {
    if (this.state.crash) {
      return <CrashPanel crash={this.state.crash} onRestart={this.handleRestart} onQuit={this.props.onQuit} />;
    }

    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
  }
}

// The boundary itself is a class component and cannot read terminal
// dimensions, so the panel does it: a crash message is arbitrary length and
// a guessed 96-column budget spills past the frame on a narrow terminal.
//
// The panel is the last line of defence, so it is written to be crash-safe in
// its own right: submission is pushed through helpers that never throw, wrapped
// again here in try/catch, and every failure resolves to an inline result line
// rather than a second thrown error.
function CrashPanel({ crash, onRestart, onQuit }: { crash: CrashInfo; onRestart: () => void; onQuit?: () => void }) {
  const theme = useTheme();
  const { width, height } = useSurfaceDimensions();
  const [view, setView] = useState<CrashView>("options");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const contentWidth = Math.max(1, width - SHELL_HORIZONTAL_PADDING * 2 - PANEL_HORIZONTAL_CHROME);
  const footerWidth = Math.max(1, width - SHELL_HORIZONTAL_PADDING * 2);
  const inputWidth = Math.max(1, contentWidth - 3);
  const tracePath = process.env["0SEC_TRACE_TUI_EVENTS"] ?? "/tmp/0sec-tui-crashes.ndjson";

  const cleanMessage = sanitizeCrashText(crash.message) || "unknown TUI error";
  // Budget the stack against the rows the frame can actually spare so the
  // bordered panel never overruns the viewport at 80x24. Chrome is the shell
  // header/padding; the reservation covers heading, message, trace line,
  // panel borders and the footer hint.
  const chromeRows = getShellChromeHeight(width);
  const reservedRows = 9;
  const maxStackLines = Math.max(1, Math.min(8, height - chromeRows - reservedRows));
  const stackLines = crashStackLines(crash.stack, maxStackLines);

  const runSubmit = (): void => {
    setView("submitting");
    setResult(null);
    // Fire-and-forget, but every throwable is contained: appendFeedback and
    // submitFeedback are both documented never to throw, and the try/catch is
    // belt-and-braces so a surprise (e.g. a patched global) shows an inline
    // error instead of re-entering the error boundary.
    void (async () => {
      try {
        const message = buildCrashFeedbackMessage(note, crash);
        const timestamp = new Date().toISOString();
        const local = appendFeedback({ message, timestamp, version: VERSION, mode: "crash" });
        // Crash feedback has no transcript preview surface. Preserve its
        // historical local-only default; an operator may still opt in with an
        // explicit 0SEC_FEEDBACK_URL.
        const sent = await submitFeedback(
          { message, timestamp, version: VERSION, mode: "crash" },
          process.env,
          { allowCloud: false },
        );
        setResult(describeFeedbackOutcome(local, sent));
      } catch (error) {
        setResult({
          text: `Feedback failed: ${error instanceof Error ? error.message : String(error)}`,
          tone: "err",
        });
      } finally {
        setView("result");
      }
    })();
  };

  useKeyboard((key) => {
    const action = resolveCrashKey(view, key);
    switch (action.type) {
      case "restart":
        onRestart();
        return;
      case "feedback":
        setResult(null);
        setView("feedback");
        return;
      case "quit":
        if (onQuit) onQuit();
        else process.exit(1);
        return;
      case "submit":
        runSubmit();
        return;
      case "back":
        setView("options");
        return;
      case "append":
        setNote((current) => current + action.text);
        return;
      case "backspace":
        setNote((current) => current.slice(0, -1));
        return;
      case "none":
        return;
    }
  });

  const footerHint = view === "feedback"
    ? "enter send · esc back · ctrl+c quit"
    : view === "submitting"
      ? "submitting feedback…"
      : "r restart · f feedback · q quit";

  return (
    <ShellFrame view="crash">
      <box
        border
        borderColor={theme.ERROR}
        backgroundColor={theme.PANEL}
        paddingX={1}
        paddingY={0}
        width="100%"
        flexShrink={0}
        minWidth={0}
      >
        <box flexDirection="column" width="100%" minWidth={0}>
          <text fg={theme.ERROR}>{fitTuiText("TUI crashed while rendering the current screen.", contentWidth)}</text>
          <text fg={theme.TEXT} wrapMode="word">{fitTuiText(cleanMessage, contentWidth)}</text>
          {stackLines.length > 0 ? <text fg={theme.MUTED}>{fitTuiText("stack:", contentWidth)}</text> : null}
          {stackLines.map((line, index) => (
            <text key={`stack-${index}`} fg={theme.MUTED}>{fitTuiText(line, contentWidth)}</text>
          ))}
          <text fg={theme.MUTED}>{fitTuiUrl(`Trace file: ${tracePath}`, contentWidth)}</text>

          {view === "feedback" ? (
            <box flexDirection="column" width="100%" minWidth={0} marginTop={1}>
              <text fg={theme.INFO}>{fitTuiText("Add a note — the sanitized crash report is attached automatically.", contentWidth)}</text>
              <box flexDirection="row" width="100%" minWidth={0}>
                <text width={2} flexShrink={0} fg={theme.PRIMARY}>&gt; </text>
                <box width={inputWidth} flexShrink={0} minWidth={0}>
                  <text fg={theme.TEXT} wrapMode="word">{fitTuiText(note || " ", inputWidth)}</text>
                </box>
                <text width={1} flexShrink={0} fg={theme.INFO}>█</text>
              </box>
            </box>
          ) : null}

          {view === "submitting" ? (
            <box width="100%" minWidth={0} marginTop={1}>
              <text fg={theme.INFO}>{fitTuiText("Submitting feedback…", contentWidth)}</text>
            </box>
          ) : null}

          {result ? (
            <box width="100%" minWidth={0} marginTop={1}>
              <text fg={result.tone === "ok" ? theme.SUCCESS : theme.ERROR} wrapMode="word">{fitTuiText(result.text, contentWidth)}</text>
            </box>
          ) : null}
        </box>
      </box>
      <box width="100%" flexShrink={0} minWidth={0} marginTop={1}>
        <text fg={theme.MUTED}>{fitTuiText(footerHint, footerWidth)}</text>
      </box>
    </ShellFrame>
  );
}
