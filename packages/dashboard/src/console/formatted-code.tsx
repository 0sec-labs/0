import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

export function HighlightedCode({ source, language }: { source: string; language: string }) {
  const [highlighted, setHighlighted] = useState<{ source: string; language: string; html: string }>();
  useEffect(() => {
    let cancelled = false;
    if (source.length <= 30_000 && language) {
      void import("highlight.js/lib/common").then(({ default: hljs }) => {
        if (!cancelled && hljs.getLanguage(language)) {
          setHighlighted({ source, language, html: hljs.highlight(source, { language, ignoreIllegals: true }).value });
        }
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [source, language]);
  // highlight.js escapes input before adding its own span markup. Unknown
  // languages and large inputs remain ordinary escaped React text.
  return highlighted?.source === source && highlighted.language === language
    ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted.html }} />
    : <code>{source}</code>;
}

export function MermaidDiagram({ source, streaming }: { source: string; streaming: boolean }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [result, setResult] = useState<{ source: string; svg?: string; failed?: boolean }>();
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (streaming) return;
    // Strict mode sanitizes SVG but image shapes can fetch resources BEFORE
    // sanitization. Keep external resources, custom shapes/config and HTML in
    // the escaped source view; never invoke Mermaid on those inputs.
    if (source.length > 10_000 || /%%\s*\{|^\s*---|@\s*\{|!\s*\[|<\s*\/?[a-z]|&(?:#[\da-fx]+|[a-z]+);|(?:https?|data|blob|file|javascript|vbscript|ftp):/im.test(source)) {
      setResult({ source, failed: true });
      return;
    }
    void import("mermaid").then(async ({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
        maxTextSize: 10_000, maxEdges: 100, htmlLabels: false,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
        secure: ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "suppressErrorRendering"],
      });
      const { svg } = await mermaid.render(id, source);
      if (!cancelled) setResult({ source, svg });
    }).catch(() => { if (!cancelled) setResult({ source, failed: true }); });
    return () => { cancelled = true; };
  }, [source, streaming, id]);
  const current = result?.source === source ? result : undefined;
  return <div className="min-w-0">
    {!streaming && current?.svg && <div className="flex justify-end px-3 pt-2"><Button type="button" size="xs" variant="ghost" onClick={() => setShowSource(value => !value)}>{showSource ? "Show diagram" : "Show source"}</Button></div>}
    {!streaming && current?.svg && !showSource
      ? <div role="img" aria-label="Mermaid diagram" className="overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: current.svg }} />
      : <><p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{streaming ? "Diagram source · streaming" : current?.failed ? "Diagram could not render. Source is available below." : showSource ? "Diagram source" : "Rendering diagram…"}</p><pre className="overflow-x-auto whitespace-pre p-3 font-mono text-xs"><code>{source}</code></pre></>}
  </div>;
}
