#!/usr/bin/env node
// Generate GitHub Release notes from docs/CHANGELOG.md (+ optional
// packages/web/src/lib/releases.ts intro). Usage:
//   node scripts/release-notes.mjs [--version 0.29.0] [--out file]
// Exits 1 with a clear message when the version has no changelog entries.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "0sec-labs/0security";
const GROUPS = ["Added", "Changed", "Removed", "Fixed", "Security"];
const MAX_BULLET = 280;
const MAX_PER_GROUP = 12;

export function cliVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
}

/** Returns { version, date, sections: { Name: string[] } } or null. */
export function parseChangelog(text, version) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\](?:\\s*-\\s*(\\S+))?`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const date = lines[start].match(head)[1] ?? null;
  const sections = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) break;
    const h = l.match(/^### (.+?)\s*$/);
    if (h) { current = h[1]; sections[current] = []; continue; }
    if (!current) continue;
    if (/^- /.test(l)) sections[current].push(l.slice(2).trim());
    else if (/^\s+\S/.test(l) && sections[current].length) sections[current][sections[current].length - 1] += " " + l.trim();
  }
  return { version, date, sections };
}

export function cleanBullet(s, max = MAX_BULLET) {
  let t = s.replace(/\[([^\]]+)\]\((?:\/|#)[^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.search(/[.;:](?=[^.;:]*$)/);
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1).replace(/[;:]$/, ".");
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:(\s]+$/, "") + "…";
}

/** Best-effort extraction of one entry from releases.ts without a TS parser. */
export function parseReleasesTs(src, version) {
  const m = new RegExp(`version:\\s*(["'\`])${version.replace(/\./g, "\\.")}\\1`).exec(src);
  if (!m) return null;
  let a = src.lastIndexOf("{", m.index), depth = 0, b = a;
  for (; b < src.length; b++) {
    if (src[b] === "{") depth++;
    else if (src[b] === "}" && --depth === 0) break;
  }
  const block = src.slice(a, b + 1);
  const str = (key, s) => {
    const r = s.match(new RegExp(`\\b${key}:\\s*(?:\\n\\s*)?(["'\`])((?:\\\\.|(?!\\1).)*)\\1`, "s"));
    return r ? r[2].replace(/\\(["'`])/g, "$1") : null;
  };
  const hl = [];
  const hi = block.search(/highlights:\s*\[/);
  if (hi >= 0) {
    for (const o of block.slice(hi).matchAll(/\{[^{}]*\}/g)) {
      const title = str("title", o[0]), text = str("text", o[0]);
      if (title && text) hl.push({ title, text });
    }
  }
  const head = hi >= 0 ? block.slice(0, hi) : block;
  return { title: str("title", head), summary: str("summary", head), highlights: hl };
}

export function buildNotes({ version, changelog, release = null, repo = REPO }) {
  const entry = parseChangelog(changelog, version);
  if (!entry) throw new Error(`docs/CHANGELOG.md has no "## [${version}]" section. Add one before releasing.`);
  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const [name, items] of Object.entries(entry.sections)) {
    if (!GROUPS.includes(name)) continue;
    for (const it of items) {
      const g = /^\*\*Security:?\*\*:?/.test(it) ? "Security" : name;
      groups[g].push(it.replace(/^\*\*Security:?\*\*:?\s*/, ""));
    }
  }
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  if (total === 0) throw new Error(`docs/CHANGELOG.md section [${version}] has no Added/Changed/Removed/Fixed/Security entries. Fill it in before releasing.`);

  const out = [];
  const counts = GROUPS.filter((g) => groups[g].length).map((g) => `${groups[g].length} ${g.toLowerCase()}`);
  const summary = release?.summary
    ?? `0 v${version}${entry.date ? ` (${entry.date})` : ""}: ${counts.join(", ")}.`;
  out.push(release?.title ? `## ${release.title}\n\n${summary}` : summary);
  const hl = release?.highlights?.length
    ? release.highlights.map((h) => `${h.title}: ${h.text}`)
    : (entry.sections.Highlights ?? []);
  if (hl.length) out.push("### Highlights\n\n" + hl.map((h) => `- ${cleanBullet(h)}`).join("\n"));
  for (const g of GROUPS) {
    const items = groups[g];
    if (!items.length) continue;
    const shown = items.slice(0, MAX_PER_GROUP).map((i) => `- ${cleanBullet(i)}`);
    if (items.length > MAX_PER_GROUP) shown.push(`- …and ${items.length - MAX_PER_GROUP} more in the [full changelog](https://github.com/${repo}/blob/v${version}/docs/CHANGELOG.md).`);
    out.push(`### ${g}\n\n${shown.join("\n")}`);
  }
  out.push([
    "### Install",
    "",
    "```bash",
    `curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | bash`,
    "0 --version",
    "```",
    "",
    "Windows (experimental): download `0-windows-x64.exe` below. Docker: `docker run --rm ghcr.io/0sec-labs/0security:latest --help`.",
    "",
    "Verify downloads against the attached `checksums.txt` (SHA-256), for example `sha256sum -c checksums.txt --ignore-missing`.",
    "",
    `Full changelog: https://github.com/${repo}/blob/v${version}/docs/CHANGELOG.md`,
  ].join("\n"));
  return out.join("\n\n") + "\n";
}

export function generate(version, root = ROOT) {
  const changelog = readFileSync(join(root, "docs/CHANGELOG.md"), "utf8");
  const rp = join(root, "packages/web/src/lib/releases.ts");
  const release = existsSync(rp) ? parseReleasesTs(readFileSync(rp, "utf8"), version) : null;
  return buildNotes({ version, changelog, release });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const version = (opt("--version") ?? cliVersion()).replace(/^v/, "");
  try {
    const md = generate(version);
    const out = opt("--out");
    if (out) writeFileSync(out, md); else process.stdout.write(md);
  } catch (e) {
    console.error(`release-notes: ${e.message}`);
    process.exit(1);
  }
}
