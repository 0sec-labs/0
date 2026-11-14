import type { PanelFix } from "@/console/panel/views/fixes-model";

export type PullRequestRow = { id: string; url: string; title: string; branch: string; baseBranch?: string; findingTitle: string; updatedAt: string };

/** Fixes whose pull request was opened by this engine, newest first. Merge state is not tracked. */
export function pullRequestRows(fixes: readonly PanelFix[]): PullRequestRow[] {
  return fixes
    .filter(entry => Boolean(entry.fix.published?.prUrl))
    .map(({ fix, updatedAt }) => ({ id: fix.id, url: fix.published!.prUrl, title: fix.publication?.title || fix.finding.title, branch: fix.published!.branch, baseBranch: fix.publication?.baseBranch, findingTitle: fix.finding.title, updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The pull request link is only rendered for web URLs. */
export const safePullRequestUrl = (url: string): string | undefined => { try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined; } catch { return undefined; } };
