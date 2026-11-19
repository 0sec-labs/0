# Scan as a thread

Status: first slice built (`0 scan`, the `scan` skill, a versioned JSON report). Package and image targets, the target extension and the quality comparison with the old pipeline are not done.

### What running it showed

- **Findings come from the store, not the transcript.** The thread's agent may hand recording to a helper agent, so the thread's own tool calls miss findings. The store keys findings by thread id; `0 scan` reads them there (the same read as `findings export --scan`). That read is of the local database, so it does not yet work against a remote engine.
- **The model decides whether it works.** The same one-file scan on `glm-5.3-flash` took 3 to 5 minutes and 842k input tokens, because the model dropped the leading arguments of its `finding` calls and the tool rejected them a dozen times. On `gpt-6-luna` it took 26 seconds, 45k tokens and $0.0014, and recorded the finding first try. `0 scan` therefore defaults to `gpt-6-luna` (`--model` overrides). One file is a weak test; a real repository comparison is still open.
- **Comparison with the old pipeline.** On a six-bug app with two safe decoys (SQL injection, command injection, path traversal, hardcoded JWT secret, SSRF, missing ownership check), the old v0.38 pipeline found 6 of 6 in 185s for $0.027 (one run). The first version of the scan skill found 2 of 6: it told the model to drop findings it could not demonstrate, and the model dropped the SQL injection because the database layer was a stub. After the skill was changed to list every entry point, give each a verdict, and treat stubs and missing dependencies as lower confidence instead of a reason to drop, three concurrent runs found 5, 6 and 6 of 6, with no false positive on either decoy, at about $0.006 each. One app of this size is a small test; the open question below about real repositories stands.
- **Another scan's finding must not swallow this one.** The duplicate check compared against every stored finding of the same category in the database. Threads share one database, so a repeat scan, or a scan of another customer's code, could be merged into an older finding and then be missing from its own report. Console threads now set `dedupeScope: "scan"`, so only the same scan's findings count.
- **A category we do not list becomes `other`.** A model wrote a category outside the list, the stored finding failed the strict read, and the whole report failed. The finding tool now keeps the finding as `other` and records the model's label in the description, and the report read skips an unreadable row with a warning instead of failing.
- **A real repository.** OWASP NodeGoat (an intentionally vulnerable Node app, scanned by git URL) took the old v0.38 pipeline 198s and $0.035 for 5 findings (eval injection, `$where` injection, ReDoS, SSRF, allocations IDOR). `0 scan` took about 2 to 3 minutes and $0.05 to $0.065 and found the same classes plus more of NodeGoat's documented problems: admin-route bypass, plaintext passwords, CSRF, a weak session secret, open redirect, stored XSS and session fixation, depending on the run. Run to run it varies: one run missed the ReDoS the others found. Before the location rule below, 17 findings were about 8 distinct issues.
- **One flaw, several titles.** Helper agents describe the same flaw in different words, so title and evidence matching did not merge them. Findings of one scan now also merge by place: overlapping cited lines in one file merge whatever the category, and lines within two of each other merge in the same category. This applies to threads only (`dedupeScope: "scan"`), on both the direct save and the helper-agent save; before this, the helper-agent save still compared against the whole database.
- **No `verify:` on the scan skill.** `--skill`/`verifySkill` only accepts a skill that declares a check, and a scan has none. The prompt tells the thread to load the skill instead.
- **Timeout and budget stops keep their findings.** On the time limit the thread is cancelled and a partial report is printed (`status: timed_out`, exit 3); the budget stop is `status: budget_exhausted`, exit 3.
- **Console and remote engines.** `0 scan` uses the console that is running (or the one named by `--engine-url` or `--computer`). With none running it starts a headless one for the scan and stops it afterwards. The report is read through the engine's `GET /api/scans/:id/export?format=json`, so it works on a remote engine too (the remote path is covered by tests and by the same code the local path runs; it was not run against a real remote engine).

A scan is a thread that follows a scan skill and records findings. There is no separate scan pipeline.

## Why

Until v0.38 there were two systems:

- `0 scan <target>` ran a fixed pipeline (discovery, attack, verify, report) inside the engine and wrote a report. It was not a thread.
- Threads were conversations with an agent and had no one-shot "scan this code base" form.

#409 removed the pipeline, the kernel, triage, review, disclose and the rest of the security engine (archived on `archive/security-engine`, about 1,200 files). `0 scan` went with it. Some customers drive the old `0 scan` from their own tooling to scan a code base, add suggested fixes and show the result to regulated clients. They need a one-shot scan back, without bringing back a second system.

## What already exists on main

