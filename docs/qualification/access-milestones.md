# Live access milestones

Live assessments, retained timelines and findings show host-observed access-control milestones. Operator-facing labels show the asset origin; paths, query strings, private markers and credentials are excluded from screenshot summaries. The evidence link opens the retained event in the assessment.

A confirmed unauthorized-read banner requires an operator-configured `accessControlFixtures` ownership contract, an exact URL/owner/marker match, distinct credentials, successful complete owner/comparison responses and retrieval of the private marker by a configured comparison identity. Model-supplied `expect_denied` or ownership assertions cannot create this banner. Read proofs retain status, completeness, marker-presence and response digests without retaining private response bodies. They establish the configured ownership contract, not arbitrary privilege beyond that resource.

A blocked-read milestone requires denial of every comparison identity in that fixture. A later confirmed read replaces the blocked banner; reconnect/polling replays do not duplicate or downgrade it. Read-only proofs show that cleanup was not required.

Cross-identity state transitions remain conditional because different credentials alone do not establish that a write was unauthorized. Their cleanup remains explicitly unknown unless separately verified. RCE, shell, credential foothold and lateral movement are not inferred from finding text, severity, HTTP success or model claims; dedicated host verification contracts are required before adding those milestone classes.

Regression coverage lives in `packages/shared/src/access-milestone.test.ts`, `packages/core/src/agent/tools/access-control.workflow.test.ts` and `packages/cli/test/web/access-milestone.test.ts`.
