import type { ConsoleSessionSnapshot } from "@0/shared";
import { Link } from "react-router-dom";
import { Disclosure } from "@/components/ui/disclosure";

type SourceContext = NonNullable<ConsoleSessionSnapshot["sourceContext"]>;

export function SourceContext({ context }: { context?: SourceContext }) {
  // Older hosts do not report this telemetry; absence cannot imply no memory.
  if (!context) return null;
  const lessons = context.status === "supplied" ? context.lessons : [];
  return <Disclosure summary={<>Memory supplied to model{lessons.length ? ` · ${lessons.length}` : ""}</>} triggerClassName="py-1 text-xs text-muted-foreground">
    <div className="space-y-3 pt-3 text-xs leading-5 text-muted-foreground">
      {context.status === "not_requested" ? <p>No model request yet.</p> : <>
        <p>Latest model request. Supplied context does not show whether the model relied on it or cited it.</p>
        {!lessons.length ? <p>No saved lessons were supplied with this request.</p> : <ul className="space-y-4">{lessons.map((lesson, index) => <li key={`${index}:${lesson.title}`} className="space-y-1.5">
          <h3 className="break-words font-medium text-foreground">{lesson.title || "Source lesson"}</h3>
          <p className="whitespace-pre-wrap break-words">{lesson.summary}</p>
          {!!lesson.sourceLinks.length && <div><p>Supporting files</p><ul className="mt-1 space-y-1">{lesson.sourceLinks.map(source => <li key={`${source.path}:${source.hash}`} className="break-all">{source.path}</li>)}</ul></div>}
        </li>)}</ul>}
      </>}
      <Link className="inline-block text-foreground underline underline-offset-4" to="/learning">Manage saved lessons</Link>
    </div>
  </Disclosure>;
}
