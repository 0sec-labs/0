import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

function textContent(children: ReactNode): string {
  let text = "";
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") text += child;
    else if (isValidElement<{ children?: ReactNode }>(child))
      text += textContent(child.props.children);
  });
  return text;
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(textContent(children));
      setStatus("copied");
      timer.current = window.setTimeout(() => setStatus("idle"), 1800);
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className="my-3 overflow-hidden rounded-md border border-border bg-muted/30">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <span>Code</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className={status === "copied" ? "text-primary-text" : undefined}
          onClick={() => void copy()}
          aria-label={status === "failed" ? "Copy failed; try again" : "Copy code"}
        >
          {status === "copied" ? <Check /> : <Copy />}
          <span aria-live="polite">
            {status === "copied"
              ? "Copied"
              : status === "failed"
                ? "Copy failed"
                : "Copy"}
          </span>
        </Button>
      </div>
      {status === "failed" && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          Could not copy code. Select the code below to copy it manually, or try again.
        </p>
      )}
      <pre className="m-0 overflow-x-auto whitespace-pre p-3 font-mono text-xs leading-relaxed text-foreground select-text [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
        {children}
      </pre>
    </div>
  );
}

function SafeLink({ href, children }: { href?: string; children: ReactNode }) {
  let safeHref: string | undefined;
  try {
    if (href && /^https:\/\//i.test(href)) {
      const url = new URL(href);
      if (url.protocol === "https:" && !url.username && !url.password)
        safeHref = url.href;
    }
  } catch {
    // Invalid and non-HTTPS agent-generated links are rendered as plain text.
  }
  if (!safeHref) return <span>{children}</span>;
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-text underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children}
    </a>
  );
}

const components: Components = {
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => (
    <code className={`rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-left [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium">
        {children}
      </table>
    </div>
  ),
};
const plugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed text-foreground [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-muted-foreground [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:my-2 [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold [&_hr]:my-4 [&_hr]:border-border">
      <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
