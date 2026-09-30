import { useId, useState, type FormEvent } from "react";
import type {
  DesktopConsoleDecision,
  DesktopConsoleDecisionKind,
  DesktopConsoleDecisionResponse,
  DesktopConsoleOperatorAnswer,
  DesktopConsoleOperatorQuestion,
} from "@0/shared";
import { FileCode, Globe, MessageSquare, Shield, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LoadingDots } from "./loading-state";

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
    icon: Wrench,
  },
  scope: {
    label: "New targets",
    action: "Allow targets",
    explanation: "Let 0 reach these network targets in this conversation.",
    icon: Globe,
  },
  "local-scope": {
    label: "Folder access",
    action: "Allow folder",
    explanation: "Let 0 access this folder and everything in it for this conversation.",
    icon: FileCode,
  },
  "audit-escalation": {
    label: "Beyond code review",
    action: "Allow",
    explanation: "Let 0 use tools beyond reviewing your local code in this conversation. Other limits still apply.",
    icon: Shield,
  },
  "operator-question": {
    label: "Question",
    action: "Send answers",
    explanation: "Answering doesn't grant any permissions.",
    icon: MessageSquare,
  },
} satisfies Record<DesktopConsoleDecisionKind, {
  label: string;
  action: string;
  explanation: string;
  icon: typeof Wrench;
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
      <h4 className="text-xs font-semibold text-muted-foreground">{label}</h4>
      <pre className="whitespace-pre-wrap break-all rounded-xl bg-muted/40 p-3 font-mono text-xs text-foreground">
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
      className="min-w-0 space-y-3 rounded-2xl bg-muted/20 p-4 disabled:opacity-60"
    >
      <legend className="px-1 text-sm font-semibold">{question.header}</legend>
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
          <label key={optionIndex} htmlFor={optionId} className="flex items-start gap-3 rounded-xl bg-muted/30 p-3 transition-colors hover:bg-muted/60 has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40">
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
  const presentation = DECISION_PRESENTATION[decision.kind];
  const Icon = presentation.icon;
  const questions = decision.questions ?? [];
  const disabled = busy || Boolean(decision.resolved);
  const context = decision.context;
  const resolvedLabel = decision.approved === undefined ? "Closed" : decision.approved ? "Approved" : "Declined";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setAttempted(true);
    const firstInvalid = questions.findIndex((question, index) => answerError(question, answers[index] ?? EMPTY_ANSWER));
    if (firstInvalid !== -1) {
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
      noValidate
      autoComplete="off"
      aria-labelledby={`${id}-title`}
      aria-busy={busy && !decision.resolved}
      onSubmit={handleSubmit}
      className="space-y-4 rounded-2xl bg-card p-5 text-card-foreground"
    >
      <div className="flex flex-wrap items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-primary-text" aria-hidden="true" />
        <h3 id={`${id}-title`} className="min-w-0 flex-1 break-words text-sm font-semibold">{decision.title}</h3>
        {decision.resolved && <Badge variant={decision.approved === undefined ? "neutral" : decision.approved ? "success" : "danger"}>{resolvedLabel}</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">{presentation.explanation}</p>
      {decision.kind !== "tool" && decision.detail && <p className="whitespace-pre-wrap break-words text-sm">{decision.detail}</p>}
      {decision.reason && <DetailBlock label="Why" value={decision.reason} />}
      {decision.call && (
        <div className="space-y-2 rounded-xl bg-muted/20 p-3">
          <DetailBlock label="Tool" value={decision.call.name} />
          <DetailBlock label="Input" value={decision.call.arguments} />
        </div>
      )}
      {decision.requestedUrls && decision.requestedUrls.length > 0 && <DetailBlock label="Targets to allow" value={decision.requestedUrls} />}
      {decision.unresolvedTargets && decision.unresolvedTargets.length > 0 && <DetailBlock label="Unknown destinations" value={decision.unresolvedTargets} />}
      {decision.requestedPath && <DetailBlock label="Folder to allow" value={decision.requestedPath} />}
      {(context || decision.currentScope !== undefined || decision.currentScopePath !== undefined) && (
        <details aria-label="Current permissions" className="space-y-3 rounded-xl bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Current permissions</summary>
          {context && (
            <>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Target</dt><dd className="whitespace-pre-wrap break-all">{context.target}</dd>
                <dt className="text-muted-foreground">Role</dt><dd>{context.role}</dd>
                <dt className="text-muted-foreground">Mode</dt><dd>{context.autonomyMode}</dd>
              </dl>
              {context.localScopePath && context.localScopePath !== decision.currentScopePath && <DetailBlock label="Allowed folder" value={context.localScopePath} />}
            </>
          )}
          {decision.currentScope !== undefined && <DetailBlock label="Allowed targets" value={decision.currentScope ?? "None set."} />}
          {decision.currentScopePath !== undefined && <DetailBlock label="Allowed folder" value={decision.currentScopePath} />}
        </details>
      )}
      {questions.length > 0 && (
        <div className="space-y-3">
          {questions.map((question, index) => (
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
          ))}
        </div>
      )}
      <p role="status" className="sr-only">
        {decision.resolved ? `${resolvedLabel}.` : busy ? "Please wait…" : "Waiting for you."}
      </p>
      {!decision.resolved && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => { if (!disabled) onResolve({ approve: false }); }}>Decline</Button>
          <Button type="submit" disabled={busy}>{busy ? <><LoadingDots />Please wait…</> : presentation.action}</Button>
        </div>
      )}
    </form>
  );
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  return <DecisionForm key={props.decision.id} {...props} />;
}
