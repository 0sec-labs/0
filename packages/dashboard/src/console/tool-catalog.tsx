import { useState } from "react";
import type { ConsoleSessionSnapshot } from "@0/shared";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";

type Tool = ConsoleSessionSnapshot["tools"][number];

export function filterToolCatalog(tools: Tool[], query: string): Tool[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter(tool => terms.every(term => `${tool.name} ${tool.description}`.toLowerCase().includes(term)));
}

export function toolCatalogGroup(name: string): string {
  return name.startsWith("mcp__zeroverse__") ? "0verse" : name.startsWith("mcp__") ? "Extensions" : "Built-in tools";
}

export function ToolCatalog({ tools }: { tools: Tool[] }) {
  const [query, setQuery] = useState("");
  if (!tools.length) return null;
  const matches = filterToolCatalog(tools, query);
  return <Disclosure className="space-y-2 pt-2" summary={<>Available tools · {tools.length}</>} triggerClassName="cursor-pointer text-sm font-medium text-foreground">
    <div className="mt-2 space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">Tools this chat can use. This count does not show how many have run.</p>
      <Input aria-label="Search available tools" placeholder="Search tools" value={query} onChange={event => setQuery(event.target.value)} />
      {query.trim() && <p className="text-xs text-muted-foreground" role="status">{matches.length} of {tools.length} tools</p>}
      {["Built-in tools", "0verse", "Extensions"].map(group => {
        const grouped = matches.filter(tool => toolCatalogGroup(tool.name) === group);
        return grouped.length ? <Disclosure key={group} open={query.trim() ? true : undefined} summary={<>{group} · {grouped.length}</>} triggerClassName="py-1 text-xs font-medium text-muted-foreground">
          <div className="space-y-2 pt-2">{grouped.map(tool => <ToolDetail key={tool.name} tool={tool} />)}</div>
        </Disclosure> : null;
      })}
    </div>
  </Disclosure>;
}

function ToolDetail({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  return <Disclosure open={open} onOpenChange={setOpen} className="rounded-[var(--radius-panel)] bg-muted/30 p-3 text-xs" summary={tool.name.replace(/^mcp__zeroverse__/, "")} triggerClassName="rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer font-medium">
    {open && <><p className="mt-2 leading-5 text-muted-foreground">{tool.description}</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(tool.inputSchema, null, 2)}</pre></>}
  </Disclosure>;
}
