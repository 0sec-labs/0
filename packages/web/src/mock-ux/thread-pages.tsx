import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CapyArrowUpRightIcon, CapyAutomationsIcon, CapyCheckIcon } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/page-shell";
import { THREADS, WORKFLOWS } from "./fixtures";
import { Chip, cardClasses } from "./parts";

function Composer({ placeholder, workflowId, onSend }: { placeholder: string; workflowId?: string; onSend?: () => void }) {
  const [text, setText] = useState("");
  const [workflow, setWorkflow] = useState(workflowId);
  const picked = WORKFLOWS.find(item => item.id === workflow);
  return <div className="rounded-xl border-[0.5px] border-border-2 bg-card p-2 shadow-sm">
    <Textarea aria-label="Message" value={text} onChange={event => setText(event.target.value)} placeholder={placeholder} rows={2} className="min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" />
    <div className="flex items-center gap-2 pt-1">
      <DropdownMenu>
        <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" className="text-muted-foreground-1" />}><CapyAutomationsIcon aria-hidden="true" />{picked ? picked.name : "Run a workflow"}</DropdownMenu.Trigger>
        <DropdownMenu.Content align="start">
          <DropdownMenu.Item selected={!workflow} onClick={() => setWorkflow(undefined)}>No workflow</DropdownMenu.Item>
          {WORKFLOWS.map(item => <DropdownMenu.Item key={item.id} selected={workflow === item.id} onClick={() => setWorkflow(item.id)}>{item.name}</DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu>
      <span className="ml-auto text-xs text-muted-foreground-1">gpt-5.5 · High</span>
      <Button size="sm" disabled={!text && !picked} onClick={onSend}>Send</Button>
    </div>
  </div>;
}

/** Empty thread: manual firing of a workflow from a thread ("test this PR", "scan this codebase"). */
export function NewThreadPage() {
  const navigate = useNavigate();
  const starters = [
    { label: "Test this PR", workflowId: "pr-security", hint: "PR security" },
    { label: "Scan this codebase", workflowId: "codebase-security", hint: "Codebase security" },
    { label: "Scan all dependencies", workflowId: "dependency-security", hint: "Dependency security" },
  ];
  return <div className="mx-auto flex min-h-[60vh] w-full max-w-(--page-width-form) flex-col justify-center gap-6 px-6 py-10">
    <h1 className="text-center text-[22px]/7 font-medium tracking-[-0.02em]">What should we look at?</h1>
    <Composer placeholder="Ask anything, or paste a pull request URL" onSend={() => navigate("/chats/t-ux")} />
    <div className="flex flex-wrap justify-center gap-2" aria-label="Start from a workflow">
      {starters.map(item => <Button key={item.workflowId} variant="outline" size="sm" onClick={() => navigate(`/chats/t-ux`)}>{item.label}<span className="text-muted-foreground-1">{item.hint}</span></Button>)}
    </div>
    <p className="text-center text-xs text-muted-foreground-1">Workflows start a thread of their own when they fire. From here, one runs inside this thread.</p>
  </div>;
}

const TRANSCRIPTS: Record<string, { who: "you" | "0"; body: ReactNode }[]> = {
  "t-412": [
    { who: "0", body: "Started by PR security because #412 (session refresh rework) was opened." },
    { who: "0", body: <>I reviewed the diff. <strong>One finding needs you:</strong> <code>refreshSession()</code> now accepts a refresh token without checking that it belongs to the calling session, so a token from one user can mint a session for another. Severity high. I drafted a fix on a branch and left a review comment on the PR.</> },
    { who: "you", body: "Is the old code path still reachable from the OIDC callback?" },
    { who: "0", body: "Yes, through callback.ts line 88. I added a test that fails on the new code and passes with the fix. Want me to push the fix to the PR branch?" },
  ],
  "t-ux": [{ who: "you", body: "Mock a sidebar that does not turn into a never-ending list." }, { who: "0", body: "Agents stay pinned at the top, the five newest threads below, and History holds the rest." }],
};

export function ThreadPage() {
  const { id = "" } = useParams();
  const thread = THREADS.find(item => item.id === id);
  const workflow = WORKFLOWS.find(item => item.id === thread?.workflowId);
  const messages = TRANSCRIPTS[id] ?? [{ who: "0" as const, body: `This is a fixture thread (${thread?.title ?? id}). The real transcript is not part of the prototype.` }];
  return <div className="mx-auto flex w-full max-w-(--page-width-form) flex-col gap-6 px-6 py-8">
    <header className="space-y-2">
      <h1 className="text-lg font-medium tracking-[-0.02em]">{thread?.title ?? "Thread"}</h1>
      {workflow && <Link to={`/workflows/${workflow.id}`} className="inline-flex h-6 items-center gap-1.5 rounded-md border-[0.5px] border-border-2 bg-secondary px-2 text-xs text-muted-foreground-1 hover:text-foreground" data-testid="started-by">
        <CapyAutomationsIcon aria-hidden="true" className="size-3" />Started by <strong className="font-medium text-foreground">{workflow.name}</strong> · {thread?.trigger}<CapyArrowUpRightIcon aria-hidden="true" className="size-3" /></Link>}
    </header>
    <div className="flex flex-col gap-4">{messages.map((message, index) => <div key={index} className={message.who === "you" ? "ml-auto max-w-[85%] rounded-xl bg-secondary px-3 py-2 text-sm" : "max-w-[92%] text-sm leading-6 text-foreground/90"}>{message.body}</div>)}</div>
    <Composer placeholder="Reply" workflowId={undefined} />
  </div>;
}

/** A thread opened from "Describe what you want": the assistant proposes a workflow and the user confirms. */
export function ProposeWorkflowThread() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  return <div className="mx-auto flex w-full max-w-(--page-width-form) flex-col gap-6 px-6 py-8" data-testid="propose-thread">
    <header><h1 className="text-lg font-medium tracking-[-0.02em]">New workflow</h1><p className="text-xs text-muted-foreground-1">A thread that proposes a workflow. Nothing is saved until you confirm.</p></header>
    <div className="ml-auto max-w-[85%] rounded-xl bg-secondary px-3 py-2 text-sm">Every time someone opens a pull request that touches the auth folder, check it with extra care and ping me only if something is wrong.</div>
    <p className="max-w-[92%] text-sm leading-6">Here is a workflow for that. It starts a new thread for every matching pull request, so the history stays readable. Change anything, or tell me what to adjust.</p>
    <div className={`${cardClasses} space-y-4 p-4`} data-testid="workflow-card">
      <div className="flex items-center gap-2"><CapyAutomationsIcon aria-hidden="true" className="size-4 text-muted-foreground-1" /><span className="text-sm font-medium">Auth change review</span><Chip className="ml-auto">Proposed</Chip></div>
      <div><div className="text-xs font-medium text-muted-foreground-1">System prompt</div><p className="mt-1 rounded-md bg-secondary p-2 text-[13px] leading-5">Review pull requests that change files under <code>auth/</code> or <code>session*</code>. Check authentication, authorization and token handling line by line. Comment on the PR only when you find a real problem; otherwise stay silent and record a one-line summary.</p></div>
      <div><div className="text-xs font-medium text-muted-foreground-1">Skills</div><div className="mt-1 flex flex-wrap gap-1.5"><Chip>auth-review</Chip><Chip>pr-diff-review</Chip></div></div>
      <div><div className="text-xs font-medium text-muted-foreground-1">When it starts</div><div className="mt-1 flex flex-wrap gap-1.5"><Chip>GitHub pull request · paths: auth/**</Chip><Chip>Manual</Chip></div></div>
      <div className="flex items-center gap-2 border-t-[0.5px] border-border-2 pt-3">
        {saved ? <><span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400"><CapyCheckIcon aria-hidden="true" className="size-4" />Saved</span><Button variant="secondary" size="sm" onClick={() => navigate("/workflows/docs-drift")}>Open workflow</Button></>
          : <><Button size="sm" onClick={() => setSaved(true)}>Save workflow</Button><Button variant="ghost" size="sm" onClick={() => navigate("/workflows/docs-drift")}>Edit manually</Button><Button variant="ghost" size="sm" className="text-muted-foreground-1">Discard</Button></>}
      </div>
    </div>
    <Composer placeholder="Ask for changes, for example: also run it on forks" />
  </div>;
}

export { PageHeader };
