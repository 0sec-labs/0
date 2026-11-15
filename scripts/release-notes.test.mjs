import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNotes, parseChangelog, cleanBullet, parseReleasesTs } from "./release-notes.mjs";
import { checkRelease } from "./check-release-notes.mjs";

const CL = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-01-02

### Highlights

- Big thing.

### Added

- Add a [thing](/thing/) to the app.

### Changed

- **Security:** harden the gate
  across two lines.
- Rename x.

### Fixed

- Fix y.

### Tests

- Skipped group.

## [1.1.0] - 2026-01-01

### Fixed

- Old.
`;
const TS = `export const RELEASES: Release[] = [
  { version: "1.2.0", date: "2026-01-02", title: "Big one", summary: "A \\"great\\" release.",
    highlights: [{ icon: "star", title: "Stars", text: "Shiny." }] },
];`;

test("parseChangelog joins continuations and stops at next section", () => {
  const e = parseChangelog(CL, "1.2.0");
  assert.equal(e.date, "2026-01-02");
  assert.deepEqual(e.sections.Changed[0], "**Security:** harden the gate across two lines.");
  assert.equal(e.sections.Fixed.length, 1);
  assert.equal(parseChangelog(CL, "9.9.9"), null);
});

test("buildNotes groups, moves Security, strips relative links, adds footer", () => {
  const md = buildNotes({ version: "1.2.0", changelog: CL });
  assert.match(md, /^0 v1\.2\.0 \(2026-01-02\): 1 added, 1 changed, 1 fixed, 1 security\./);
  assert.match(md, /### Security\n\n- harden the gate across two lines\./);
  assert.match(md, /- Add a thing to the app\./);
  assert.doesNotMatch(md, /Skipped group/);
  assert.match(md, /### Highlights\n\n- Big thing\./);
  assert.match(md, /install\.sh \| bash/);
  assert.match(md, /0 --version/);
  assert.match(md, /checksums\.txt/);
  assert.match(md, /blob\/v1\.2\.0\/docs\/CHANGELOG\.md/);
});

test("releases.ts entry supplies the intro", () => {
  const r = parseReleasesTs(TS, "1.2.0");
  assert.equal(r.title, "Big one");
  assert.equal(r.summary, 'A "great" release.');
  assert.deepEqual(r.highlights, [{ title: "Stars", text: "Shiny." }]);
  assert.equal(parseReleasesTs(TS, "0.0.1"), null);
  const md = buildNotes({ version: "1.2.0", changelog: CL, release: r });
  assert.match(md, /^## Big one\n\nA "great" release\./);
  assert.match(md, /- Stars: Shiny\./);
});

test("missing and empty (Unreleased-only) sections throw", () => {
  assert.throws(() => buildNotes({ version: "9.9.9", changelog: CL }), /no "## \[9\.9\.9\]" section/);
  assert.throws(() => buildNotes({ version: "Unreleased", changelog: CL }), /no Added/);
});

test("long bullets are trimmed and long groups capped", () => {
  assert.ok(cleanBullet("word ".repeat(200)).length <= 281);
  const many = Array.from({ length: 15 }, (_, i) => `- Fix ${i}.`).join("\n");
  const md = buildNotes({ version: "2.0.0", changelog: `## [2.0.0] - 2026-02-01\n\n### Fixed\n\n${many}\n` });
  assert.match(md, /…and 3 more/);
});

function fixture(withTs, tsVersion = "1.2.0") {
  const d = mkdtempSync(join(tmpdir(), "rn-"));
  mkdirSync(join(d, "docs")); mkdirSync(join(d, "packages/cli"), { recursive: true });
  writeFileSync(join(d, "docs/CHANGELOG.md"), CL);
  writeFileSync(join(d, "packages/cli/package.json"), JSON.stringify({ version: "1.2.0" }));
  if (withTs) {
    mkdirSync(join(d, "packages/web/src/lib"), { recursive: true });
    writeFileSync(join(d, "packages/web/src/lib/releases.ts"), TS.replace("1.2.0", tsVersion));
  }
  return d;
}

test("guard: passes, skips absent releases.ts, fails on missing entries", () => {
  assert.deepEqual(checkRelease(fixture(false)).errors, []);
  assert.deepEqual(checkRelease(fixture(true)).errors, []);
  assert.match(checkRelease(fixture(true, "1.1.9")).errors[0], /releases\.ts has no entry/);
  const d = fixture(false);
  writeFileSync(join(d, "packages/cli/package.json"), JSON.stringify({ version: "3.0.0" }));
  assert.match(checkRelease(d).errors[0], /no "## \[3\.0\.0\]"/);
});
