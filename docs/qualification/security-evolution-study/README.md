# Issue 120: experimental source-review study controller

This is experimental, opt-in controller infrastructure, not a qualified model-backed
pilot. All committed observations use deterministic controls and no model calls.
Issue #120 remains open. The runner always reports `conclusion: inconclusive`;
these artifacts cannot establish security efficacy, promote an artifact or enable
production optimization.

#120 tracks a finite product go/no-go decision. A separately approved, independently
adjudicated pilot may conclude negative or inconclusive and retain the baseline;
no repeated expansion is required to obtain a positive result. The merged
retention/provenance/exposure/accounting safeguards are implementation prerequisites,
not separate evidence of optimizer benefit. Optional archive, feedback-summary and
proposal-width studies remain deferred until a useful baseline and an observed
bottleneck justify a separate comparison.

The controller exercises a preregistered measurement path for one narrow workflow:
JavaScript prototype-pollution source review. It uses the existing trusted
`LlmApiRuntime` provider route and `ObjectiveOracle` finding-match evaluator.
The width-one proposal uses production `proposeEvolutionEdits`, with its strict edit schema and immutable snapshot, restricted to a single skill file and one charged model turn. Candidate changes are bounded skill text, never executable code, and receive no
tools, credentials or filesystem access. No production optimizer is enabled.

The curated source corpus excludes all embargo and pending-disclosure entries in
`corpus-v1.json`. It uses six independent public package/advisory families, exact
vulnerable/fixed version pairs, registry SHA-512 integrity and exact source hashes:

| Split | Package family | Public advisory | Vulnerable / fixed |
| --- | --- | --- | --- |
| Development | json5 | GHSA-9c47-m6qq-7p4h | 2.2.1 / 2.2.2 |
| Development | minimist | GHSA-xvch-5gv4-984h | 1.2.5 / 1.2.6 |
| Selection | y18n | GHSA-c4w7-xm78-47vh | 4.0.0 / 4.0.1 |
| Selection | qs | GHSA-hrpp-h998-j3pp | 6.10.2 / 6.10.3 |
| Final | hoek | GHSA-jp4x-w63m-7wgm | 5.0.2 / 5.0.3 |
| Final | lodash | GHSA-p6mc-m468-83gw | 4.17.15 / 4.17.19 |

Preparation checks the advisory's affected range and first patched version,
rejects withdrawn advisories, downloads only allowlisted HTTPS registry/GitHub
hosts, validates tarball integrity and extracts exact regular source entries in
memory. It runs no package installation scripts. Three small structural clean
controls exercise JSON.parse, Object.fromEntries and null-prototype destinations.
These are language-semantics controls, not claims that an arbitrary package is
free of every vulnerability. Fixed labels concern the selected advisory only.
Family and identical-source leakage across splits are rejected. Identical source
cannot carry conflicting vulnerable/fixed labels, even within one split.

The earlier control artifact was invalidated: lodash 4.17.18 and 4.17.19 had
identical selected helper files despite opposite labels. The corrected selection
uses the `baseSet` region from `lodash.js` in 4.17.15 and 4.17.19, plus its
assignment helpers. `corpus-manifest.json` records full-file hashes, selected-byte
hashes, exact character offsets and selector boundaries for replay. Admission
checks selected bytes against this manifest; preparation verifies upstream package
identity and tarball integrity. This is an operator-curated corpus, not an
independent adjudication of every selected snippet's vulnerability semantics.
The source-pattern oracle matches a label and literal sink; `verifiedCorrect`
means agreement with that oracle, not executable vulnerability reproduction.
Independent semantic curation and vulnerability-proof qualification remain open.

The protocol hashes the loaded study scripts, runtime, production proposer and evaluator bytes. Changing them invalidates preregistration before dispatch.

The final set is public historical material and may appear in model training data.
It is sealed from the *study proposer*, not secret from the Internet. Only
positive-case development feedback and the current skill enter the proposal call.
All negative controls, including development negatives, remain controller-only.
Do not give the proposer this controller source, corpus file or final report.
`sourceTask()` passes only source bytes/digest to evaluated workers. Controller
reports retain case-level evidence; do not add those reports to candidate archives.

## Reproduction

Build the existing runtime/oracle first (`pnpm build`). Choose new output paths;
files/ledgers are exclusive-created to prevent accidental replay.

```sh
node scripts/run-security-evolution-study.mjs prepare --output /tmp/study-corpus.json
node scripts/run-security-evolution-study.mjs preregister --corpus /tmp/study-corpus.json --output /tmp/study-protocol.json --budget-usd 20 --call-ceiling-usd 0.1 --repeats 2
node scripts/run-security-evolution-study.mjs controls --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --output /tmp/study-controls.json
node scripts/run-security-evolution-study.mjs controls --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --output /tmp/study-unknown-usage.json --unknown-usage-at 1
node --test scripts/security-evolution-study.test.mjs
```

Preparation is networked corpus retrieval; controls invoke no model API. The
preregistered default reserves at most 132 calls / $13.20 under a $20 campaign cap,
including all declared final evaluation calls. Frozen baseline, one sequential
proposal, A/A, injected regression and frozen-baseline extra attempts are declared
before outcomes. The extra-attempt arm receives the same maximum additional
call/spend allocation as candidate development plus proposal generation. Actual
charges can differ and are reported separately; equal generations or concurrency
are not asserted to be equal actual spend. Development screening freezes the
artifact before private selection/final evaluation. Private outcomes never request
another draft. The regression control corrupts an already-metered response, so it
cannot evade accounting.

Paid execution is explicit and requires an operator-approved cap; do not run this
command before that approval:

```sh
node scripts/run-security-evolution-study.mjs run --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --output /tmp/study-provider.json --approved-budget-usd 20
```

The only admitted provider/model is a dated `gpt-4.1-mini-YYYY-MM-DD` snapshot on
OpenAI's existing runtime route. Output is bounded at the runtime's existing
8,192-token limit; unbounded internal retries are disabled. Input bytes plus a
framing reserve give a conservative tariff bound before dispatch. Every dispatch
reserves its ceiling in an fsynced ledger before the call. Unknown usage keeps
that reservation indeterminate and stops further dispatch. An existing ledger
cannot be resumed blindly; reconcile it first. This is a supervised finite study,
not a replacement for #41's unattended recovery controller.

## Analysis and limits

The report contains case/repeat outcomes, source/skill identities, observed provider
identity, retained baseline successes, false alarms, inconclusives, A/A disagreement,
injected-regression detection, all proposal/worker usage, wall time and process CPU.
P95 is unknown below 100 samples. A family-paired bounded Hoeffding interval is
reported under its stated independent-family assumption; repeats do not manufacture
new families. This tiny curated final set does not meet the declared minimum
family evidence and cannot establish generalizable benefit. No Wilson interval
or tiny A/A fixture is presented as adaptive-validity proof.

OpenAI token usage priced at a frozen tariff is **metered list-price**, not a
reconciled provider invoice. `billedUsd` remains null unless separately attested;
unpriced local compute remains null. Unknown usage is never free. Provider-default
temperature/seed remain unresolved in the existing runtime and are recorded as a
qualification limitation. The artifact cannot be promoted automatically. Null or
inconclusive results retain the existing implementation.

See `control-result.json` for the refreshed zero-provider-cost controller smoke observation.
Its corpus/protocol digests supersede the invalidated helper-only lodash run.
It tests the measurement path, not model-backed efficacy. A paid provider pilot,
full billing reconciliation, adequately sampled independent final outcomes and
qualified retention/provenance remain required before closing the efficacy gate.
