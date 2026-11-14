import { v } from "@/lib/vocabulary";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type {
  DesktopConsoleDecision,
  DesktopConsoleDecisionKind,
  DesktopConsoleDecisionResponse,
  DesktopConsoleOperatorAnswer,
  DesktopConsoleOperatorQuestion,
} from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { Popover } from "@/ui/components/popover";
import { Textarea } from "@/components/ui/textarea";
import { ActivityMark, LoadingDots } from "./loading-state";

type ApprovalPanelProps = {
  decision: DesktopConsoleDecision & { resolved?: boolean; approved?: boolean };
  busy: boolean;
  onResolve: (response: DesktopConsoleDecisionResponse) => void;
};

type AnswerDraft = { selectedLabels: string[]; customText: string };
const EMPTY_ANSWER: AnswerDraft = { selectedLabels: [], customText: "" };
const CUSTOM_ANSWER_LIMIT = 8000;

const DECISION_PRESENTATION = {
  tool: {
    label: "Tool use",
    action: "Allow",
    explanation: "Allow this one tool action.",
  },
  scope: {
    label: "New targets",
    action: "Allow targets",
    explanation: v("Let 0 reach these network targets in this {mission}."),
  },
  "local-scope": {
    label: "Folder access",
    action: "Allow folder",
    explanation: v("Let 0 access this folder and everything in it for this {mission}."),
  },
  "audit-escalation": {
    label: "Beyond code review",
    action: "Allow",
    explanation: v("Let 0 use tools beyond reviewing your local code in this {mission}. Other limits still apply."),
  },
  "operator-question": {
    label: "Question",
    action: "Send answers",
    explanation: "Answering doesn't grant any permissions.",
  },
} satisfies Record<DesktopConsoleDecisionKind, {
  label: string;
  action: string;
  explanation: string;
}>;

function answerError(question: DesktopConsoleOperatorQuestion, answer: AnswerDraft): string | undefined {
  if (answer.selectedLabels.some((label) => !question.options?.some((option) => option.label === label))) {
    return "Choose an available option.";
  }
  if (!question.multiSelect && answer.selectedLabels.length > 1) return "Choose only one option.";
  if (answer.customText.length > CUSTOM_ANSWER_LIMIT) return "Keep your answer under 8,000 characters.";
  if (!question.allowCustom && answer.customText.trim()) return "Pick one of the options.";
  if (!answer.selectedLabels.length && !(question.allowCustom && answer.customText.trim())) {
    return question.allowCustom ? "Choose an option or type an answer." : "Choose an option.";
  }
  return undefined;
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground-2">{label}</h4>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all rounded-md border-[0.5px] border-border-1 px-2.5 py-1.5 font-mono text-xs text-foreground scroll-fade-y">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value)}
      </pre>
    </div>
  );
}

function QuestionBlock({
  question,
  index,
  id,
  answer,
  disabled,
  error,
  onChange,
}: {
  question: DesktopConsoleOperatorQuestion;
  index: number;
  id: string;
  answer: AnswerDraft;
  disabled: boolean;
  error?: string;
  onChange: (answer: AnswerDraft) => void;
}) {
  const descriptionId = `${id}-description`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      data-question-index={index}
      disabled={disabled}
      tabIndex={-1}
      aria-describedby={`${descriptionId} ${hintId}${error ? ` ${errorId}` : ""}`}
      aria-invalid={Boolean(error)}
      className="min-w-0 space-y-3 rounded-md bg-secondary/50 p-2.5 disabled:opacity-60"
    >
      <legend className="px-1 text-[13px] font-medium">{question.header}</legend>
      <p id={descriptionId} className="whitespace-pre-wrap break-words text-sm">{question.question}</p>
      <p id={hintId} className="text-xs text-muted-foreground">
        {question.options?.length
          ? question.multiSelect ? "Choose one or more." : "Choose one."
          : question.allowCustom ? "Type your answer." : ""}
        {question.options?.length && question.allowCustom ? " Or type your own answer." : ""}
      </p>
      {question.options?.map((option, optionIndex) => {
        const optionId = `${id}-option-${optionIndex}`;
        const optionDescriptionId = `${optionId}-description`;
        const selected = answer.selectedLabels.includes(option.label);
        return (
          <label key={optionIndex} htmlFor={optionId} className="flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-secondary has-[:checked]:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40">
            <input
              id={optionId}
              name={`${id}-options`}
              type={question.multiSelect ? "checkbox" : "radio"}
              value={option.label}
              checked={selected}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={[option.description ? optionDescriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
              className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onChange={(event) => onChange({
                ...answer,
                selectedLabels: question.multiSelect
                  ? event.target.checked
                    ? [...answer.selectedLabels, option.label]
                    : answer.selectedLabels.filter((label) => label !== option.label)
                  : [option.label],
              })}
            />
            <span className="min-w-0 space-y-1">
              <span className="block whitespace-pre-wrap break-words text-sm font-medium">{option.label}</span>
              {option.description && <span id={optionDescriptionId} className="block whitespace-pre-wrap break-words text-xs text-muted-foreground">{option.description}</span>}
            </span>
          </label>
        );
      })}
      {question.allowCustom && !question.multiSelect && answer.selectedLabels.length > 0 && (
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...answer, selectedLabels: [] })}>Clear choice</Button>
      )}
      {question.allowCustom && (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-custom`} className="text-sm font-medium">Your answer</label>
          <Textarea
            id={`${id}-custom`}
            name={`${id}-custom`}
            value={answer.customText}
            maxLength={CUSTOM_ANSWER_LIMIT}
            rows={3}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-limit${error ? ` ${errorId}` : ""}`}
            onChange={(event) => onChange({ ...answer, customText: event.target.value })}
          />
          <p id={`${id}-limit`} hidden={answer.customText.length < 7000} className="text-xs text-muted-foreground">{answer.customText.length.toLocaleString()} / 8,000 characters</p>
        </div>
      )}
      {!question.options?.length && !question.allowCustom && <p className="text-sm text-destructive">No options to choose from. You can decline.</p>}
      {error && <p id={errorId} className="text-sm text-destructive" role="alert">{error}</p>}
    </fieldset>
  );
}

