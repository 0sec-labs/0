#!/usr/bin/env node
// Refreshes packages/cli/src/web/skills-catalog.generated.json from scripts/skills-catalog-sources.json.
// Read-only: only `gh api` GET calls and one avatar download per publisher. Nothing from the listed repositories
// is executed, and no third-party skill text is bundled: the catalog holds metadata and a pinned commit SHA.
// Usage: node scripts/refresh-skills-catalog.mjs [--out <file>] [--sources <file>]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const YAML = require("yaml");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const outFile = option("--out", fileURLToPath(new URL("../packages/cli/src/web/skills-catalog.generated.json", import.meta.url)));
const sourcesFile = option("--sources", fileURLToPath(new URL("./skills-catalog-sources.json", import.meta.url)));

// Keep in step with packages/cli/src/web/skills-catalog.ts (a test asserts the generated file obeys the same rule).
const LIMITS = { files: 128, bytes: 4 * 1024 * 1024, skillMd: 128 * 1024 };
const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "CC-BY-SA-4.0", "CC-BY-SA-3.0", "Unlicense", "0BSD", "Zlib", "BlueOak-1.0.0"]);
const ACRONYMS = new Map(Object.entries({ api: "API", pr: "PR", ctf: "CTF", cvss: "CVSS", owasp: "OWASP", sarif: "SARIF", yara: "YARA", mcp: "MCP", ui: "UI", ci: "CI", cd: "CD", tdd: "TDD", gha: "GHA", ai: "AI", llm: "LLM", pwn: "Pwn", fp: "FP", sql: "SQL", xss: "XSS", adr: "ADR", adrs: "ADRs" }));
const MAX_AVATAR_BYTES = 6 * 1024;
const FRESH_MS = 365 * 24 * 3600 * 1000;
const SECURITY = /secur|vuln|pentest|owasp|semgrep|threat model|exploit|\bctf\b|fuzz|cvss|malware|forensic|injection|\bxss\b|taint|sast|yara|cve\b/i;
const SECURITY_PUBLISHERS = new Set(["trailofbits", "semgrep"]);

const gh = path => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
const titleCase = name => name.split(/[-_]+/).filter(Boolean).map(word => ACRONYMS.get(word.toLowerCase()) ?? word[0].toUpperCase() + word.slice(1)).join(" ");

function classify(text) {
  if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(text) && /MIT License|THE SOFTWARE IS PROVIDED "AS IS"/i.test(text)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  return null;
}
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  try { const data = YAML.parse(match[1]); return data && typeof data === "object" ? data : null; } catch { return null; }
}
const blob = (repo, sha) => Buffer.from(gh(`repos/${repo}/git/blobs/${sha}`).content, "base64");

function avatar(owner, work) {
  try {
    const source = join(work, `${owner}.src`);
    execFileSync("curl", ["-fsSL", "--max-time", "20", "-o", source, `https://github.com/${owner}.png?size=88`], { stdio: "ignore" });
    for (const [format, size, extra] of [["png", 64, []], ["jpeg", 64, ["-s", "formatOptions", "70"]], ["jpeg", 48, ["-s", "formatOptions", "60"]]]) {
      const out = join(work, `${owner}.${format}`);
      try { execFileSync("sips", ["-s", "format", format, "-Z", String(size), ...extra, source, "--out", out], { stdio: "ignore" }); } catch { return ""; }
      if (statSync(out).size <= MAX_AVATAR_BYTES) return `data:image/${format};base64,${readFileSync(out).toString("base64")}`;
    }
  } catch { /* no network or no sips: the web view falls back to a monogram */ }
  return "";
}