| Need | Already there |
| --- | --- |
| Run an agent on a folder, wait, stop at a budget | `threads start --folder --wait --cost-ceiling --timeout` |
| Record a finding | the `finding` tool (title, severity, category, evidence, status) |
| Findings store and browsing | `findings list\|show\|update` |
| One export flag | `findings export --format json\|md\|sarif\|html\|pdf`, by finding id or `--scan <id>` |
| Prove a fix | skill `verify:` spec and the claim gate (`docs/design/fix-verification.md`) |
| Methodology on demand | skills (`agent/skills/vulnerabilities`, `techniques`) |
| Tools from outside the engine | extensions (MCP and others) |

Missing: the scan skill, a one-command front door, preparing a non-local target, and a stable JSON shape.

## Design

### 1. The scan skill replaces the pipeline

One built-in skill, `scan`, holds the method as markdown: map the code base, read the risky paths, form a hypothesis, prove it, record a finding, then try to disprove each finding before keeping it. It points at the existing vulnerability and technique skills with `load_skill`. Its `verify:` spec is what lets a thread claim "Verified".

The old phases (discovery, attack, verify, report) become steps in the skill's instructions, not code. The deleted `stages/` (126 files) is a source of methodology to copy from selectively. Candidates worth reviewing before porting:

- the evidence ledger and candidate identity (stable ids so a re-scan matches earlier findings);
- adversarial review of each finding before it is kept;
- semantic dedupe of findings;
- the novelty gate (does a published advisory already cover it).

Everything else in the archive stays archived.

### 2. `0 scan <target>` is a thin command

```
0 scan <target> [--budget <usd>] [--format json|md|sarif|html|pdf] [-o <file>]
```

It does four things and holds no scan logic:

1. Resolve the target to a folder (below).
2. `threads start --skill scan --folder <dir> --cost-ceiling <budget> --wait`.
3. The thread appears in `0 threads` and in the web app like any other.
4. Print `findings export --scan <id> --format <fmt>`.

`--depth` goes away. `--budget` is the only knob and defaults to $5 as before. A time limit stays as `--timeout`.

### 3. Findings are the single output

The thread records findings through the `finding` tool. A scan report is an export of that thread's findings, nothing more. CI, the web app and the customer's wrapper read the same store, so a finding reviewed in the web app is the one in the export.

### 4. Targets are a folder or a git URL

`0 scan` takes a folder or a git URL (cloned shallow into a temporary folder with hooks and external transports off, removed afterwards). Package names and container images are out of scope: to scan a dependency, fetch its source and scan the folder. A name that is not a folder is an error, never a guess.

### 5. A stable JSON shape

The JSON export is the contract for people who wrap `0 scan`. Today it is whatever `exportReport` produces. Proposal:

- Version it (`schemaVersion`) and document it.
- Fields: scan id, target, started and finished times, budget and cost, per-finding id, title, severity, category, status, location, evidence, suggested fix, `verified` (from the verifier gate), and the thread id.
- Keep the old field names where they were not wrong, so a wrapper changes as little as possible. Which names that covers needs a sample from a real customer.

### 6. Exit codes

`0` complete, no findings at or above a `--fail-on <severity>` threshold; `1` findings at or above it, or a claim the verifier did not back; `2` usage or target error; `3` budget exhausted (partial findings are still exported). Wrappers need this to branch without parsing output.

## What this removes

The scan pipeline, `engagement-plan`, the `--module` and alias layers and `--depth` are not coming back. Scan, Sentinel runs and CI all use one entry (a thread with a skill).

## Open questions

- **Big code bases.** A single context cannot hold a large repo. Does the skill split the work across sub-agents, or does `0 scan` start one thread per top-level area? Sub-agents exist in threads today; not tested.
- **Determinism.** Customers in regulated industries will want repeatable runs. Models are not deterministic. What do we promise: the same fingerprint for the same flaw in unchanged code, or only that confirmed findings carry evidence?
- **Verification without a container.** `verify:` needs Docker or podman to count as Verified. A scan has no check of its own today, so its findings are "discovered", not "verified".

## Plan

Done: the `scan` skill, `0 scan` (folder or git URL, `--budget`, `--format`, `--fail-on`, `--timeout`), the versioned JSON report, a report read that skips unreadable rows and says so, and a comparison with the old v0.38 scanner on a planted-bug app (see below).

Next:

1. Run the comparison on more real repositories at fixed commits (so far: one planted-bug app and NodeGoat), and measure how much a finding set varies between runs of the same commit.
2. Port individual stages from the archive only where a comparison shows a gap.
3. Decide how a large repository is split.
