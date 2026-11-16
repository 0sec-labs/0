import { useState } from "react";
import { ApiError } from "@/lib/api-error";
import { failureLine, promptView, sourceProblem, type ExtensionRowDto, type InstallPromptDto, type PromptView } from "@/lib/extensions-model";
import type { ExtensionsApi, InstallInput } from "./use-extensions";

type Flow =
  | { step: "closed" }
  | { step: "source" }
  | { step: "mcp" }
  | { step: "review"; mode: "install"; input: InstallInput; prompt: InstallPromptDto }
  | { step: "review"; mode: "update" | "approve"; name: string; prompt: InstallPromptDto };

const messageOf = (cause: unknown, fallback: string): string => cause instanceof ApiError ? failureLine(cause.code, cause.message) : cause instanceof Error ? cause.message : fallback;

/**
 * The add, update and approve flows as one small state machine. Every path ends in the same review prompt and an
 * explicit confirm; the server re-checks that the revision it installs is the one that was shown.
 */
export function useReviewFlow(api: ExtensionsApi) {
  const [flow, setFlow] = useState<Flow>({ step: "closed" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = api.preview.isPending || api.info.isPending || api.previewUpdate.isPending || api.install.isPending || api.update.isPending || api.enable.isPending;
  const fail = (cause: unknown, fallback: string) => setError(messageOf(cause, fallback));
  const close = () => { if (!pending) { setFlow({ step: "closed" }); setError(""); } };

  const view: PromptView | null = flow.step === "review" ? promptView(flow.prompt) : null;
  const confirmLabel = flow.step === "review" && flow.mode === "approve" ? "Approve and turn on" : view?.confirmLabel ?? "";
  const reviewView = view && flow.step === "review" && flow.mode === "approve" ? { ...view, title: `Turn on ${flow.prompt.name}`, confirmLabel } : view;

  return {
    step: flow.step, view: reviewView, error, notice, pending, close,
    openAdd: () => { setError(""); setNotice(""); setFlow({ step: "source" }); },
    openAddMcp: () => { setError(""); setNotice(""); setFlow({ step: "mcp" }); },
    problem: (source: string) => sourceProblem(source),
    async submitInput(input: InstallInput) {
      setError("");
      try { const { prompt } = await api.preview.mutateAsync(input); setFlow({ step: "review", mode: "install", input, prompt }); }
      catch (cause) { fail(cause, "Could not read that source."); }
    },
    submitSource(source: string) { return this.submitInput({ source: source.trim() }); },
    async startUpdate(row: ExtensionRowDto) {
      setError(""); setNotice("");
      try {
        const result = await api.previewUpdate.mutateAsync(row.name);
        if ("upToDate" in result) setNotice(`${row.name} is up to date.`); else setFlow({ step: "review", mode: "update", name: row.name, prompt: result.prompt });
      } catch (cause) { setNotice(""); setError(messageOf(cause, "Could not check for an update.")); }
    },
    async startApprove(row: ExtensionRowDto) {
      setError(""); setNotice("");
      try { const { prompt } = await api.info.mutateAsync(row.name); setFlow({ step: "review", mode: "approve", name: row.name, prompt }); }
      catch (cause) { setError(messageOf(cause, "Could not read this extension.")); }
    },
    async confirm() {
      if (flow.step !== "review") return;
      setError("");
      try {
        if (flow.mode === "install") { await api.install.mutateAsync({ ...flow.input, approvedRevision: flow.prompt.revision, enable: false }); setNotice(`Added ${flow.prompt.name}. Turn it on when you are ready.`); }
        else if (flow.mode === "update") { await api.update.mutateAsync({ name: flow.name, approvedRevision: flow.prompt.revision }); setNotice(`Updated ${flow.name}.`); }
        else { await api.enable.mutateAsync({ name: flow.name, approve: true }); setNotice(`Turned on ${flow.name}.`); }
        setFlow({ step: "closed" });
      } catch (cause) { fail(cause, "Could not finish."); }
    },
    setNotice, setError,
  };
}