const sources = JSON.parse(readFileSync(sourcesFile, "utf8")).sources;
const work = mkdtempSync(join(tmpdir(), "skills-catalog-"));
const publishers = {}; const skills = []; const notes = [];
try {
  for (const source of sources) {
    const { repo } = source; const [owner] = repo.split("/");
    let meta;
    try { meta = gh(`repos/${repo}`); } catch { notes.push(`${repo}: not readable, skipped`); continue; }
    if (meta.private || meta.archived || meta.fork) { notes.push(`${repo}: private, archived or a fork, skipped`); continue; }
    if (Date.now() - Date.parse(meta.pushed_at) > FRESH_MS) { notes.push(`${repo}: no push in 12 months, skipped`); continue; }
    const branch = meta.default_branch; const commit = gh(`repos/${repo}/commits/${branch}`).sha;
    const tree = gh(`repos/${repo}/git/trees/${commit}?recursive=1`);
    if (tree.truncated) { notes.push(`${repo}: tree truncated, skipped`); continue; }
    if (!publishers[owner]) {
      let name = owner; try { name = gh(`users/${owner}`).name || owner; } catch { /* keep login */ }
      publishers[owner] = { name, url: `https://github.com/${owner}`, avatar: avatar(owner, work) };
    }
    const repoSpdx = meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : null;
    const entries = tree.tree.filter(item => item.type === "blob" || item.type === "commit" || item.mode === "120000");
    const roots = entries.filter(item => /(^|\/)SKILL\.md$/.test(item.path) && !/(^|\/)(tests?|fixtures|examples?)\//.test(item.path)).map(item => item.path.replace(/\/?SKILL\.md$/, ""));
    for (const folder of roots.sort()) {
      const slug = folder.split("/").pop() || repo.split("/")[1];
      if (source.include && !source.include.includes(slug)) continue;
      const prefix = folder ? `${folder}/` : "";
      const files = entries.filter(item => folder ? item.path.startsWith(prefix) : true);
      if (files.some(item => item.mode === "120000" || item.type === "commit")) { notes.push(`${repo}/${folder}: symlink or submodule, dropped`); continue; }
      const bytes = files.reduce((total, item) => total + (item.size ?? 0), 0);
      const skillMd = files.find(item => item.path === `${prefix}SKILL.md`);
      if (!skillMd || skillMd.size > LIMITS.skillMd || files.length > LIMITS.files || bytes > LIMITS.bytes) { notes.push(`${repo}/${folder}: over the size caps, dropped`); continue; }
      const meta2 = frontmatter(blob(repo, skillMd.sha).toString("utf8"));
      const name = typeof meta2?.name === "string" ? meta2.name : slug; const description = typeof meta2?.description === "string" ? meta2.description.replace(/\s+/g, " ").trim() : "";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || !description) { notes.push(`${repo}/${folder}: invalid frontmatter, dropped`); continue; }
      let licence = repoSpdx; let licenceSource = repoSpdx ? "repository" : "none"; let licenceFile = null;
      const licenceItem = files.find(item => /^LICEN[CS]E(\.(txt|md))?$/i.test(item.path.slice(prefix.length)));
      if (licenceItem && licenceItem.size < 64 * 1024) {
        licenceFile = licenceItem.path.slice(prefix.length);
        const found = classify(blob(repo, licenceItem.sha).toString("utf8"));
        licence = found; licenceSource = found ? "skill folder" : "skill folder (custom terms)";
      }
      const topics = (meta.topics ?? []).join(" ");
      skills.push({
        id: `${owner}~${repo.split("/")[1]}~${name}`, name, title: titleCase(name), summary: description.length > 280 ? `${description.slice(0, 277)}...` : description,
        repo, path: folder, ref: branch, commit, publisher: owner, verified: true,
        stars: meta.stargazers_count, pushedAt: meta.pushed_at, licence, licenceSource, ...(licenceFile ? { licenceFile } : {}),
        installable: licence !== null && PERMISSIVE.has(licence),
        security: Boolean(source.security) || SECURITY_PUBLISHERS.has(owner) || SECURITY.test(`${name} ${description} ${topics}`),
        files: files.length, bytes, hasScripts: files.some(item => /(^|\/)scripts\//.test(item.path) || /\.(sh|py|js|mjs|ts|rb|ps1|bat)$/.test(item.path)),
      });
    }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
skills.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
writeFileSync(outFile, `${JSON.stringify({ generated: new Date().toISOString(), publishers, skills }, null, 2)}\n`);
console.log(`${skills.length} skills from ${new Set(skills.map(skill => skill.repo)).size} repositories -> ${outFile}`);
for (const note of notes) console.log(`note: ${note}`);
