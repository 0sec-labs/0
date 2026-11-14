/**
 * Commands that moved into a noun group keep working for one release: the old
 * first word is rewritten to its new path and a one-line notice goes to stderr.
 * This is the only deprecation table; delete rows when the grace period ends.
 */
const MOVED: Readonly<Record<string, readonly string[]>> = {
  // → research
  hunt: ["research", "hunt"], "recency-hunt": ["research", "recency-hunt"],
  "assumption-hunt": ["research", "assumption-hunt"], memsafety: ["research", "memsafety"],
  "lens-synth": ["research", "lens-synth"], specdrift: ["research", "specdrift"],
  "protocol-check": ["research", "protocol-check"], "npm-discovery": ["research", "npm-discovery"],
  "js-recon": ["research", "js-recon"], "xnu-fuzz": ["research", "xnu-fuzz"],
  kernel: ["research", "kernel"], cve: ["research", "cve"], intel: ["research", "intel"],
  radar: ["research", "radar"], recon: ["research", "recon"], binary: ["research", "binary"],
  ingest: ["research", "ingest"], exploit: ["research", "exploit"],
  identity: ["research", "identity"], adgraph: ["research", "adgraph"],
  entragraph: ["research", "entragraph"], cloud: ["research", "cloud"], h1: ["research", "h1"],
  // → scan modules
  review: ["scan", "source"], audit: ["scan", "package"], secure: ["scan", "repair"],
  "deep-review": ["scan", "deep"], campaign: ["scan", "campaign"],
  // → runs
  history: ["runs", "history"], replay: ["runs", "replay"], resume: ["runs", "relaunch"],
  timeline: ["runs", "timeline"], orchestrate: ["runs", "orchestrate"],
  // → findings / improve / plugin
  triage: ["findings", "triage"],
  bench: ["improve", "bench"], "routing-qualify": ["improve", "routing-qualify"],
  evolve: ["improve", "evolve"], learning: ["improve", "learning"],
  hackstore: ["plugin", "author"],
};

export interface AliasRewrite { args: string[]; notice: string }

export function rewriteMovedCommand(args: readonly string[]): AliasRewrite | undefined {
  const first = args[0];
  const target = first === undefined ? undefined : MOVED[first];
  if (!target || !Object.hasOwn(MOVED, first!)) return undefined;
  return {
    args: [...target, ...args.slice(1)],
    notice: `[0] \`0 ${first}\` moved to \`0 ${target.join(" ")}\`; the old name will be removed in a future release.`,
  };
}
