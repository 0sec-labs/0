import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CapySearchIcon as Search } from "@/ui/icons/capy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddFromGithubSheet, GithubSkillsSection } from "./skills-catalog";

/** Skills > Browse: the GitHub skills directory with its own search and "Add from GitHub". The query lives in the URL (`q`). */
export function SkillsBrowse() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [addOpen, setAddOpen] = useState(false);
  const setQuery = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set("q", value); else next.delete("q"); return next; }, { replace: true });
  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative w-full sm:w-72"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-(--icon-sm) -translate-y-1/2 text-muted-foreground-2" /><Input type="search" aria-label="Search the skills directory" className="pl-9" placeholder="Search the skills directory" autoComplete="off" data-1p-ignore data-lpignore="true" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>Add from GitHub</Button>
    </div>
    <GithubSkillsSection query={query} />
    <AddFromGithubSheet open={addOpen} onOpenChange={setAddOpen} />
  </div>;
}
