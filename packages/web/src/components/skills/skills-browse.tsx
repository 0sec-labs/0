import { AddFromGithubSheet, GithubSkillsSection } from "./skills-catalog";

/** Skills > Browse: the GitHub skills directory, filtered by the page's search. "Add from GitHub" opens a review sheet. */
export function SkillsBrowse({ query, addOpen, onAddOpenChange }: { query: string; addOpen: boolean; onAddOpenChange: (open: boolean) => void }) {
  return <>
    <GithubSkillsSection query={query} />
    <AddFromGithubSheet open={addOpen} onOpenChange={onAddOpenChange} />
  </>;
}
