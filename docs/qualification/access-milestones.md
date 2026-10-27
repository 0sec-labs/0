# Live access milestones

Live assessments, retained timelines and findings show host-observed access-control milestones. Operator-facing labels show the asset origin; paths, query strings, private markers and credentials are excluded from screenshot summaries. The evidence link opens the retained event in the assessment.

A confirmed unauthorized-read banner requires an operator-configured `accessControlFixtures` ownership contract, an exact URL/owner/marker match, distinct credentials, successful complete owner/comparison responses and retrieval of the private marker by a configured comparison identity. Model-supplied `expect_denied` or ownership assertions cannot create this banner. Read proofs retain status, completeness, marker-presence and response digests without retaining private response bodies. They establish the configured ownership contract, not arbitrary privilege beyond that resource.

A blocked-read milestone requires denial of every comparison identity in that fixture. A later confirmed read replaces the blocked banner; reconnect/polling replays do not duplicate or downgrade it. Read-only proofs show that cleanup was not required.

Cross-identity state transitions remain conditional because different credentials alone do not establish that a write was unauthorized. Their cleanup remains explicitly unknown unless separately verified. RCE, shell, credential foothold and lateral movement are not inferred from finding text, severity, HTTP success or model claims; dedicated host verification contracts are required before adding those milestone classes.

Regression coverage lives in `packages/shared/src/access-milestone.test.ts`, `packages/core/src/agent/tools/access-control.workflow.test.ts` and `packages/cli/test/web/access-milestone.test.ts`.

## Disposable state and cleanup evidence

An ownership fixture can explicitly declare a restricted disposable resource's state field:

```json
{
  "url": "https://authorized.example/disposable-state",
  "ownerIdentity": "owner",
  "comparisonIdentities": ["comparison"],
  "ownershipMarker": "FRESH_PRIVATE_SYNTHETIC_MARKER",
  "stateChange": {
    "disposable": true,
    "jsonPointer": "/marker",
    "stepUrls": ["https://authorized.example/disposable-state"]
  }
}
```

This is an operator-owned restriction, not an assertion the model can supply. Configure it in the existing `--access-control-fixtures` file alongside named identities. It grants no target scope or mutation authority. A confirmed write additionally requires complete owner observations, distinct authentication, the configured placeholder in an allowed actor request body, replaced by a fresh host-issued challenge before dispatch, a matching observed postcondition, and completed bounded requests at only the declared URLs. Generic transitions stay conditional. Truncated, redacted and unsupported marker observations cannot establish this proof.

The host retains a digest of the observed pre-proof field, a proof identity and lifecycle revisions. After separately authorized restoration, `access_control_cleanup` sends only an owner GET and compares that field against the retained digest. It accepts no caller-supplied baseline. Missing evidence, denied reads, transport failures and truncation leave cleanup unverified. A nonmatching complete observation reports that the field was not restored. A matching observation updates the original proof's cleanup status and evidence links, including after executor restart; it never downgrades the confirmed write or erases the original proof. Recovery queries filter producer/assessment before loading at most 500 receipts.

Cleanup verification covers the declared field only, not every possible side effect. The banner displays that limit, the verification and cleanup timestamps, access level, prerequisites, confidence and severity separately. New lower-impact notifications cannot evict the strongest retained summary, and duplicate/reordered lifecycle receipts cannot regress it.

No RCE, shell, credential foothold or lateral-movement claim is inferred from a category, model message, generic callback or successful HTTP status. Those labels need their own host evidence producers; this change completes the actual read/state-change/cleanup presentation rather than inventing such evidence.

The caller does not choose the proof challenge. The host replaces the operator marker placeholder in the approved body and compares the owner postcondition with a fresh unpredictable nonce disclosed only after verification. An unrelated model assertion or previously observed marker cannot manufacture that proof. Confidence describes the deterministic observation; business severity stays explicitly unassessed until separately established.

An HTTP denial/error code on an actor request is not itself proof that the state change was blocked: if the owner independently observes the fresh host challenge afterward, the observed field effect controls the milestone. Transport failures remain inconclusive.