function DecisionForm({ decision, busy, onResolve }: ApprovalPanelProps) {
  const id = useId();
  const [answers, setAnswers] = useState<Record<number, AnswerDraft>>({});
  const [attempted, setAttempted] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const navigated = useRef(false);
  const questions = decision.questions ?? [];
  const disabled = busy || Boolean(decision.resolved);
  const isQuestion = true;
  const sequential = isQuestion && !decision.resolved && questions.length > 1;
  const currentIndex = Math.min(questionIndex, Math.max(0, questions.length - 1));
  const hasNext = sequential && currentIndex < questions.length - 1;
  useLayoutEffect(() => {
    if (!navigated.current) return;
    const block = form.current?.querySelector<HTMLElement>(`[data-question-index="${currentIndex}"]`);
    (block?.querySelector<HTMLElement>("input, textarea") ?? block)?.focus();
  }, [currentIndex]);
  const resolvedLabel = decision.approved === undefined ? "Closed" : decision.approved ? "Answered" : "Declined";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setAttempted(true);
    if (hasNext) {
      if (answerError(questions[currentIndex]!, answers[currentIndex] ?? EMPTY_ANSWER)) {
        const block = form.current?.querySelector<HTMLElement>(`[data-question-index="${currentIndex}"]`);
        (block?.querySelector<HTMLElement>("input, textarea") ?? block)?.focus();
        return;
      }
      navigated.current = true;
      setQuestionIndex(currentIndex + 1);
      setAttempted(false);
      return;
    }
    const firstInvalid = questions.findIndex((question, index) => answerError(question, answers[index] ?? EMPTY_ANSWER));
    if (firstInvalid !== -1) {
      if (sequential) { navigated.current = true; setQuestionIndex(firstInvalid); }
      const question = event.currentTarget.querySelector<HTMLElement>(`[data-question-index="${firstInvalid}"]`);
      (question?.querySelector<HTMLElement>("input, textarea") ?? question)?.focus();
      return;
    }
    const response: DesktopConsoleDecisionResponse = { approve: true };
    if (questions.length) {
      response.answers = questions.map((question, index): DesktopConsoleOperatorAnswer => {
        const draft = answers[index] ?? EMPTY_ANSWER;
        const answer: DesktopConsoleOperatorAnswer = { header: question.header };
        if (draft.selectedLabels.length) answer.selectedLabels = [...draft.selectedLabels];
        const customText = draft.customText.trim();
        if (question.allowCustom && customText) answer.customText = customText;
        return answer;
      });
    }
    onResolve(response);
  }

  return (
    <form
      ref={form}
      noValidate
      autoComplete="off"
      aria-label={decision.title}
      aria-busy={busy && !decision.resolved}
      onSubmit={handleSubmit}
      data-slot="question-form"
      className="mx-auto w-full max-w-[560px] space-y-3 border-l-[0.5px] border-border-1 pl-3 text-[13px] text-foreground"
    >
      {questions.length > 0 && (
        <div className="space-y-3">
          {sequential && <p role="status" aria-live="polite" aria-atomic="true" className="text-xs font-medium text-muted-foreground">Question {currentIndex + 1} of {questions.length}</p>}
          {questions.flatMap((question, index) => sequential && index !== currentIndex ? [] : [
            <QuestionBlock
              key={index}
              question={question}
              index={index}
              id={`${id}-question-${index}`}
              answer={answers[index] ?? EMPTY_ANSWER}
              disabled={disabled}
              error={attempted && !decision.resolved ? answerError(question, answers[index] ?? EMPTY_ANSWER) : undefined}
              onChange={(answer) => setAnswers((previous) => ({ ...previous, [index]: answer }))}
            />
          ])}
        </div>
      )}
      <p role="status" className="sr-only">
        {decision.resolved ? `${resolvedLabel}.` : busy ? "Please wait…" : "Waiting for you."}
      </p>
      {!decision.resolved && (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {sequential && currentIndex > 0 && <Button type="button" size="sm" variant="ghost" className="mr-auto" disabled={busy} onClick={() => { navigated.current = true; setQuestionIndex(currentIndex - 1); setAttempted(false); }}>Back</Button>}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { if (!disabled) onResolve({ approve: false }); }}>Decline</Button>
          <Button type="submit" size="sm" disabled={busy}>{busy ? <><LoadingDots />Please wait…</> : hasNext ? "Next" : "Send answers"}</Button>
        </div>
      )}
    </form>
  );
}

