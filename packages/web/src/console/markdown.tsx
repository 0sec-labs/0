import {
  Children,
  createContext,
  useContext,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HighlightedCode } from "./formatted-code";
import { VizFence } from "./viz/visualization";
import { vizKindForFence } from "./viz/parse";
import { prepareMarkdown } from "./markdown-guard";
import "./markdown.css";
import { InlineImage, imageSource } from "./inline-image";
import { streamWordFade } from "./streaming-text";
import { ScrollFade } from "./scroll-fade";

const StreamingContext = createContext(false);

/** Avoid mounting an empty code panel while its fence language is arriving. */
export function streamingMarkdown(text: string): string {
  const lines = text.split("\n");
  let fence: { character: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const suffix = match[2]!;
    if (fence) {
      if (marker[0] === fence.character && marker.length >= fence.length && /^\s*$/.test(suffix))
        fence = undefined;
    } else if (marker[0] !== "`" || !suffix.includes("`")) {
      // Hold the unfinished declaration until its first newline arrives.
      // Final messages always use the original text, including literal fences.
      if (index === lines.length - 1) return lines.slice(0, -1).join("\n");
      fence = { character: marker[0]!, length: marker.length };
    }
  }
  return text;
}

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
  const streaming = useContext(StreamingContext);
  const child = Children.toArray(children).find(isValidElement);
  const language = isValidElement<{ className?: string }>(child) ? /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? "" : "";
  const plain = <PlainCodeBlock language={language}>{children}</PlainCodeBlock>;
  // Visualization fences (mermaid, graph, chart, timeline, table) render through the viz registry and fall back to the plain block.
  return vizKindForFence(language)
    ? <VizFence language={language} source={textContent(children).replace(/\n$/, "")} streaming={streaming} fallback={plain} />
    : plain;
}

function PlainCodeBlock({ children, language }: { children: ReactNode; language: string }) {
  const source = textContent(children);
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
    <div data-slot="code-block" className="group/code relative my-3 min-w-0 overflow-hidden rounded-[var(--radius-card,8px)] border-[0.5px] border-border-1 bg-card">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={`absolute top-1 right-1 z-10 bg-card/80 opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100${status === "copied" ? " text-primary-text" : ""}`}
        onClick={() => void copy()}
        aria-label={status === "failed" ? "Copy failed; try again" : "Copy code"}
      >
        {status === "copied" ? <Check /> : <Copy />}
        <span className="sr-only" aria-live="polite">
          {status === "copied"
            ? "Copied"
            : status === "failed"
              ? "Copy failed"
              : "Copy"}
        </span>
      </Button>
      {status === "failed" && (
        <p role="alert" className="px-2.5 py-1.5 text-xs text-destructive">
          Could not copy code. Select the code below to copy it manually, or try again.
        </p>
      )}
      <ScrollFade className="max-h-72">
        <pre className="m-0 w-fit min-w-full whitespace-pre px-2.5 py-1.5 font-mono text-xs leading-5 text-foreground select-text [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
          <HighlightedCode source={source} language={language} />
        </pre>
      </ScrollFade>
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
  img: ({ src, alt }) => <InlineImage src={typeof src === "string" ? src : ""} alt={alt || "Screenshot"} />,
  p: ({ children }) => <div className="my-2 first:mt-0 last:mb-0">{children}</div>,
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => (
    <code className={`rounded-md bg-secondary px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-3 [&_td]:text-left [&_th]:border-b [&_th]:border-border [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-semibold">
        {children}
      </table>
    </div>
  ),
};
const plugins = [remarkGfm];
const streamingPlugins = [remarkGfm, streamWordFade];

/** Follow incoming chunks continuously rather than restarting the easing on every token. */
function useStreamedText(text: string, streaming: boolean): string {
  const [displayed, setDisplayed] = useState(text);
  const target = useRef(text);
  const shown = useRef(text);
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => {
    target.current = text;
    const commit = (next: string) => { shown.current = next; setDisplayed(next); };
    if (!streaming || !text.startsWith(shown.current)) {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      commit(text);
      return;
    }
    if (frame.current !== undefined || shown.current.length === text.length) return;
    let lastFrame = performance.now();
    let position = shown.current.length;
    const reveal = (now: number) => {
      const elapsed = now - lastFrame;
      if (elapsed >= 32) {
        const latest = target.current;
        position += (latest.length - position) * (1 - Math.exp(-elapsed / 55));
        let end = latest.length - position < 1 ? latest.length : Math.floor(position);
        // Never reveal half an emoji or move backwards after a surrogate adjustment.
        end = Math.max(end, shown.current.length);
        const last = latest.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end++;
        commit(latest.slice(0, end));
        lastFrame = now;
        if (end >= latest.length) { frame.current = undefined; return; }
      }
      frame.current = requestAnimationFrame(reveal);
    };
    frame.current = requestAnimationFrame(reveal);
  }, [text, streaming]);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);
  return streaming && text.startsWith(displayed) ? displayed : text;
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const displayed = useStreamedText(text, streaming);
  const prepared = prepareMarkdown(streaming ? displayed : text);
  if (prepared.plain)
    return <div className="console-markdown min-w-0 whitespace-pre-wrap break-words wrap-anywhere text-sm leading-relaxed text-foreground">{prepared.text}</div>;
  return (
    <div data-streaming={streaming || undefined} className="console-markdown min-w-0 break-words wrap-anywhere text-sm leading-relaxed text-foreground [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-muted-foreground [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:my-2 [&_h4]:font-semibold [&_h5]:my-2 [&_h5]:font-semibold [&_h6]:my-2 [&_h6]:font-semibold [&_hr]:my-4 [&_hr]:border-border">
      <StreamingContext.Provider value={streaming}><ReactMarkdown remarkPlugins={streaming ? streamingPlugins : plugins} components={components} urlTransform={(url, key) => key === "src" ? imageSource(url) || "" : defaultUrlTransform(url)} skipHtml>
        {streaming ? streamingMarkdown(prepared.text) : prepared.text}
      </ReactMarkdown></StreamingContext.Provider>
    </div>
  );
});
