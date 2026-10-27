# Issue 121: experimental development-summary ablation controller

This is experimental, opt-in controller infrastructure. It does not qualify a
model-backed ablation or close issue #121. Committed artifacts use only
deterministic controls and remain inconclusive. The earlier artifact based on
conflicting lodash source labels is superseded by the corrected #120 corpus.

This focused controller depends on the #120 study infrastructure. It executes the
same frozen-parent, width-one source-review optimization twice, varying only the
development-feedback representation. One arm receives the current pilot's bounded
observed finding/outcome receipts; the other uses the existing
`DevelopmentSummaryCache`. Neither arm changes production prompts or enables
summary analysis during ordinary scans.

Both arms use the same advisory-backed family split, source bytes, baseline skill,
production proposer, editable skill surface, one-proposal count, per-call ceiling,
execution cap and total campaign allocation. Each independently reserves the
complete final-validation capacity. The shared preregistration includes both
allocations and hashes the summary driver and loaded summary implementation.
Equal **maximum budget allocations** are enforced; actual token charges and
latencies are reported separately and are not asserted to be identical.

The compact transform admits explicitly tagged development observations only.
No held-out/negative-control traces or case decisions are summarized. A trusted
oracle miss on an independently labelled development positive can reference its
verifier receipt; an unsupported causal explanation remains unknown. Successful
development behavior is retained. The existing summary enforces observation,
case, example, byte, conservative token and cache limits. Raw findings, private
case identities and full text traces never enter its prompt projection. The
summarizer makes zero model calls. Model-assisted mining and proposal diversity
are outside this ablation.

## Reproduce without paid calls

First prepare and preregister the #120 corpus/protocol as documented in
`docs/qualification/security-evolution-study/README.md`, then:

```sh
node scripts/run-security-evolution-summary-study.mjs preregister --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --output /tmp/summary-preregistration.json
node scripts/run-security-evolution-summary-study.mjs controls --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --preregistration /tmp/summary-preregistration.json --output /tmp/summary-controls.json
node scripts/run-security-evolution-summary-study.mjs controls --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --preregistration /tmp/summary-preregistration.json --output /tmp/summary-unknown-usage.json --unknown-usage-at 1
node --test scripts/security-evolution-study.test.mjs scripts/security-evolution-summary-study.test.mjs
```

The executed real-corpus control experiment in `control-result.json` completed
132 control calls per arm, with different raw/compact proposal contexts. Both
arms used the same deterministic source-pattern provider control, not a paid
model. It produced no observed paired quality difference, no A/A disagreement,
and detected the injected missed-detection regression. The family interval is
[-1, 1], and p95 is unknown because sample support is insufficient. The result
is **inconclusive for model-backed summary usefulness**; current feedback stays
selected. Measured control CPU/wall timing is not a deployed-model speed claim.

A second executed experiment injected unknown usage on the first call. The
shared accounting gate retained that reservation and stopped before constructing
or dispatching the compact arm. This is reported as unknown, never zero cost.

## Paid measurement remains gated

The `run` command additionally requires one approved shared cap covering both
arms and a qualified model-backed basic pilot with reconciled billing and
validated controls. A completed-but-inconclusive parent is rejected. The current
#120 controller always reports inconclusive, so none of its current reports can
unlock paid ablation; a separately reviewed qualification remains required. With the default base protocol the shared cap is $40, while
maximum declared dispatch reservations are $26.40. These are bounds, not an
observed dollar bill. The driver refuses to start provider arms without that
parent evidence and explicit cap. No paid calls were made for the committed
control result.

```sh
node scripts/run-security-evolution-summary-study.mjs run --corpus /tmp/study-corpus.json --protocol /tmp/study-protocol.json --preregistration /tmp/summary-preregistration.json --qualified-pilot-report /tmp/study-provider.json --approved-shared-budget-usd 40 --output /tmp/summary-provider.json
```

The report keeps per-arm quality/false alarms, retention, all search charges,
proposal tokens and end-to-end latency. Provider-metered tariff estimates remain
separate from invoice charges and unpriced local compute. Final case-level
results remain in the controller output, never proposer feedback or archives.
Do not call the deterministic null result a measured absence of model benefit.
The research efficacy acceptance remains open until the qualified finite paid
ablation resolves benefit or records an adequately supported negative/inconclusive
result under the declared protocol.
