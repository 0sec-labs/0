import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSelfEdit, type GateStatus } from "@/lib/self-edit-api";

/**
 * Preview panel: live iframe of the self/* worktree dev stack, diff summary,
 * gate status, and a disabled Apply.
 *
 * IFRAME SANDBOX TRADE-OFF. The frame uses
 *   sandbox="allow-scripts allow-same-origin allow-forms"
 * and nothing else (no popups, no top-navigation, no downloads, no modals).
 * allow-scripts + allow-same-origin together let the framed page remove its
 * own sandbox if it were same-origin with us, so this is only acceptable
 * because the preview is a DIFFERENT origin (its own loopback port) on the
 * same machine, launched by the operator through an owner-only route, and the
 * preview server only allows framing by this dashboard's origin
 * (CSP frame-ancestors). Its code is agent-edited, so it is untrusted: it runs
 * with a scratch HOME and a scrubbed environment, but it is not an OS
 * sandbox. For that reason the frame is mounted only after an explicit click
 * ("Show preview"), never automatically, and never when the URL is not a
 * loopback http origin.
 */
const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/;
export const previewSandbox = "allow-scripts allow-same-origin allow-forms";

const badge: Record<GateStatus, string> = {
  pending: "text-muted-foreground-3", running: "text-amber-500", passed: "text-emerald-500", failed: "text-destructive", skipped: "text-muted-foreground-3",
};

function statusLine(phase: string): string {
  return ({ idle: "Stopped", preparing: "Creating worktree and installing dependencies…", starting: "Starting dev stack…", running: "Running", stopping: "Stopping…", failed: "Failed" } as Record<string, string>)[phase] ?? phase;
}

export function PreviewView() {
  const { status, diff, error, busy, start, stop, runGates } = useSelfEdit();
  const [shown, setShown] = useState(false);
  const preview = status?.preview;
  const url = preview?.url && loopback.test(preview.url) ? preview.url : undefined;
  const running = preview?.phase === "running";
  const active = preview && preview.phase !== "idle" && preview.phase !== "failed";
  const gates = preview?.gates;

  return <div className="flex h-full min-h-0 flex-col text-sm">
    <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b-[0.5px] border-border-1 px-2 py-1.5">
      <span className="mr-auto truncate text-xs text-muted-foreground-2">{preview ? `${statusLine(preview.phase)}${preview.branch ? ` · ${preview.branch}` : ""}` : "Loading…"}</span>
      {!active && <Button size="xs" disabled={busy || !status?.enabled} onClick={() => { setShown(false); void start(); }}>Start preview</Button>}
      {active && <Button size="xs" variant="outline" disabled={busy} onClick={() => { setShown(false); void stop(false); }}>Stop</Button>}
      {preview?.branch && !active && <Button size="xs" variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Discard ${preview.branch} and its worktree? Uncommitted edits and unpushed commits are lost.`)) void stop(true); }}>Discard</Button>}
      <Button size="xs" variant="outline" disabled aria-disabled="true" title="Apply is not yet available: this build is preview-only.">Apply (not yet available)</Button>
    </header>
    {status && !status.enabled && <p className="px-3 py-2 text-xs text-muted-foreground-2">Self-edit is off. Start the dashboard with <code>ZERO_SELF_EDIT=1</code> to enable previews. Owner access is required in team mode.</p>}
    {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
    {preview?.error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{preview.error}</p>}

    <div className="relative flex min-h-40 flex-1 items-center justify-center bg-black/10">
      {running && url && shown
        ? <iframe title="Dashboard preview" src={url} sandbox={previewSandbox} referrerPolicy="no-referrer" className="size-full border-0 bg-background" />
        : running && url
          ? <div className="flex max-w-xs flex-col items-center gap-2 px-4 text-center">
              <p className="text-xs text-muted-foreground-2">The preview runs agent-edited code on a separate local port with an empty data directory. Show it only if you trust the current edits.</p>
              <Button size="xs" onClick={() => setShown(true)}>Show preview</Button>
            </div>
          : <p className="px-4 text-center text-xs text-muted-foreground-3">{active ? statusLine(preview!.phase) : "No preview running."}</p>}
    </div>

    <section aria-label="Gates" className="shrink-0 border-t-[0.5px] border-border-1 px-2 py-1.5">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="mr-auto text-xs font-medium">Gates{gates ? ` · ${gates.status}` : ""}</h3>
        <Button size="xs" variant="outline" disabled={busy || !preview?.branch || gates?.status === "running"} onClick={() => void runGates()}>Run gates</Button>
      </div>
      {gates
        ? <ul className="space-y-0.5 text-xs">{gates.steps.map(step => <li key={step.id} className="flex items-baseline gap-2"><span className={badge[step.status]}>{step.status}</span><span>{step.label}</span></li>)}</ul>
        : <p className="text-xs text-muted-foreground-3">Not run yet. Typecheck, web build and changed-file tests run on the dashboard, not by the agent.</p>}
      {gates && !gates.protected.ok && <ul className="mt-1 space-y-0.5 text-xs text-destructive">
        {gates.protected.error ? <li>{gates.protected.error}</li> : gates.protected.hits.map(hit => <li key={hit.path}>Protected: {hit.path} ({hit.reason})</li>)}
      </ul>}
      {gates?.steps.filter(step => step.status === "failed" && step.detail && step.id !== "protected-paths").map(step => <pre key={step.id} className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground-2">{step.detail}</pre>)}
    </section>

    <section aria-label="Diff" className="max-h-40 shrink-0 overflow-auto border-t-[0.5px] border-border-1 px-2 py-1.5">
      <h3 className="mb-1 text-xs font-medium">Diff{diff ? ` · ${diff.files.length + diff.untracked.length} file(s)` : ""}</h3>
      {diff && diff.files.length + diff.untracked.length > 0
        ? <ul className="space-y-0.5 font-mono text-2xs">
            {diff.files.map(file => <li key={file.path}>{file.status} {file.path}</li>)}
            {diff.untracked.map(path => <li key={path}>? {path}</li>)}
          </ul>
        : <p className="text-xs text-muted-foreground-3">No changes yet.</p>}
    </section>

    {preview && preview.logTail.length > 0 && <details className="shrink-0 border-t-[0.5px] border-border-1 px-2 py-1">
      <summary className="cursor-pointer text-xs text-muted-foreground-2">Log</summary>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground-2">{preview.logTail.slice(-40).join("\n")}</pre>
    </details>}
  </div>;
}