/** The request, in the words the waiting line shows after "Waiting on". */
export function waitingRequest(decision: DesktopConsoleDecision): string {
  if (decision.kind === "operator-question") return decision.questions?.[0]?.header || decision.questions?.[0]?.question || decision.title;
  return decision.title || DECISION_PRESENTATION[decision.kind].label;
}

/** Closed decisions collapse to one muted sentence; nothing about them is a card. */
export function resolvedSummary(decision: DesktopConsoleDecision & { approved?: boolean }): string {
  const outcome = decision.approved === undefined ? "closed" : decision.approved ? decision.kind === "operator-question" ? "answered" : "allowed" : "declined";
  return `${waitingRequest(decision)} · ${outcome}`;
}

function DecisionDetails({ decision }: { decision: DesktopConsoleDecision }) {
  const context = decision.context;
  return (
    <div className="space-y-2.5 text-xs">
      <p className="text-muted-foreground-1">{DECISION_PRESENTATION[decision.kind].explanation}</p>
      {decision.kind !== "tool" && decision.detail && <p className="whitespace-pre-wrap break-words text-foreground">{decision.detail}</p>}
      {decision.reason && <DetailBlock label="Why" value={decision.reason} />}
      {decision.call && <><DetailBlock label="Tool" value={decision.call.name} /><DetailBlock label="Input" value={decision.call.arguments} /></>}
      {decision.requestedUrls && decision.requestedUrls.length > 0 && <DetailBlock label="Targets to allow" value={decision.requestedUrls} />}
      {decision.unresolvedTargets && decision.unresolvedTargets.length > 0 && <DetailBlock label="Unknown destinations" value={decision.unresolvedTargets} />}
      {decision.requestedPath && <DetailBlock label="Folder to allow" value={decision.requestedPath} />}
      {context && (
        <dl className="grid gap-1.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Target</dt><dd className="whitespace-pre-wrap break-all">{context.target}</dd>
          <dt className="text-muted-foreground">Role</dt><dd>{context.role}</dd>
          <dt className="text-muted-foreground">Mode</dt><dd>{context.autonomyMode}</dd>
        </dl>
      )}
      {decision.currentScope !== undefined && <DetailBlock label="Allowed targets" value={decision.currentScope ?? "None set."} />}
      {decision.currentScopePath !== undefined && <DetailBlock label="Allowed folder" value={decision.currentScopePath} />}
    </div>
  );
}

const WAITING_ACTION = "rounded-[var(--radius-inner,4px)] px-1 text-muted-foreground-2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";

/** Capy's one waiting UI: a centred muted line, "Waiting on <request> ...", with the smallest set of actions. */
function WaitingLine({ decision, busy, onResolve }: ApprovalPanelProps) {
  const isQuestion = decision.kind === "operator-question";
  return (
    <div data-slot="waiting-line" className="mx-auto flex w-full max-w-[640px] min-w-0 flex-col items-center gap-2">
      <div role="group" aria-label={`Waiting on ${waitingRequest(decision)}`} aria-busy={busy} className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 py-1.5 text-xs font-medium text-muted-foreground">
        <ActivityMark waiting />
        <span className="shrink-0">Waiting on</span>
        <span className="min-w-0 max-w-full truncate text-primary" title={waitingRequest(decision)}>{waitingRequest(decision)}</span>
        {!isQuestion && <>
          <button type="button" className={WAITING_ACTION} disabled={busy} onClick={() => onResolve({ approve: true })}>Allow</button>
          <button type="button" className={WAITING_ACTION} disabled={busy} onClick={() => onResolve({ approve: false })}>Deny</button>
          <Popover>
            <Popover.Trigger render={<button type="button" className={WAITING_ACTION} />}>Details</Popover.Trigger>
            <Popover.Content side="bottom" align="center" className="w-[min(560px,calc(100vw-2rem))] rounded-[var(--radius-inner,4px)] border-[0.5px] border-border-1 px-3 py-2">
              <div role="region" aria-label="Request details"><DecisionDetails decision={decision} /></div>
            </Popover.Content>
          </Popover>
        </>}
      </div>
      {isQuestion && <DecisionForm key={decision.id} decision={decision} busy={busy} onResolve={onResolve} />}
    </div>
  );
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  if (props.decision.resolved) return <p role="status" className="text-center text-xs text-muted-foreground">{resolvedSummary(props.decision)}</p>;
  return <WaitingLine key={props.decision.id} {...props} />;
}
