# 0 paper workspace

This folder mirrors the noeris paper workflow pattern:

- one living narrative draft (`0.md`)
- one submission-oriented LaTeX draft (`0-submission.tex`)
- split support notes for evaluation and related work

**Status:** unsubmitted research drafts and dated evidence notes, not current
runtime documentation. `evaluation.md` retains an April snapshot while `0.md`
also quotes May results; align provenance explicitly before submission rather
than overwriting historical tables. Current commands and score interpretation
live in the documentation site's benchmark and methodology pages.

## Files

- `0.md` - canonical long-form draft with repo-grounded claims
- `0-submission.tex` - arXiv-style LaTeX draft
- `evaluation.md` - preserved historical summaries
- `evidence/manifest.json` - hashed offline input inventory and missing provenance
- `evidence/claim-map.json` - implemented/proposed/observed claims and limits
- `generated/` - qualified Markdown/LaTeX tables and audit JSON
- `related_work.md` - comparison/citation notes with caveats
- `refs.bib` - bibliography database for LaTeX draft
- `arxiv-checklist.md` - pre-upload checklist
- `build-arxiv-package.sh` - creates minimal source tarball

## Offline evidence audit

From the repository root, run:

```bash
node packages/benchmark/scripts/paper-evidence.mjs
node --test packages/benchmark/scripts/paper-evidence.test.mjs
```

The generator verifies input hashes and fails on changed inputs. It makes no
network or model calls and is separate from ordinary scans. Generated tables
are the qualified numerical surface; historical notes remain dated records.
Missing raw cohorts suppress headlines. Weak classifier labels and row-wise
leakage prevent efficacy claims. No paper has been submitted or published.

## Build

From this directory:

```bash
pdflatex -interaction=nonstopmode "0-submission.tex"
pdflatex -interaction=nonstopmode "0-submission.tex"
```

With bibliography:

```bash
pdflatex -interaction=nonstopmode "0-submission.tex"
bibtex "0-submission"
pdflatex -interaction=nonstopmode "0-submission.tex"
pdflatex -interaction=nonstopmode "0-submission.tex"
```

Create arXiv source package:

```bash
bash "build-arxiv-package.sh"
```

## Claim hygiene

Before any public submission:

1. Re-validate all numbers against latest benchmark artifacts.
2. Stamp every headline number with an as-of date.
3. Keep retained artifact-backed claims separate from historical mixed claims.
4. Avoid cross-project leaderboard comparisons without protocol caveats.
